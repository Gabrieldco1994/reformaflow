import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
const {
  ProductionQaGuard,
  captureProductionQaBaseline,
  compareProductionQaBaseline,
} = guardModule;

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
  assert.match(launcher, /capture\|guard\|compare/);
  assert.doesNotMatch(
    launcher,
    /DATABASE_URL|--database|--sql|--origin|\beval\b|\$\{@:|\$\*/,
  );
  assert.match(
    source.toString("utf8"),
    /const UPSTREAM_ORIGIN = "https:\/\/reformaflow-api\.fly\.dev"/,
  );

  for (const args of [[], ["apply"], ["guard", "--origin", "http://evil"]]) {
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

test("before/after evidence rejects financial mutation and execute audit events", () => {
  const unchanged = fixture();
  captureProductionQaBaseline({
    database: unchanged.database,
    manifest: unchanged.manifest,
    metadata: RELEASE,
  });
  writeFileSync(
    unchanged.trace,
    `${JSON.stringify({
      version: 1,
      metadata: RELEASE,
      summary: {
        allowedRequests: 2,
        forbiddenRequests: 0,
        readyObserved: true,
        stateViolations: 0,
      },
    })}\n`,
    { mode: 0o600 },
  );
  compareProductionQaBaseline({
    database: unchanged.database,
    manifest: unchanged.manifest,
    trace: unchanged.trace,
    receipt: unchanged.receipt,
    metadata: RELEASE,
  });

  for (const [label, sql] of [
    ["financial row", "UPDATE expenses SET amount = 101;"],
    [
      "execute audit",
      "INSERT INTO user_activity_logs VALUES ('audit-id', 'user-id', 'tenant-id', 'importSessions.execute', '2026-10-13');",
    ],
  ]) {
    const changed = fixture();
    captureProductionQaBaseline({
      database: changed.database,
      manifest: changed.manifest,
      metadata: RELEASE,
    });
    writeFileSync(changed.trace, readFileSync(unchanged.trace), {
      mode: 0o600,
    });
    const mutation = spawnSync("sqlite3", [changed.database], {
      encoding: "utf8",
      input: sql,
    });
    assert.equal(mutation.status, 0, mutation.stderr);
    assert.throws(
      () =>
        compareProductionQaBaseline({
          database: changed.database,
          manifest: changed.manifest,
          trace: changed.trace,
          receipt: changed.receipt,
          metadata: RELEASE,
        }),
      /QA_DATABASE_DRIFT/,
      label,
    );
  }
});

test("financial fingerprint binds every protected table independently", () => {
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
    const value = fixture();
    captureProductionQaBaseline({
      database: value.database,
      manifest: value.manifest,
      metadata: RELEASE,
    });
    writeFileSync(
      value.trace,
      `${JSON.stringify({
        version: 1,
        metadata: RELEASE,
        summary: {
          allowedRequests: 1,
          forbiddenRequests: 0,
          readyObserved: true,
          stateViolations: 0,
        },
      })}\n`,
      { mode: 0o600 },
    );
    const mutation = spawnSync("sqlite3", [value.database], {
      encoding: "utf8",
      input: `INSERT INTO "${table}" VALUES ('mutation-${table}', 999);`,
    });
    assert.equal(mutation.status, 0, mutation.stderr);
    assert.throws(
      () =>
        compareProductionQaBaseline({
          database: value.database,
          manifest: value.manifest,
          trace: value.trace,
          receipt: value.receipt,
          metadata: RELEASE,
        }),
      /QA_DATABASE_DRIFT/,
      table,
    );
  }
});

test("execute audit fingerprint rejects same-count row drift", () => {
  const value = fixture();
  const seeded = spawnSync("sqlite3", [value.database], {
    encoding: "utf8",
    input:
      "INSERT INTO user_activity_logs VALUES ('audit-id', 'user-before', 'tenant-before', 'importSessions.execute', '2026-10-13T12:00:00.000Z');",
  });
  assert.equal(seeded.status, 0, seeded.stderr);
  captureProductionQaBaseline({
    database: value.database,
    manifest: value.manifest,
    metadata: RELEASE,
  });
  writeFileSync(
    value.trace,
    `${JSON.stringify({
      version: 1,
      metadata: RELEASE,
      summary: {
        allowedRequests: 1,
        forbiddenRequests: 0,
        readyObserved: true,
        stateViolations: 0,
      },
    })}\n`,
    { mode: 0o600 },
  );
  const mutation = spawnSync("sqlite3", [value.database], {
    encoding: "utf8",
    input:
      "UPDATE user_activity_logs SET user_id = 'user-after' WHERE id = 'audit-id';",
  });
  assert.equal(mutation.status, 0, mutation.stderr);
  assert.throws(
    () =>
      compareProductionQaBaseline({
        database: value.database,
        manifest: value.manifest,
        trace: value.trace,
        receipt: value.receipt,
        metadata: RELEASE,
      }),
    /QA_DATABASE_DRIFT/,
  );
});

test("evidence rejects replay/window mismatch and emits no sensitive values", () => {
  const value = fixture();
  const captureOutput = captureProductionQaBaseline({
    database: value.database,
    manifest: value.manifest,
    metadata: RELEASE,
  });
  assert.doesNotMatch(captureOutput, /sensitive|expense-id|user-id/i);
  writeFileSync(
    value.trace,
    `${JSON.stringify({
      version: 1,
      metadata: RELEASE,
      summary: {
        allowedRequests: 1,
        forbiddenRequests: 0,
        readyObserved: true,
        stateViolations: 0,
      },
    })}\n`,
    { mode: 0o600 },
  );
  for (const metadata of [
    { ...RELEASE, releaseSha: "c".repeat(40) },
    { ...RELEASE, releaseId: "different-release" },
    { ...RELEASE, imageDigest: `sha256:${"d".repeat(64)}` },
    { ...RELEASE, windowId: "different-window" },
    {
      ...RELEASE,
      windowStart: new Date(
        Date.parse(RELEASE.windowStart) - 1_000,
      ).toISOString(),
    },
    {
      ...RELEASE,
      windowEnd: new Date(Date.parse(RELEASE.windowEnd) + 1_000).toISOString(),
    },
    { ...RELEASE, qaActor: "different-qa-actor" },
  ]) {
    assert.throws(
      () =>
        compareProductionQaBaseline({
          database: value.database,
          manifest: value.manifest,
          trace: value.trace,
          receipt: value.receipt,
          metadata,
        }),
      /QA_METADATA_MISMATCH/,
    );
  }

  writeFileSync(
    value.trace,
    `${JSON.stringify({
      version: 1,
      metadata: { ...RELEASE, releaseSha: "c".repeat(40) },
      summary: {
        allowedRequests: 1,
        forbiddenRequests: 0,
        readyObserved: true,
        stateViolations: 0,
      },
    })}\n`,
    { mode: 0o600 },
  );
  assert.throws(
    () =>
      compareProductionQaBaseline({
        database: value.database,
        manifest: value.manifest,
        trace: value.trace,
        receipt: value.receipt,
        metadata: RELEASE,
      }),
    /QA_TRACE_REJECTED/,
  );
  writeFileSync(
    value.trace,
    `${JSON.stringify({
      version: 1,
      metadata: RELEASE,
      summary: {
        allowedRequests: 1,
        forbiddenRequests: 0,
        readyObserved: true,
        stateViolations: 0,
      },
    })}\n`,
    { mode: 0o600 },
  );
  const compareOutput = compareProductionQaBaseline({
    database: value.database,
    manifest: value.manifest,
    trace: value.trace,
    receipt: value.receipt,
    metadata: RELEASE,
  });
  assert.doesNotMatch(compareOutput, /sensitive|expense-id|user-id/i);
  const receipt = JSON.parse(readFileSync(value.receipt, "utf8"));
  assert.equal(lstatSync(value.receipt).mode & 0o777, 0o600);
  assert.deepEqual(receipt.metadata, RELEASE);
  assert.match(receipt.manifestSha256, /^[0-9a-f]{64}$/);
  assert.match(receipt.traceSha256, /^[0-9a-f]{64}$/);
  assert.match(receipt.comparisonSha256, /^[0-9a-f]{64}$/);
  assert.throws(
    () =>
      compareProductionQaBaseline({
        database: value.database,
        manifest: value.manifest,
        trace: value.trace,
        receipt: value.receipt,
        metadata: RELEASE,
      }),
    /QA_WINDOW_REUSED/,
  );
});
