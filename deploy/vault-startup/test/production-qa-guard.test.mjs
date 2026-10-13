import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
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
import { fileURLToPath } from "node:url";

import {
  ProductionQaGuard,
  captureProductionQaBaseline,
  compareProductionQaBaseline,
} from "../production-qa-guard.mjs";

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
    for (const action of ["confirmation-challenge", "confirm", "execute"]) {
      const response = await request(
        guard.origin,
        `/import-sessions/sensitive-session-id/${action}`,
        "POST",
      );
      assert.equal(response.status, 403);
    }
    assert.equal(remote.requests.length, 0);
    assert.deepEqual(guard.summary(), {
      allowedRequests: 0,
      forbiddenRequests: 3,
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
  const remote = await upstream({
    state: "APPLIED",
    proposal: { lines: [] },
    confirmation: {},
    receipt: {},
  });
  const guard = new ProductionQaGuard({ upstreamOrigin: remote.origin });
  await guard.listen();
  try {
    const response = await request(
      guard.origin,
      "/import-sessions/sensitive-session-id",
    );
    assert.equal(response.status, 502);
    assert.equal(guard.summary().stateViolations, 1);
  } finally {
    await guard.close();
    await remote.close();
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
  assert.throws(
    () =>
      compareProductionQaBaseline({
        database: value.database,
        manifest: value.manifest,
        trace: value.trace,
        receipt: value.receipt,
        metadata: { ...RELEASE, windowId: "different-window" },
      }),
    /QA_METADATA_MISMATCH/,
  );
  const compareOutput = compareProductionQaBaseline({
    database: value.database,
    manifest: value.manifest,
    trace: value.trace,
    receipt: value.receipt,
    metadata: RELEASE,
  });
  assert.doesNotMatch(compareOutput, /sensitive|expense-id|user-id/i);
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
