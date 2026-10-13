import assert from "node:assert/strict";
import "./v749-compatibility.test.mjs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const guardModule = await import(
  process.env.VAULT_PRODUCTION_QA_GUARD_UNDER_TEST
    ? pathToFileURL(process.env.VAULT_PRODUCTION_QA_GUARD_UNDER_TEST).href
    : new URL("../production-qa-guard.mjs", import.meta.url).href
);
const { ProductionQaGuard, ProductionQaSupervisor } = guardModule;

const temporaryDirectories = [];
const GUARD_SOURCE = fileURLToPath(
  new URL("../production-qa-guard.mjs", import.meta.url),
);
const GUARD_LAUNCHER = fileURLToPath(
  new URL("../run-production-qa-guard.sh", import.meta.url),
);
const RELEASE = Object.freeze({
  releaseSha: "a".repeat(40),
  releaseId: "release-722",
  imageDigest: `sha256:${"b".repeat(64)}`,
  windowId: "vault-qa-window-722",
  windowStart: new Date(Date.now() - 60_000).toISOString(),
  windowEnd: new Date(Date.now() + 3_600_000).toISOString(),
  qaActor: "journey-qa-security",
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("production launcher pins the guard artifact, database, origin, and CLI surface", () => {
  const source = readFileSync(GUARD_SOURCE);
  const launcher = readFileSync(GUARD_LAUNCHER, "utf8");
  assert.match(
    launcher,
    new RegExp(
      `^readonly GUARD_SHA256='${createHash("sha256").update(source).digest("hex")}'$`,
      "m",
    ),
  );
  assert.match(
    launcher,
    /^readonly GUARD='\/app\/vault-production-qa-guard\.mjs'$/m,
  );
  assert.match(launcher, /^readonly DATABASE='\/data\/dev\.db'$/m);
  assert.match(launcher, /\[ "\$1" != 'run' \]/);
  assert.doesNotMatch(
    launcher,
    /DATABASE_URL|--database|--sql|--origin|\beval\b|\$\{@:|\$\*/,
  );
  assert.match(
    source.toString("utf8"),
    /const UPSTREAM_ORIGIN = "https:\/\/reformaflow-api\.fly\.dev"/,
  );
  assert.match(
    source.toString("utf8"),
    /const SQLITE_BINARY = "\/usr\/bin\/sqlite3"/,
  );
  assert.doesNotMatch(
    source.toString("utf8"),
    /export function (?:capture|compare)ProductionQaBaseline/,
  );

  for (const args of [[], ["capture"], ["run", "--origin", "http://evil"]]) {
    const result = spawnSync("sh", [GUARD_LAUNCHER, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 64);
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /\/data\/|\/app\/|reformaflow-api/,
    );
  }
});

function fixture() {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "rf-722-production-qa-"),
  );
  temporaryDirectories.push(directory);
  const database = join(directory, "fixture.db");
  const manifest = join(directory, "baseline.private.json");
  const trace = join(directory, "trace.private.json");
  const receipt = join(directory, "receipt.private.json");
  const tables = [
    "bank_accounts",
    "expenses",
    "receipts",
    "cash_flow_entries",
    "rateio_allocations",
    "cross_project_settlements",
    "budget_allocations",
    "bank_statement_imports",
    "credit_card_imports",
    "credit_cards",
    "imported_invoice_liquidations",
    "invoice_adjustments",
  ];
  const sql = [
    "PRAGMA journal_mode = DELETE;",
    ...tables.map(
      (table) =>
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, amount INTEGER);`,
    ),
    "CREATE TABLE user_activity_logs (id TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT, action TEXT, created_at TEXT);",
    "INSERT INTO expenses VALUES ('sensitive-expense-id', 100);",
  ].join("\n");
  const created = spawnSync("sqlite3", [database], {
    encoding: "utf8",
    input: sql,
  });
  assert.equal(created.status, 0, created.stderr);
  return { database, directory, manifest, receipt, trace };
}

async function upstream(responseBody = { ok: true }) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(responseBody));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function request(origin, path, method = "GET") {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: "Bearer super-secret-token",
      "x-sensitive-id": "sensitive-user-id",
    },
  });
}

test("guard records and rejects all forbidden POST routes without forwarding", async () => {
  const remote = await upstream();
  const guard = new ProductionQaGuard({ upstreamOrigin: remote.origin });
  await guard.listen();
  try {
    for (const path of [
      "/import-sessions/sensitive-session-id/confirmation-challenge",
      "/api/import-sessions/sensitive-session-id/confirm/",
      "/IMPORT-SESSIONS/sensitive-session-id/EXECUTE?source=qa",
      "/import-sessions/sensitive-session-id/%63onfirm",
    ]) {
      const response = await request(guard.origin, path, "POST");
      assert.equal(response.status, 403);
      assert.equal(
        await response.text(),
        "production QA guard forbids financial action\n",
      );
    }
    assert.equal(remote.requests.length, 0);
    assert.deepEqual(guard.summary(), {
      allowedRequests: 0,
      forbiddenRequests: 4,
      readyObserved: false,
      stateViolations: 0,
    });
  } finally {
    await guard.close();
    await remote.close();
  }
});

test("guard forwards unrelated methods/routes and makes READY terminal", async () => {
  const remote = await upstream({
    state: "READY",
    proposal: { lines: [] },
    confirmation: null,
    receipt: null,
  });
  const guard = new ProductionQaGuard({ upstreamOrigin: remote.origin });
  await guard.listen();
  try {
    assert.equal((await request(guard.origin, "/health")).status, 200);
    assert.equal(
      (await request(guard.origin, "/import-sessions/session-a")).status,
      200,
    );
    assert.equal(
      (await request(guard.origin, "/import-sessions/session-a/observations"))
        .status,
      409,
    );
    assert.equal(remote.requests.length, 2);
    assert.equal(guard.summary().readyObserved, true);
  } finally {
    await guard.close();
    await remote.close();
  }
});

test("guard fails closed when an upstream session is beyond READY", async () => {
  for (const session of [
    {
      state: "CONFIRMED",
      proposal: { lines: [] },
      confirmation: {},
      receipt: null,
    },
    {
      state: "APPLIED",
      proposal: { lines: [] },
      confirmation: {},
      receipt: {},
    },
    {
      state: "READY",
      proposal: null,
      confirmation: null,
      receipt: null,
    },
    {
      state: "READY",
      proposal: { lines: [] },
      confirmation: {},
      receipt: null,
    },
    {
      state: "READY",
      proposal: { lines: [] },
      confirmation: null,
      receipt: {},
    },
  ]) {
    const remote = await upstream(session);
    const guard = new ProductionQaGuard({ upstreamOrigin: remote.origin });
    await guard.listen();
    try {
      const response = await request(
        guard.origin,
        "/import-sessions/sensitive-session-id",
      );
      assert.equal(response.status, 502, JSON.stringify(session));
      assert.equal(guard.summary().stateViolations, 1);
      assert.equal(guard.summary().readyObserved, false);
    } finally {
      await guard.close();
      await remote.close();
    }
  }
});

async function expectJourneyRejected(
  value,
  sql,
  expected = /QA_DATABASE_DRIFT/,
) {
  const remote = await upstream({
    state: "READY",
    proposal: { lines: [] },
    confirmation: null,
    receipt: null,
  });
  const runner = supervisor(value, remote, {
    testHooks: {
      afterCapture: () => {
        const mutation = spawnSync("sqlite3", [value.database], {
          encoding: "utf8",
          input: sql,
        });
        assert.equal(mutation.status, 0, mutation.stderr);
      },
    },
  });
  try {
    await runner.start(RELEASE);
    await reachReady(runner);
    await assert.rejects(() => runner.finish(), expected);
    assert.equal(existsSync(value.receipt), false);
  } finally {
    await runner.close();
    await remote.close();
  }
}

test("supervised before/after evidence rejects financial mutation and execute audit events", async () => {
  await expectJourneyRejected(fixture(), "UPDATE expenses SET amount = 101;");
  await expectJourneyRejected(
    fixture(),
    "INSERT INTO user_activity_logs VALUES ('audit-id', 'user-id', 'tenant-id', 'importSessions.execute', '2026-10-13');",
  );
});

test("supervised financial fingerprint binds every protected table independently", async () => {
  for (const table of [
    "bank_accounts",
    "bank_statement_imports",
    "budget_allocations",
    "cash_flow_entries",
    "credit_cards",
    "credit_card_imports",
    "cross_project_settlements",
    "expenses",
    "imported_invoice_liquidations",
    "invoice_adjustments",
    "rateio_allocations",
    "receipts",
  ]) {
    await expectJourneyRejected(
      fixture(),
      `INSERT INTO "${table}" VALUES ('mutation-${table}', 999);`,
    );
  }
});

test("supervised execute audit fingerprint rejects same-count row drift", async () => {
  const value = fixture();
  const seeded = spawnSync("sqlite3", [value.database], {
    encoding: "utf8",
    input:
      "INSERT INTO user_activity_logs VALUES ('audit-id', 'user-before', 'tenant-before', 'importSessions.execute', '2026-10-13T12:00:00.000Z');",
  });
  assert.equal(seeded.status, 0, seeded.stderr);
  await expectJourneyRejected(
    value,
    "UPDATE user_activity_logs SET user_id = 'user-after' WHERE id = 'audit-id';",
  );
});

function supervisor(value, remote, overrides = {}) {
  return new ProductionQaSupervisor({
    database: value.database,
    manifest: value.manifest,
    trace: value.trace,
    receipt: value.receipt,
    upstreamOrigin: remote.origin,
    artifactPath: GUARD_SOURCE,
    sqliteBinary: "/usr/bin/sqlite3",
    host: "127.0.0.1",
    port: 0,
    ...overrides,
  });
}

async function reachReady(runner) {
  const response = await request(
    runner.origin,
    "/import-sessions/sensitive-session-id",
  );
  assert.equal(response.status, 200);
}

test("one supervisor owns capture, guard trace, compare, and receipt", async () => {
  const value = fixture();
  const remote = await upstream({
    state: "READY",
    proposal: { lines: [] },
    confirmation: null,
    receipt: null,
  });
  const runner = supervisor(value, remote);
  try {
    await runner.start(RELEASE);
    assert.equal(existsSync(value.manifest), true);
    assert.equal(existsSync(value.trace), false);
    assert.equal(existsSync(value.receipt), false);
    await assert.rejects(() => runner.start(RELEASE), /QA_WINDOW_REUSED/);
    await reachReady(runner);
    assert.equal(await runner.waitForTerminal(), "ready");
    const output = await runner.finish();
    assert.match(output, /^vault-production-qa run ok /);
    assert.doesNotMatch(output, /sensitive|expense-id|user-id/i);
    assert.equal(existsSync(value.receipt), true);
    const manifestBytes = readFileSync(value.manifest);
    const traceBytes = readFileSync(value.trace);
    const manifest = JSON.parse(manifestBytes);
    const trace = JSON.parse(traceBytes);
    const receipt = JSON.parse(readFileSync(value.receipt));
    for (const privatePath of [value.manifest, value.trace, value.receipt]) {
      assert.equal(lstatSync(privatePath).mode & 0o777, 0o600);
      assert.equal(lstatSync(privatePath).nlink, 1);
    }
    assert.deepEqual(manifest.metadata, RELEASE);
    assert.deepEqual(trace.metadata, RELEASE);
    assert.deepEqual(receipt.metadata, RELEASE);
    assert.match(manifest.nonce, /^[0-9a-f]{64}$/);
    assert.equal(trace.nonce, manifest.nonce);
    assert.equal(receipt.nonce, manifest.nonce);
    assert.equal(trace.artifactSha256, manifest.artifactSha256);
    assert.equal(receipt.artifactSha256, manifest.artifactSha256);
    assert.match(trace.summary.requestSummarySha256, /^[0-9a-f]{64}$/);
    assert.ok(BigInt(trace.monotonicEndNs) > BigInt(trace.monotonicStartNs));
    assert.equal(
      receipt.manifestSha256,
      createHash("sha256").update(manifestBytes).digest("hex"),
    );
    assert.equal(
      receipt.traceSha256,
      createHash("sha256").update(traceBytes).digest("hex"),
    );
    assert.doesNotMatch(
      `${manifestBytes}\n${traceBytes}\n${JSON.stringify(receipt)}`,
      /sensitive|expense-id|user-id/i,
    );

    const replay = supervisor(value, remote);
    await assert.rejects(() => replay.start(RELEASE), /QA_WINDOW_REUSED/);
    await replay.close();
    await assert.rejects(() => runner.finish(), /QA_WINDOW_REUSED/);
    assert.throws(() => runner.waitForTerminal(), /QA_GUARD_NOT_LISTENING/);
  } finally {
    await runner.close();
    await remote.close();
  }
});

test("supervisor emits no receipt after a forbidden financial request", async () => {
  const value = fixture();
  const remote = await upstream();
  const runner = supervisor(value, remote);
  try {
    await runner.start(RELEASE);
    const response = await request(
      runner.origin,
      "/import-sessions/sensitive-session-id/execute",
      "POST",
    );
    assert.equal(response.status, 403);
    assert.equal(await runner.waitForTerminal(), "violation");
    await assert.rejects(() => runner.finish(), /QA_TRACE_REJECTED/);
    assert.equal(existsSync(value.manifest), true);
    assert.equal(existsSync(value.trace), true);
    assert.equal(existsSync(value.receipt), false);
  } finally {
    await runner.close();
    await remote.close();
  }
});

test("supervisor rejects a hand-authored trace before capture", async () => {
  const value = fixture();
  const remote = await upstream();
  writeFileSync(value.trace, "{}\n", { mode: 0o600 });
  const runner = supervisor(value, remote);
  try {
    await assert.rejects(() => runner.start(RELEASE), /QA_WINDOW_REUSED/);
    assert.equal(existsSync(value.manifest), false);
    assert.equal(existsSync(value.receipt), false);
  } finally {
    await runner.close();
    await remote.close();
  }
});

test("supervisor rejects a forged trace injected during its lifecycle", async () => {
  const value = fixture();
  const remote = await upstream({
    state: "READY",
    proposal: { lines: [] },
    confirmation: null,
    receipt: null,
  });
  const runner = supervisor(value, remote, {
    testHooks: {
      afterCapture: () =>
        writeFileSync(
          value.trace,
          `${JSON.stringify({
            version: 2,
            state: "guarded",
            summary: {
              allowedRequests: 1,
              forbiddenRequests: 0,
              readyObserved: true,
              stateViolations: 0,
            },
          })}\n`,
          { mode: 0o600 },
        ),
    },
  });
  try {
    await runner.start(RELEASE);
    await reachReady(runner);
    await assert.rejects(() => runner.finish(), /QA_WINDOW_REUSED/);
    assert.equal(existsSync(value.receipt), false);
  } finally {
    await runner.close();
    await remote.close();
  }
});

test("supervisor rejects manifest and trace pathname swaps without a receipt", async () => {
  for (const target of ["manifest", "trace"]) {
    const value = fixture();
    const remote = await upstream({
      state: "READY",
      proposal: { lines: [] },
      confirmation: null,
      receipt: null,
    });
    const swapped = `${value[target]}.swapped`;
    const hook = () => {
      renameSync(value[target], swapped);
      copyFileSync(swapped, value[target]);
    };
    const runner = supervisor(value, remote, {
      testHooks:
        target === "manifest" ? { afterCapture: hook } : { afterTrace: hook },
    });
    try {
      await runner.start(RELEASE);
      await reachReady(runner);
      await assert.rejects(() => runner.finish(), /QA_PRIVATE_FILE_REPLACED/);
      assert.equal(existsSync(value.receipt), false);
    } finally {
      await runner.close();
      await remote.close();
    }
  }
});

test("supervisor rejects a symlinked private-file parent component", async () => {
  const value = fixture();
  const remote = await upstream();
  const realEvidence = join(value.directory, "real-evidence");
  const linkedEvidence = join(value.directory, "linked-evidence");
  mkdirSync(realEvidence);
  symlinkSync(realEvidence, linkedEvidence);
  const runner = supervisor(value, remote, {
    manifest: join(linkedEvidence, "manifest.json"),
    trace: join(linkedEvidence, "trace.json"),
    receipt: join(linkedEvidence, "receipt.json"),
  });
  try {
    await assert.rejects(() => runner.start(RELEASE), /QA_PRIVATE_FILE_UNSAFE/);
    assert.equal(existsSync(join(realEvidence, "receipt.json")), false);
  } finally {
    await runner.close();
    await remote.close();
  }
});

test("Linux supervisor rejects a database pathname ABA during its snapshot without a receipt", async () => {
  const value = fixture();
  const remote = await upstream();
  const displaced = join(value.directory, "displaced.db");
  const replacement = join(value.directory, "replacement.db");
  copyFileSync(value.database, replacement);
  let swaps = 0;
  const runner = supervisor(value, remote, {
    testHooks: {
      afterSnapshotBegin: () => {
        if (swaps++ > 0) return;
        renameSync(value.database, displaced);
        renameSync(replacement, value.database);
        renameSync(value.database, replacement);
        renameSync(displaced, value.database);
      },
    },
  });
  try {
    await assert.rejects(() => runner.start(RELEASE), /QA_DATABASE_REPLACED/);
    assert.equal(swaps, 1);
    assert.equal(existsSync(value.receipt), false);
  } finally {
    await runner.close();
    await remote.close();
  }
});
