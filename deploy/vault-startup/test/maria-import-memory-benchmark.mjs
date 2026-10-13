import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildBenchmarkFixtures,
  PDF_LIMITS,
} from "./maria-import-memory-fixtures.mjs";

const MEMORY_CAP_BYTES = 536_870_912;
const REGISTRATION_CALLS = 4;
const FINANCIAL_TABLES = [
  "expenses",
  "cash_flow_entries",
  "receipts",
  "rateio_allocations",
  "cross_project_settlements",
  "imported_invoice_liquidations",
];
const METRIC_LABELS = new Set([
  "pdf-max-c1",
  "pdf-max-c2",
  "upload-max-c1",
  "upload-max-c2",
  "upload-max-c4",
]);
const METRIC_FIELDS = [
  "label",
  "concurrency",
  "input_bytes",
  "page_count",
  "operator_count",
  "text_output_bytes",
  "registration_calls",
  "overlap_count",
  "analysis_calls",
  "distinct_tenant_count",
  "distinct_user_count",
  "financial_expense_count",
  "financial_cash_flow_count",
  "financial_receipt_count",
  "financial_allocation_count",
  "financial_settlement_count",
  "financial_liquidation_count",
  "cgroup_version",
  "private_cgroup_namespace",
  "host_ancestor_count",
  "memory_limit_bytes",
  "swap_limit_bytes",
  "baseline_swap_current_bytes",
  "final_swap_current_bytes",
  "baseline_vm_hwm_bytes",
  "final_vm_hwm_bytes",
  "baseline_memory_current_bytes",
  "baseline_memory_peak_bytes",
  "final_memory_current_bytes",
  "final_memory_peak_bytes",
  "oom_event_delta",
  "oom_kill_delta",
  "status_code",
];
const ACTIVE_CONTAINERS = new Set();
let diagnosticStage = "initialization";
const POSITIVE_METRIC_FIELDS = [
  "concurrency",
  "input_bytes",
  "memory_limit_bytes",
  "baseline_vm_hwm_bytes",
  "final_vm_hwm_bytes",
  "baseline_memory_current_bytes",
  "baseline_memory_peak_bytes",
  "final_memory_current_bytes",
  "final_memory_peak_bytes",
];

function markStage(stage) {
  diagnosticStage = stage;
}

const SQLITE_CLONE_SCRIPT = String.raw`
import json, sqlite3, sys
try:
    request = json.load(sys.stdin)
    source = sqlite3.connect("file:" + request["source"] + "?mode=ro", uri=True, timeout=3)
    destination = sqlite3.connect(request["destination"], timeout=3)
    source.backup(destination)
    destination.execute("PRAGMA foreign_keys=ON")
    integrity = destination.execute("PRAGMA integrity_check").fetchone()
    foreign_keys = destination.execute("PRAGMA foreign_key_check").fetchall()
    destination.close()
    source.close()
    if integrity != ("ok",) or foreign_keys:
        raise RuntimeError("synthetic clone failed integrity checks")
    print("OK")
except Exception:
    sys.exit(2)
`;

const SQLITE_OBSERVER_SCRIPT = String.raw`
import json, sqlite3, sys, urllib.parse
TABLES = (
    "expenses",
    "cash_flow_entries",
    "receipts",
    "rateio_allocations",
    "cross_project_settlements",
    "imported_invoice_liquidations",
)
try:
    request = json.load(sys.stdin)
    uri = "file:" + urllib.parse.quote(request["database"], safe="/") + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=2)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA foreign_keys=ON")
    if connection.execute("PRAGMA foreign_keys").fetchone() != (1,):
        raise RuntimeError("foreign keys are not enabled")
    tenants = request["tenantIds"]
    marks = ",".join("?" for _ in tenants)
    upload = connection.execute(
        "SELECT COUNT(*), COUNT(DISTINCT tenant_id) "
        "FROM import_session_artifacts "
        "WHERE state='RESERVED' AND upload_generation=2 "
        "AND tenant_id IN (" + marks + ")",
        tenants,
    ).fetchone()
    upload_users = connection.execute(
          "SELECT COUNT(DISTINCT s.owner_user_id) "
          "FROM import_session_artifacts a "
          "JOIN import_sessions s ON s.tenant_id=a.tenant_id "
          "AND s.owner_project_id=a.owner_project_id AND s.id=a.session_id "
          "WHERE a.state='RESERVED' AND a.upload_generation=2 "
          "AND a.tenant_id IN (" + marks + ")",
          tenants,
    ).fetchone()[0]
    analyzing = connection.execute(
        "SELECT COUNT(*), COUNT(DISTINCT tenant_id) "
        "FROM import_artifacts WHERE state='ANALYZING' "
        "AND tenant_id IN (" + marks + ")",
        tenants,
    ).fetchone()
    analyzing_users = connection.execute(
          "SELECT COUNT(DISTINCT s.owner_user_id) "
          "FROM import_artifacts a "
          "JOIN import_session_artifacts r ON r.tenant_id=a.tenant_id "
          "AND r.owner_project_id=a.owner_project_id AND r.artifact_id=a.id "
          "JOIN import_sessions s ON s.tenant_id=r.tenant_id "
          "AND s.owner_project_id=r.owner_project_id AND s.id=r.session_id "
          "WHERE a.state='ANALYZING' AND a.tenant_id IN (" + marks + ")",
          tenants,
    ).fetchone()[0]
    finances = [
        connection.execute(
            "SELECT COUNT(*) FROM " + table + " WHERE tenant_id IN (" + marks + ")",
            tenants,
        ).fetchone()[0]
        for table in TABLES
    ]
    observations = connection.execute(
          "SELECT COUNT(*) FROM import_observations WHERE tenant_id IN (" + marks + ")",
          tenants,
    ).fetchone()[0]
    connection.close()
    print(json.dumps({
        "uploadCount": upload[0],
        "uploadTenantCount": upload[1],
        "uploadUserCount": upload_users,
        "analyzingCount": analyzing[0],
        "analyzingTenantCount": analyzing[1],
        "analyzingUserCount": analyzing_users,
        "financialCounts": finances,
        "observationCount": observations,
    }, separators=(",", ":")))
except Exception:
    sys.exit(2)
`;

const LIVE_MEMORY_PROBE = String.raw`
set -eu
pid1_node=0
while IFS= read -r value; do
  if [ "$value" = "node" ]; then pid1_node=1; fi
done < /proc/1/comm
[ "$pid1_node" -eq 1 ] || exit 21
cgroup_root=0
while IFS=: read -r hierarchy controllers cgroup_path; do
  if [ "$hierarchy" = "0" ] && [ -z "$controllers" ] && [ "$cgroup_path" = "/" ]; then cgroup_root=1; fi
done < /proc/1/cgroup
[ "$cgroup_root" -eq 1 ] || exit 22
cgroup_mount=0
while read -r device mountpoint filesystem options rest; do
  if [ "$filesystem" = "cgroup2" ] && [ "$mountpoint" = "/sys/fs/cgroup" ]; then cgroup_mount=1; fi
done < /proc/mounts
[ "$cgroup_mount" -eq 1 ] || exit 23
vmhwm_kb=
while read -r key value unit rest; do
  if [ "$key" = "VmHWM:" ]; then
    [ "$unit" = "kB" ] || exit 24
    vmhwm_kb=$value
  fi
done < /proc/1/status
case "$vmhwm_kb" in ''|*[!0-9]*) exit 25 ;; esac
[ "$vmhwm_kb" -gt 0 ] || exit 26
for metric in memory.max memory.swap.max memory.swap.current memory.current memory.peak; do
  [ -r "/sys/fs/cgroup/$metric" ] || exit 27
  IFS= read -r value < "/sys/fs/cgroup/$metric"
  case "$value" in ''|*[!0-9]*) exit 28 ;; esac
  printf '%s=%s\n' "$metric" "$value"
done
oom= oom_kill=
while read -r key value rest; do
  case "$key" in
    oom) oom=$value ;;
    oom_kill) oom_kill=$value ;;
  esac
done < /sys/fs/cgroup/memory.events
case "$oom:$oom_kill" in *[!0-9:]*) exit 29 ;; esac
[ -n "$oom" ] && [ -n "$oom_kill" ] || exit 30
printf 'pid1_node=1\npid1_cgroup_root=1\ncgroup2_mount=1\nvmhwm_kb=%s\nevent_oom=%s\nevent_oom_kill=%s\n' "$vmhwm_kb" "$oom" "$oom_kill"
`;

function safeInteger(value, label) {
  assert.ok(
    Number.isSafeInteger(value) && value >= 0,
    `invalid ${label} sample`,
  );
  return value;
}

export function parseVmHwmBytes(statusText) {
  assert.equal(typeof statusText, "string");
  const match = /^VmHWM:\s+([0-9]+)\s+kB\s*$/m.exec(statusText);
  assert.ok(match, "VmHWM sample is missing or malformed");
  const kibibytes = Number(match[1]);
  assert.ok(
    Number.isSafeInteger(kibibytes) && kibibytes > 0,
    "VmHWM sample is invalid",
  );
  const bytes = kibibytes * 1024;
  assert.ok(
    Number.isSafeInteger(bytes) && bytes > 0,
    "VmHWM sample is invalid",
  );
  return bytes;
}

export function verifyCgroupV2Proof(evidence) {
  assert.equal(evidence?.cgroupVersion, 2, "cgroup v2 is required");
  assert.equal(
    evidence?.cgroupNamespaceMode,
    "private",
    "private cgroup namespace is required",
  );
  assert.equal(
    evidence?.pid1CgroupPath,
    "/",
    "PID 1 must be at the cgroup namespace root",
  );
  assert.equal(
    evidence?.dockerMemoryBytes,
    MEMORY_CAP_BYTES,
    "Docker memory cap is not exact",
  );
  assert.equal(
    evidence?.dockerMemorySwapBytes,
    MEMORY_CAP_BYTES,
    "Docker memory plus swap cap is not exact",
  );
  assert.equal(
    evidence?.memoryMaxBytes,
    MEMORY_CAP_BYTES,
    "cgroup leaf memory cap is not exact",
  );
  assert.equal(evidence?.memorySwapMaxBytes, 0, "swap must be disabled");
  const swapCurrentBytes = safeInteger(
    evidence?.memorySwapCurrentBytes,
    "cgroup swap current",
  );
  assert.equal(swapCurrentBytes, 0, "swap is in use");
  const currentBytes = safeInteger(
    evidence.memoryCurrentBytes,
    "cgroup current",
  );
  const peakBytes = safeInteger(evidence.memoryPeakBytes, "cgroup peak");
  assert.ok(
    currentBytes > 0 && peakBytes > 0,
    "cgroup samples must be positive",
  );
  assert.ok(peakBytes >= currentBytes, "cgroup peak is below current memory");
  assert.ok(
    Array.isArray(evidence.ancestorMemoryMaxBytes),
    "host cgroup ancestors were not inspected",
  );
  assert.equal(
    evidence.hostCgroupLeafMemoryMaxBytes,
    MEMORY_CAP_BYTES,
    "host cgroup leaf does not match the container cap",
  );
  for (const ancestorLimit of evidence.ancestorMemoryMaxBytes) {
    if (ancestorLimit === null) continue;
    assert.ok(
      Number.isSafeInteger(ancestorLimit) && ancestorLimit >= MEMORY_CAP_BYTES,
      "a host cgroup ancestor has a tighter or invalid memory limit",
    );
  }
  return {
    cgroupVersion: 2,
    privateCgroupNamespace: 1,
    memoryLimitBytes: MEMORY_CAP_BYTES,
    swapLimitBytes: 0,
    swapCurrentBytes,
    currentBytes,
    peakBytes,
    ancestorCount: evidence.ancestorMemoryMaxBytes.length,
  };
}

export function serializeMetrics(rows, registrationCalls = REGISTRATION_CALLS) {
  assert.equal(
    registrationCalls,
    REGISTRATION_CALLS,
    "unexpected signup count",
  );
  assert.ok(
    Array.isArray(rows) && rows.length > 0 && rows.length <= METRIC_LABELS.size,
  );
  const labels = new Set();
  const safeRows = rows.map((row) => {
    assert.ok(METRIC_LABELS.has(row?.label), "unexpected benchmark scenario");
    assert.ok(!labels.has(row.label), "duplicate benchmark scenario");
    labels.add(row.label);
    const safe = Object.fromEntries(
      METRIC_FIELDS.map((field) => [field, row[field]]),
    );
    for (const field of METRIC_FIELDS.slice(1)) safeInteger(safe[field], field);
    for (const field of POSITIVE_METRIC_FIELDS)
      assert.ok(safe[field] > 0, `missing positive ${field} sample`);
    assert.equal(safe.memory_limit_bytes, MEMORY_CAP_BYTES);
    assert.equal(safe.swap_limit_bytes, 0);
    assert.equal(safe.cgroup_version, 2);
    assert.equal(safe.private_cgroup_namespace, 1);
    assert.ok(safe.host_ancestor_count > 0);
    assert.equal(safe.baseline_swap_current_bytes, 0);
    assert.equal(safe.final_swap_current_bytes, 0);
    assert.equal(
      safe.status_code,
      0,
      "failed benchmark row cannot be successful",
    );
    assert.equal(safe.oom_event_delta, 0, "benchmark recorded an OOM event");
    assert.equal(safe.oom_kill_delta, 0, "benchmark recorded an OOM kill");
    assert.equal(safe.overlap_count, safe.concurrency);
    assert.equal(safe.distinct_tenant_count, safe.concurrency);
    assert.equal(safe.distinct_user_count, safe.concurrency);
    assert.ok(
      safe.analysis_calls === 0 || safe.analysis_calls === safe.concurrency,
    );
    assert.ok(safe.final_memory_peak_bytes >= safe.baseline_memory_peak_bytes);
    for (const field of METRIC_FIELDS.filter((name) =>
      name.startsWith("financial_"),
    ))
      assert.equal(safe[field], 0, "benchmark must not create financial rows");
    return safe;
  });
  return {
    registration_calls: registrationCalls,
    rows: safeRows,
  };
}

function assertRunnerPaths() {
  assert.equal(process.platform, "linux", "benchmark requires a Linux runner");
  const runnerTemp = process.env.RUNNER_TEMP;
  const rootRaw = process.env.RF_MEMORY_BENCHMARK_ROOT;
  const outputRaw = process.env.RF_MEMORY_BENCHMARK_OUTPUT;
  const image = process.env.RF_MEMORY_BENCHMARK_IMAGE;
  assert.ok(
    runnerTemp && rootRaw && outputRaw && image,
    "benchmark runner configuration is incomplete",
  );
  const temp = realpathSync(runnerTemp);
  const root = resolve(rootRaw);
  const output = resolve(outputRaw);
  const relativeRoot = relative(temp, root);
  const relativeOutput = relative(temp, output);
  assert.ok(
    relativeRoot &&
      !relativeRoot.startsWith(`..${sep}`) &&
      relativeRoot !== "..",
  );
  assert.ok(
    relativeOutput &&
      !relativeOutput.startsWith(`..${sep}`) &&
      relativeOutput !== "..",
  );
  const outputFromRoot = relative(root, output);
  assert.ok(
    outputFromRoot === ".." ||
      outputFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(outputFromRoot),
    "metrics output must be outside the data mount",
  );
  assert.match(image, /^[A-Za-z0-9._:-]+$/);
  assert.ok(existsSync(root), "ext4 data mount is missing");
  const filesystemType = statfsSync(root).type;
  assert.equal(filesystemType, 0xef53, "benchmark data mount must be ext4");
  return { root, output, image };
}

function runDocker(args, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    input: options.input,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Docker operation failed: ${args[0]}`);
  return result.stdout.trim();
}

function runPython(script, input, label, timeout = 15_000) {
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    input: JSON.stringify(input),
    timeout,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`read-only synthetic database ${label} failed`);
  return result.stdout.trim();
}

function removeTree(path) {
  try {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  } catch {
    throw new Error("benchmark temporary data cleanup failed");
  }
}

function removeFile(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    throw new Error("benchmark artifact cleanup failed");
  }
}

function createDataDirectory(root, label) {
  const directory = join(root, label);
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, "import-vault", "t"), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(join(directory, "import-vault", "trash"), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(join(directory, "artifacts"), { mode: 0o700 });
  mkdirSync(join(directory, "uploads"), { mode: 0o700 });
  mkdirSync(join(directory, "public-uploads"), { mode: 0o700 });
  mkdirSync(join(directory, "private-uploads"), { mode: 0o700 });
  writeFileSync(join(directory, "import-vault", ".lock"), "", {
    mode: 0o600,
    flag: "wx",
  });
  chmodSync(join(directory, "import-vault"), 0o700);
  chmodSync(join(directory, "import-vault", "t"), 0o700);
  chmodSync(join(directory, "import-vault", "trash"), 0o700);
  return directory;
}

function runContainer(label, dataDirectory, image, secret, registerEnabled) {
  markStage(`container-start-${label}`);
  const name = `rfm-${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}-${label}-${randomBytes(3).toString("hex")}`;
  ACTIVE_CONTAINERS.add(name);
  const env = {
    NODE_ENV: "production",
    PORT: "3001",
    DATABASE_URL: "file:/data/benchmark.sqlite",
    JWT_SECRET: secret,
    AUTH_ENABLE_REGISTER: registerEnabled ? "1" : "0",
    CORS_ORIGIN: "http://localhost:3000",
    IMPORT_VAULT_ENABLED: "true",
    IMPORT_VAULT_LOCK_FD: "9",
    VAULT_DIR: "/data/import-vault",
    IMPORT_VAULT_IDLE_TIMEOUT_MS: "120000",
    IMPORT_VAULT_HEADROOM_BYTES: "1048576",
    IMPORT_VAULT_DRAIN_TIMEOUT_MS: "2000",
  };
  const envFile = join(dataDirectory, "benchmark.env");
  writeFileSync(
    envFile,
    `${Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { mode: 0o600, flag: "wx" },
  );
  try {
    runDocker([
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      "rf-maria-memory-benchmark=true",
      "--label",
      `rf-maria-memory-scenario=${label}`,
      "--cgroupns=private",
      "--memory=536870912",
      "--memory-swap=536870912",
      "--publish",
      "127.0.0.1::3001",
      "--mount",
      `type=bind,src=${dataDirectory},dst=/data`,
      "--env-file",
      envFile,
      image,
    ]);
  } finally {
    rmSync(envFile, { force: true });
  }
  const publication = runDocker(["port", name, "3001/tcp"]);
  const port = /:([0-9]+)\s*$/.exec(publication)?.[1];
  assert.ok(port, "API container did not publish its local port");
  return { name, dataDirectory, origin: `http://127.0.0.1:${port}` };
}

async function readJson(
  api,
  path,
  { method = "GET", body, token, ui = false, timeout = 30_000 } = {},
) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (ui) {
    headers.origin = "http://localhost:3000";
    headers["x-rf-import-ui"] = "1";
  }
  const response = await fetch(`${api.origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("API returned a non-JSON benchmark response");
  }
  return { status: response.status, payload };
}

function requireHttp(result, expectedStatus, label) {
  assert.equal(
    result.status,
    expectedStatus,
    `${label} returned an unexpected status`,
  );
  return result.payload;
}

async function waitReady(api, timeoutMs = 180_000) {
  markStage("api-readiness");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspect = JSON.parse(runDocker(["inspect", api.name]))[0];
    assert.equal(
      inspect.State.Running,
      true,
      "API container exited before readiness",
    );
    try {
      const response = await fetch(`${api.origin}/api/docs-json`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 200) return;
    } catch {
      await delay(250);
    }
  }
  throw new Error("API container did not become ready before timeout");
}

async function createSeedUsers(api, secret) {
  const users = [];
  const suffix = randomBytes(6).toString("hex");
  for (let index = 0; index < REGISTRATION_CALLS; index += 1) {
    markStage("synthetic-registration");
    const registration = readJson(api, "/auth/register", {
      method: "POST",
      body: {
        tenantName: `Synthetic memory benchmark tenant ${index + 1}`,
        ownerName: `Synthetic memory benchmark owner ${index + 1}`,
        email: `memory-${suffix}-${index + 1}@example.invalid`,
        username: `mem${suffix}${index + 1}`,
        password: `${randomBytes(24).toString("base64url")}A1!`,
        projectTypes: ["PESSOAL"],
      },
    });
    const registered = requireHttp(await registration, 201, "synthetic signup");
    assert.equal(typeof registered.token, "string");
    assert.ok(registered.token.length > 20);
    const user = registered.user;
    const headers = { token: registered.token };
    markStage("synthetic-project-creation");
    const project = requireHttp(
      await readJson(api, "/projects", {
        method: "POST",
        body: {
          name: `Synthetic memory benchmark ${index + 1}`,
          type: "PESSOAL",
        },
        ...headers,
      }),
      201,
      "synthetic PESSOAL project creation",
    );
    markStage("synthetic-card-creation");
    const card = requireHttp(
      await readJson(api, `/projects/${project.id}/credit-cards`, {
        method: "POST",
        body: {
          institution: "NUBANK",
          brand: "Visa",
          nickname: "Synthetic benchmark card",
          last4: String(index + 1).padStart(4, "0"),
          closingDay: 5,
          dueDay: 10,
          limitTotalCents: 100_000,
        },
        ...headers,
      }),
      201,
      "synthetic credit-card creation",
    );
    markStage("synthetic-session-creation");
    const session = requireHttp(
      await readJson(api, "/import-sessions", {
        method: "POST",
        body: {
          version: 1,
          createRequestId: randomUUID(),
          cardId: card.id,
          consentPolicyVersion: 1,
          consentAnalyze: true,
        },
        ui: true,
        ...headers,
      }),
      201,
      "synthetic documentary session creation",
    );
    const authenticated = requireHttp(
      await readJson(api, "/auth/me", { token: registered.token }),
      200,
      "synthetic seed authentication",
    );
    assert.ok(
      authenticated.id === user.id,
      "synthetic seed authentication identity mismatch",
    );
    users.push({
      userId: user.id,
      tenantId: user.tenantId,
      sessionId: session.id,
      revision: session.revision,
      token: registered.token,
    });
  }
  assert.equal(users.length, REGISTRATION_CALLS);
  assert.equal(secret.length >= 32, true);
  return users;
}

function cloneDatabase(source, destination) {
  runPython(SQLITE_CLONE_SCRIPT, { source, destination }, "clone");
}

async function verifyClonedUsers(api, users) {
  for (const user of users) {
    markStage("cloned-user-authentication");
    const response = requireHttp(
      await readJson(api, "/auth/me", { token: user.token }),
      200,
      "cloned synthetic authentication",
    );
    assert.ok(
      response.id === user.userId,
      "cloned synthetic authentication identity mismatch",
    );
  }
}

function dockerInspect(api) {
  return JSON.parse(runDocker(["inspect", api.name]))[0];
}

function readHostCgroupLimits(containerPid) {
  assert.ok(Number.isSafeInteger(containerPid) && containerPid > 0);
  assert.ok(
    existsSync("/sys/fs/cgroup/cgroup.controllers"),
    "host is not cgroup v2",
  );
  const cgroups = readFileSync(`/proc/${containerPid}/cgroup`, "utf8");
  const match = /^0::(.+)$/m.exec(cgroups);
  assert.ok(match, "container host cgroup path is missing");
  const root = realpathSync("/sys/fs/cgroup");
  const cgroupRelative = match[1].replace(/^\/+/, "");
  const leaf = realpathSync(resolve(root, cgroupRelative));
  assert.ok(
    leaf === root || leaf.startsWith(`${root}${sep}`),
    "container cgroup escaped host root",
  );
  const limits = [];
  let current = leaf;
  while (current === root || current.startsWith(`${root}${sep}`)) {
    const raw = readFileSync(join(current, "memory.max"), "utf8").trim();
    if (raw === "max") limits.push(null);
    else {
      assert.match(raw, /^[0-9]+$/);
      limits.push(Number(raw));
    }
    if (current === root) break;
    current = dirname(current);
  }
  assert.ok(
    limits.length > 0 && current === root,
    "host cgroup ancestors are incomplete",
  );
  assert.equal(
    limits[0],
    MEMORY_CAP_BYTES,
    "host cgroup leaf is not the exact memory cap",
  );
  return {
    leafLimitBytes: limits[0],
    ancestorMemoryMaxBytes: limits.slice(1),
  };
}

function parseProbeOutput(text) {
  const values = new Map();
  for (const line of text.trim().split("\n")) {
    const separator = line.indexOf("=");
    assert.ok(
      separator > 0,
      "container memory probe returned malformed output",
    );
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    assert.ok(
      !values.has(key),
      "container memory probe returned duplicate fields",
    );
    values.set(key, value);
  }
  const integer = (key) => {
    const value = values.get(key);
    assert.ok(
      value && /^[0-9]+$/.test(value),
      `container ${key} sample is missing`,
    );
    return Number(value);
  };
  assert.equal(integer("pid1_node"), 1);
  assert.equal(integer("pid1_cgroup_root"), 1);
  assert.equal(integer("cgroup2_mount"), 1);
  return {
    pid1CgroupPath: "/",
    vmHwmBytes: parseVmHwmBytes(`VmHWM: ${integer("vmhwm_kb")} kB\n`),
    memoryMaxBytes: integer("memory.max"),
    memorySwapMaxBytes: integer("memory.swap.max"),
    memorySwapCurrentBytes: integer("memory.swap.current"),
    memoryCurrentBytes: integer("memory.current"),
    memoryPeakBytes: integer("memory.peak"),
    oomEvents: integer("event_oom"),
    oomKillEvents: integer("event_oom_kill"),
  };
}

function sampleMemory(api) {
  markStage("live-cgroup-memory-sample");
  const inspect = dockerInspect(api);
  assert.equal(
    inspect.State.Running,
    true,
    "API must be alive during memory sampling",
  );
  assert.equal(inspect.State.OOMKilled, false, "API container was OOM-killed");
  assert.equal(inspect.HostConfig.Memory, MEMORY_CAP_BYTES);
  assert.equal(inspect.HostConfig.MemorySwap, MEMORY_CAP_BYTES);
  assert.equal(inspect.HostConfig.CgroupnsMode, "private");
  const inner = runDocker(["exec", api.name, "sh", "-c", LIVE_MEMORY_PROBE]);
  const probe = parseProbeOutput(inner);
  const hostCgroupLimits = readHostCgroupLimits(inspect.State.Pid);
  const proof = verifyCgroupV2Proof({
    cgroupVersion: 2,
    cgroupNamespaceMode: inspect.HostConfig.CgroupnsMode,
    pid1CgroupPath: probe.pid1CgroupPath,
    dockerMemoryBytes: inspect.HostConfig.Memory,
    dockerMemorySwapBytes: inspect.HostConfig.MemorySwap,
    memoryMaxBytes: probe.memoryMaxBytes,
    memorySwapMaxBytes: probe.memorySwapMaxBytes,
    memorySwapCurrentBytes: probe.memorySwapCurrentBytes,
    memoryCurrentBytes: probe.memoryCurrentBytes,
    memoryPeakBytes: probe.memoryPeakBytes,
    hostCgroupLeafMemoryMaxBytes: hostCgroupLimits.leafLimitBytes,
    ancestorMemoryMaxBytes: hostCgroupLimits.ancestorMemoryMaxBytes,
  });
  return {
    ...proof,
    vmHwmBytes: probe.vmHwmBytes,
    oomEvents: probe.oomEvents,
    oomKillEvents: probe.oomKillEvents,
  };
}

export function observeDatabase(database, users) {
  return JSON.parse(
    runPython(
      SQLITE_OBSERVER_SCRIPT,
      { database, tenantIds: users.map(({ tenantId }) => tenantId) },
      "read-only aggregate",
    ),
  );
}

async function waitForState(
  api,
  database,
  users,
  predicate,
  message,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assert.equal(
      dockerInspect(api).State.Running,
      true,
      "API exited during overlap proof",
    );
    const state = observeDatabase(database, users);
    if (predicate(state)) return state;
    await delay(25);
  }
  throw new Error(message);
}

function requireZeroFinancialCounts(state) {
  assert.deepEqual(state.financialCounts, [0, 0, 0, 0, 0, 0]);
  return state.financialCounts;
}

function temporaryBlobHasBytes(path) {
  try {
    return statSync(path).size > 0;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw new Error("temporary upload progress could not be measured");
  }
}

function createAttachmentRequest(
  user,
  bytes,
  fileName = "synthetic-memory.pdf",
) {
  return {
    id: randomUUID(),
    fileName,
    mime: "application/pdf",
    declaredBytes: typeof bytes === "number" ? bytes : bytes.length,
  };
}

async function reserveAttachment(api, user, attachment) {
  markStage("private-attachment-reservation");
  const view = requireHttp(
    await readJson(api, `/import-sessions/${user.sessionId}/attachments`, {
      method: "POST",
      body: {
        expectedRevision: user.revision,
        files: [attachment],
      },
      token: user.token,
      ui: true,
    }),
    200,
    "private attachment reservation",
  );
  user.revision = view.revision;
  return view;
}

function beginRawUpload(api, user, attachment, bytes) {
  markStage("private-content-put");
  const port = Number(new URL(api.origin).port);
  const requestPath = `/import-sessions/${user.sessionId}/attachments/${attachment.id}/content`;
  let settled = false;
  let responseResolve;
  let responseReject;
  const responsePromise = new Promise((resolvePromise, rejectPromise) => {
    responseResolve = resolvePromise;
    responseReject = rejectPromise;
  });
  void responsePromise.catch(() => {});
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    method: "PUT",
    path: requestPath,
    headers: {
      authorization: `Bearer ${user.token}`,
      origin: "http://localhost:3000",
      "x-rf-import-ui": "1",
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
    },
  });
  request.on("error", () => {
    if (!settled) {
      settled = true;
      responseReject(new Error("private upload request failed"));
    }
  });
  request.setTimeout(20_000, () =>
    request.destroy(new Error("private upload timed out")),
  );
  request.on("response", (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("error", () => {
      if (!settled) {
        settled = true;
        responseReject(new Error("private upload response failed"));
      }
    });
    response.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        responseResolve({
          status: response.statusCode ?? 0,
          payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
      } catch {
        responseReject(
          new Error("private upload returned a non-JSON response"),
        );
      }
    });
  });
  return {
    request,
    responsePromise,
    get settled() {
      return settled;
    },
    writeFirstChunk() {
      return new Promise((resolvePromise, rejectPromise) => {
        const first = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
        request.write(first, (error) => {
          if (error)
            rejectPromise(new Error("private upload first chunk failed"));
          else resolvePromise(first.length);
        });
      });
    },
    finishAfterFirstChunk() {
      const firstLength = Math.min(bytes.length, 64 * 1024);
      request.end(bytes.subarray(firstLength));
    },
    sendAll() {
      request.end(bytes);
    },
    abort() {
      request.destroy();
    },
  };
}

async function uploadAndAnalyze(
  api,
  user,
  bytes,
  fileName = "synthetic-memory.pdf",
) {
  const attachment = createAttachmentRequest(user, bytes, fileName);
  await reserveAttachment(api, user, attachment);
  const upload = beginRawUpload(api, user, attachment, bytes);
  upload.sendAll();
  const uploaded = requireHttp(
    await upload.responsePromise,
    200,
    "private upload",
  );
  if (uploaded.kind === "DEDUPLICATED")
    throw new Error("unexpected duplicate synthetic upload");
  user.revision = uploaded.revision;
  const analyzed = requireHttp(
    await readJson(
      api,
      `/import-sessions/${user.sessionId}/attachments/${attachment.id}/analyze`,
      {
        method: "POST",
        body: { expectedRevision: user.revision },
        token: user.token,
        ui: true,
        timeout: 90_000,
      },
    ),
    200,
    "private PDF analysis",
  );
  user.revision = analyzed.revision;
  return analyzed;
}

function createMetricRow(
  label,
  concurrency,
  inputBytes,
  stats,
  baseline,
  final,
  overlapCount,
  financialCounts,
  distinctTenantCount = concurrency,
  distinctUserCount = concurrency,
  analysisCalls = concurrency,
) {
  assert.deepEqual(financialCounts, [0, 0, 0, 0, 0, 0]);
  assert.equal(final.oomEvents - baseline.oomEvents, 0);
  assert.equal(final.oomKillEvents - baseline.oomKillEvents, 0);
  return {
    label,
    concurrency,
    input_bytes: inputBytes,
    page_count: stats.pages,
    operator_count: stats.operatorsOnBoundaryPage,
    text_output_bytes: stats.outputUtf8Bytes,
    registration_calls: REGISTRATION_CALLS,
    overlap_count: overlapCount,
    analysis_calls: analysisCalls,
    distinct_tenant_count: distinctTenantCount,
    distinct_user_count: distinctUserCount,
    financial_expense_count: financialCounts[0],
    financial_cash_flow_count: financialCounts[1],
    financial_receipt_count: financialCounts[2],
    financial_allocation_count: financialCounts[3],
    financial_settlement_count: financialCounts[4],
    financial_liquidation_count: financialCounts[5],
    cgroup_version: baseline.cgroupVersion,
    private_cgroup_namespace: baseline.privateCgroupNamespace,
    host_ancestor_count: baseline.ancestorCount,
    memory_limit_bytes: MEMORY_CAP_BYTES,
    swap_limit_bytes: 0,
    baseline_swap_current_bytes: baseline.swapCurrentBytes,
    final_swap_current_bytes: final.swapCurrentBytes,
    baseline_vm_hwm_bytes: baseline.vmHwmBytes,
    final_vm_hwm_bytes: final.vmHwmBytes,
    baseline_memory_current_bytes: baseline.currentBytes,
    baseline_memory_peak_bytes: baseline.peakBytes,
    final_memory_current_bytes: final.currentBytes,
    final_memory_peak_bytes: final.peakBytes,
    oom_event_delta: final.oomEvents - baseline.oomEvents,
    oom_kill_delta: final.oomKillEvents - baseline.oomKillEvents,
    status_code: 0,
  };
}

async function withMeasuredContainer(
  { root, image, secret, label, users, seedDatabase },
  work,
) {
  const dataDirectory = createDataDirectory(root, `data-${label}`);
  const database = join(dataDirectory, "benchmark.sqlite");
  const scenarioUsers = users.map((user) => ({ ...user }));
  let api;
  try {
    markStage("sqlite-backup-clone");
    cloneDatabase(seedDatabase, database);
    markStage("measured-container-start");
    api = runContainer(label, dataDirectory, image, secret, false);
    await waitReady(api);
    await verifyClonedUsers(api, scenarioUsers);
    markStage("memory-baseline");
    const baseline = sampleMemory(api);
    markStage("measured-workload");
    const result = await work({
      api,
      dataDirectory,
      database,
      baseline,
      users: scenarioUsers,
    });
    markStage("memory-final-sample");
    const final = sampleMemory(api);
    assert.equal(
      dockerInspect(api).State.Running,
      true,
      "API must remain alive after workload",
    );
    return { ...result, baseline, final, apiAliveAtFinalSample: true };
  } finally {
    if (api) {
      const inspection = dockerInspect(api);
      if (inspection.State.Running)
        runDocker(["stop", "--time", "10", api.name]);
      runDocker(["rm", "--force", api.name]);
      ACTIVE_CONTAINERS.delete(api.name);
    }
    removeTree(dataDirectory);
  }
}

async function runUploadRung({
  root,
  image,
  secret,
  users,
  seedDatabase,
  concurrency,
  fixture,
}) {
  const label = `upload-max-c${concurrency}`;
  return withMeasuredContainer(
    {
      root,
      image,
      secret,
      label,
      users,
      seedDatabase,
    },
    async ({ api, dataDirectory, database, users: selectedUsers }) => {
      selectedUsers = selectedUsers.slice(0, concurrency);
      const attachments = [];
      markStage("upload-reservation");
      for (const user of selectedUsers) {
        const attachment = createAttachmentRequest(user, fixture.bytes);
        await reserveAttachment(api, user, attachment);
        attachments.push(attachment);
      }
      const uploads = selectedUsers.map((user, index) =>
        beginRawUpload(api, user, attachments[index], fixture.bytes),
      );
      try {
        markStage("upload-overlap-first-chunk");
        const firstChunks = await Promise.all(
          uploads.map((upload) => upload.writeFirstChunk()),
        );
        assert.ok(firstChunks.every((size) => size > 0));
        const state = await waitForState(
          api,
          database,
          selectedUsers,
          (current) =>
            current.uploadCount === concurrency &&
            current.uploadTenantCount === concurrency &&
            current.uploadUserCount === concurrency &&
            attachments.every((attachment, index) => {
              const blob = join(
                dataDirectory,
                "import-vault",
                "t",
                attachment.id,
                "g2",
                "blob",
              );
              markStage("upload-overlap-verified");
              return temporaryBlobHasBytes(blob) && !uploads[index].settled;
            }),
          "real server-side upload overlap was not observed",
        );
        assert.equal(state.uploadCount, concurrency);
        assert.equal(state.uploadTenantCount, concurrency);
        assert.equal(state.uploadUserCount, concurrency);
        assert.equal(
          uploads.filter((upload) => !upload.settled).length,
          concurrency,
        );
        for (const upload of uploads) upload.finishAfterFirstChunk();
        markStage("upload-stream-completion");
        const responses = await Promise.all(
          uploads.map((upload) => upload.responsePromise),
        );
        assert.deepEqual(
          responses.map(({ status }) => status),
          Array(concurrency).fill(200),
        );
        assert.equal(
          responses.some(({ payload }) => payload?.kind === "DEDUPLICATED"),
          false,
        );
        const after = observeDatabase(database, selectedUsers);
        const financialCounts = requireZeroFinancialCounts(after);
        assert.equal(after.analyzingCount, 0);
        assert.equal(after.observationCount, 0);
        return {
          overlapCount: state.uploadCount,
          distinctTenantCount: state.uploadTenantCount,
          distinctUserCount: state.uploadUserCount,
          financialCounts,
          stats: fixture.stats,
          inputBytes: fixture.bytes.length * concurrency,
        };
      } finally {
        for (const upload of uploads) {
          if (!upload.settled) upload.abort();
        }
      }
    },
  ).then(({ baseline, final, apiAliveAtFinalSample, ...result }) =>
    createMetricRow(
      label,
      concurrency,
      result.inputBytes,
      result.stats,
      baseline,
      final,
      result.overlapCount,
      result.financialCounts,
      result.distinctTenantCount,
      result.distinctUserCount,
      0,
    ),
  );
}

async function runPdfRung({
  root,
  image,
  secret,
  users,
  seedDatabase,
  concurrency,
  fixture,
}) {
  const label = `pdf-max-c${concurrency}`;
  return withMeasuredContainer(
    {
      root,
      image,
      secret,
      label,
      users,
      seedDatabase,
    },
    async ({ api, database, users: selectedUsers }) => {
      selectedUsers = selectedUsers.slice(0, concurrency);
      const attachments = [];
      markStage("pdf-reservation-and-upload");
      for (const user of selectedUsers) {
        const attachment = createAttachmentRequest(user, fixture.bytes);
        await reserveAttachment(api, user, attachment);
        attachments.push(attachment);
        const uploaded = beginRawUpload(api, user, attachment, fixture.bytes);
        uploaded.sendAll();
        const response = requireHttp(
          await uploaded.responsePromise,
          200,
          "private PDF upload",
        );
        if (response.kind === "DEDUPLICATED")
          throw new Error("unexpected duplicate synthetic PDF");
        user.revision = response.revision;
      }

      const analyses = selectedUsers.map((user, index) => {
        markStage("pdf-analysis-request");
        const pending = readJson(
          api,
          `/import-sessions/${user.sessionId}/attachments/${attachments[index].id}/analyze`,
          {
            method: "POST",
            body: { expectedRevision: user.revision },
            token: user.token,
            ui: true,
            timeout: 90_000,
          },
        ).then(
          (response) => ({ ok: true, response }),
          () => ({ ok: false }),
        );
        return pending;
      });
      markStage("pdf-parser-overlap-proof");
      const overlap = await waitForState(
        api,
        database,
        selectedUsers,
        (state) =>
          state.analyzingCount === concurrency &&
          state.analyzingTenantCount === concurrency &&
          state.analyzingUserCount === concurrency,
        "real server-side PDF parser overlap was not observed",
        30_000,
      );
      markStage("pdf-analysis-results");
      assert.equal(overlap.analyzingCount, concurrency);
      assert.equal(overlap.analyzingUserCount, concurrency);
      const settled = await Promise.all(analyses);
      assert.equal(
        settled.every(({ ok }) => ok),
        true,
        "PDF analysis request failed",
      );
      const views = settled.map(({ response }) =>
        requireHttp(response, 200, "private PDF analysis"),
      );
      for (const view of views) {
        assert.equal(view.lines.length, 1);
        assert.equal(view.selectedLineIds.length, 0);
        assert.equal(view.confirmation, null);
        assert.equal(view.receipt, null);
      }
      const state = observeDatabase(database, selectedUsers);
      const financialCounts = requireZeroFinancialCounts(state);
      assert.equal(state.observationCount, concurrency);
      return {
        overlapCount: overlap.analyzingTenantCount,
        distinctTenantCount: overlap.analyzingTenantCount,
        distinctUserCount: overlap.analyzingUserCount,
        financialCounts,
        stats: fixture.stats,
        inputBytes: fixture.bytes.length * concurrency,
      };
    },
  ).then(({ baseline, final, apiAliveAtFinalSample, ...result }) => {
    assert.equal(apiAliveAtFinalSample, true);
    return createMetricRow(
      label,
      concurrency,
      result.inputBytes,
      result.stats,
      baseline,
      final,
      result.overlapCount,
      result.financialCounts,
      result.distinctTenantCount,
      result.distinctUserCount,
    );
  });
}

async function runBoundaryChecks({
  root,
  image,
  secret,
  users,
  seedDatabase,
  fixtures,
}) {
  const label = "pdf-boundary-contracts";
  await withMeasuredContainer(
    { root, image, secret, label, users, seedDatabase },
    async ({ api, database, users: scenarioUsers }) => {
      markStage("near-file-limit-success");
      const nearView = await uploadAndAnalyze(
        api,
        scenarioUsers[0],
        fixtures.nearSize.bytes,
        "synthetic-near-limit.pdf",
      );
      assert.equal(nearView.lines.length, 1);

      const overFile = createAttachmentRequest(
        scenarioUsers[1],
        PDF_LIMITS.fileBytes + 1,
        "synthetic-file-over.pdf",
      );
      markStage("file-size-limit-rejection");
      const fileResult = await readJson(
        api,
        `/import-sessions/${scenarioUsers[1].sessionId}/attachments`,
        {
          method: "POST",
          body: {
            expectedRevision: scenarioUsers[1].revision,
            files: [overFile],
          },
          token: scenarioUsers[1].token,
          ui: true,
        },
      );
      assert.equal(fileResult.payload?.code, "LIMIT_EXCEEDED");

      markStage("page-limit-rejection");
      const pageResult = await uploadAndExpectLimit(
        api,
        scenarioUsers[1],
        fixtures.pagesOver.bytes,
        "synthetic-pages-over.pdf",
      );
      assert.equal(pageResult.problemCode, "LIMIT_EXCEEDED");

      for (const [user, fixture] of [
        [scenarioUsers[2], fixtures.operatorsOver],
        [scenarioUsers[3], fixtures.textOver],
      ]) {
        markStage(
          fixture === fixtures.operatorsOver
            ? "operator-limit-rejection"
            : "text-limit-rejection",
        );
        const response = await uploadAndExpectLimit(api, user, fixture.bytes);
        assert.equal(response.problemCode, "LIMIT_EXCEEDED");
      }
      assert.equal(dockerInspect(api).State.Running, true);
      requireZeroFinancialCounts(observeDatabase(database, scenarioUsers));
      const rejectedState = observeDatabase(database, scenarioUsers.slice(1));
      assert.equal(rejectedState.observationCount, 0);
      return {};
    },
  );
}

async function uploadAndExpectLimit(
  api,
  user,
  bytes,
  fileName = "synthetic-over-limit.pdf",
) {
  const attachment = createAttachmentRequest(user, bytes, fileName);
  await reserveAttachment(api, user, attachment);
  const upload = beginRawUpload(api, user, attachment, bytes);
  upload.sendAll();
  const uploaded = requireHttp(
    await upload.responsePromise,
    200,
    "boundary PDF upload",
  );
  assert.notEqual(uploaded.kind, "DEDUPLICATED");
  user.revision = uploaded.revision;
  return analyzeExpectedLimit(api, user, attachment);
}

async function analyzeExpectedLimit(api, user, attachment) {
  const result = await readJson(
    api,
    `/import-sessions/${user.sessionId}/attachments/${attachment.id}/analyze`,
    {
      method: "POST",
      body: { expectedRevision: user.revision },
      token: user.token,
      ui: true,
      timeout: 90_000,
    },
  );
  assert.equal(dockerInspect(api).State.Running, true);
  assert.equal(result.payload?.code, "LIMIT_EXCEEDED");
  return { problemCode: result.payload.code };
}

function cleanupContainers(containers) {
  for (const name of containers) {
    const existing = runDocker([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `name=^/${name}$`,
    ]);
    if (existing) runDocker(["rm", "--force", name]);
    ACTIVE_CONTAINERS.delete(name);
  }
}

export async function runBenchmark() {
  diagnosticStage = "initialization";
  let paths;
  try {
    paths = assertRunnerPaths();
  } catch {
    throw new Error("benchmark runner prerequisites could not be proven");
  }
  const { root, output, image } = paths;
  assert.ok(isAbsolute(output));
  assert.ok(
    process.env.RF_MEMORY_BENCHMARK_BASE_SHA,
    "base SHA is missing from workflow",
  );
  const secret = randomBytes(48).toString("hex");
  const temporaryDirectories = [];
  removeFile(output);
  let stage = "pdf-fixture-validation";
  diagnosticStage = "fixture-parser-boundary-validation";
  try {
    const fixtures = await buildBenchmarkFixtures();
    stage = "seed-api";
    markStage("seed-api-setup");
    const seedData = createDataDirectory(root, "data-seed");
    temporaryDirectories.push(seedData);
    const seedApi = runContainer("seed", seedData, image, secret, true);
    await waitReady(seedApi);
    const users = await createSeedUsers(seedApi, secret);
    assert.equal(users.length, REGISTRATION_CALLS);
    runDocker(["stop", "--time", "10", seedApi.name]);
    const seedDatabase = join(seedData, "benchmark.sqlite");

    const rows = [];
    stage = "pdf-max-c1";
    markStage(stage);
    rows.push(
      await runPdfRung({
        root,
        image,
        secret,
        users,
        seedDatabase,
        concurrency: 1,
        fixture: fixtures.maxAccepted,
      }),
    );
    stage = "pdf-boundary-contracts";
    markStage(stage);
    await runBoundaryChecks({
      root,
      image,
      secret,
      users,
      seedDatabase,
      fixtures,
    });
    stage = "pdf-max-c2";
    markStage(stage);
    rows.push(
      await runPdfRung({
        root,
        image,
        secret,
        users,
        seedDatabase,
        concurrency: 2,
        fixture: fixtures.maxAccepted,
      }),
    );
    for (const concurrency of [1, 2, 4]) {
      stage = `upload-max-c${concurrency}`;
      markStage(stage);
      const row = await runUploadRung({
        root,
        image,
        secret,
        users,
        seedDatabase,
        concurrency,
        fixture: fixtures.maxAccepted,
      });
      rows.push(row);
    }

    stage = "metrics-validation";
    markStage(stage);
    const report = serializeMetrics(rows);
    assert.deepEqual(
      report.rows.map(({ label }) => label),
      [
        "pdf-max-c1",
        "pdf-max-c2",
        "upload-max-c1",
        "upload-max-c2",
        "upload-max-c4",
      ],
    );
    stage = "benchmark-cleanup";
    markStage(stage);
    cleanupContainers([...ACTIVE_CONTAINERS]);
    for (const directory of temporaryDirectories) removeTree(directory);
    temporaryDirectories.length = 0;
    const outputDirectory = dirname(output);
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(output, `${JSON.stringify(report)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return report;
  } catch {
    removeFile(output);
    throw new Error(
      `benchmark failed during ${stage}/${diagnosticStage}; no complete metrics artifact was emitted`,
    );
  } finally {
    if (ACTIVE_CONTAINERS.size > 0) cleanupContainers([...ACTIVE_CONTAINERS]);
    for (const directory of temporaryDirectories) {
      removeTree(directory);
    }
  }
}
