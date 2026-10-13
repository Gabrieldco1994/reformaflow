import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const testDatabaseGuard = require("../test-db-env.cjs");

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRIPT = join(ROOT, "scripts", "repair-legacy-fk-integrity.mjs");
const OP_WRAP = join(ROOT, "deploy", "quiesce", "op-wrap.sh");
const SCRIPT_SOURCE = readFileSync(SCRIPT, "utf8");
const LEGACY_RUNBOOK_SOURCE = readFileSync(
  join(ROOT, "deploy", "quiesce", "legacy-fk-recovery.md"),
  "utf8",
);
const QUIESCE_README_SOURCE = readFileSync(
  join(ROOT, "deploy", "quiesce", "README.md"),
  "utf8",
);
const TEST_DATABASE = testDatabaseGuard.TEST_DB_PATH;
const EXPECTED_PROJECTS = 2;
const EXPECTED_ROOMS = 28;
const EXPECTED_CASH_FLOW_ENTRIES = 4;
const EXPECTED_FOREIGN_KEY_VIOLATIONS = 32;
const TRUSTED_OPERATOR_PURPOSE = "legacy-fk-32-2026-10";
const TRUSTED_OPERATOR_ISSUE = "#722";
const PROJECT_A = "fixture-missing-project-alpha";
const PROJECT_B = "fixture-missing-project-beta";
const TENANT_A = "fixture-tenant-alpha";
const TENANT_B = "fixture-tenant-beta";
const ACTIVE_PROJECT_A = "fixture-active-project-alpha";
const ACTIVE_PROJECT_B = "fixture-active-project-beta";
const ROOM_IDS_A = [
  "fixture-room-alpha-01",
  "fixture-room-alpha-02",
  "fixture-room-alpha-03",
  "fixture-room-alpha-04",
  "fixture-room-alpha-05",
  "fixture-room-alpha-06",
  "fixture-room-alpha-07",
  "fixture-room-alpha-08",
  "fixture-room-alpha-09",
  "fixture-room-alpha-10",
  "fixture-room-alpha-11",
  "fixture-room-alpha-12",
  "fixture-room-alpha-13",
  "fixture-room-alpha-14",
];
const ROOM_IDS_B = [
  "fixture-room-beta-01",
  "fixture-room-beta-02",
  "fixture-room-beta-03",
  "fixture-room-beta-04",
  "fixture-room-beta-05",
  "fixture-room-beta-06",
  "fixture-room-beta-07",
  "fixture-room-beta-08",
  "fixture-room-beta-09",
  "fixture-room-beta-10",
  "fixture-room-beta-11",
  "fixture-room-beta-12",
  "fixture-room-beta-13",
  "fixture-room-beta-14",
];
const CASH_FLOW_SCOPE = [
  {
    cashFlowEntryId: "fixture-cash-flow-alpha-01",
    missingExpenseId: "fixture-missing-expense-alpha-01",
    tenantId: TENANT_A,
    projectId: ACTIVE_PROJECT_A,
  },
  {
    cashFlowEntryId: "fixture-cash-flow-alpha-02",
    missingExpenseId: "fixture-missing-expense-alpha-02",
    tenantId: TENANT_A,
    projectId: ACTIVE_PROJECT_A,
  },
  {
    cashFlowEntryId: "fixture-cash-flow-beta-01",
    missingExpenseId: "fixture-missing-expense-beta-01",
    tenantId: TENANT_B,
    projectId: ACTIVE_PROJECT_B,
  },
  {
    cashFlowEntryId: "fixture-cash-flow-beta-02",
    missingExpenseId: "fixture-missing-expense-beta-02",
    tenantId: TENANT_B,
    projectId: ACTIVE_PROJECT_B,
  },
];
const PRIVATE_VALUES = [
  PROJECT_A,
  PROJECT_B,
  TENANT_A,
  TENANT_B,
  ...ROOM_IDS_A,
  ...ROOM_IDS_B,
  ...CASH_FLOW_SCOPE.flatMap((row) => [
    row.cashFlowEntryId,
    row.missingExpenseId,
  ]),
];
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "rf-722-fk-repair-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sqlite(database, statement, options = []) {
  const result = spawnSync("sqlite3", [...options, database], {
    input: statement,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `sqlite failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result.stdout;
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function values(rows) {
  return rows.map((row) => `(${row.map(quote).join(",")})`).join(",\n");
}

function scopeProof() {
  const scope = {
    missingProjects: [
      { projectId: PROJECT_A, tenantId: TENANT_A, roomIds: ROOM_IDS_A },
      { projectId: PROJECT_B, tenantId: TENANT_B, roomIds: ROOM_IDS_B },
    ],
    orphanCashFlowEntries: CASH_FLOW_SCOPE.map((row) => ({ ...row })),
  };
  const scopeSha256 = sha256(canonicalBytes(scope));
  return {
    version: 1,
    trustedOperatorException: {
      purpose: TRUSTED_OPERATOR_PURPOSE,
      issue: TRUSTED_OPERATOR_ISSUE,
      singleUse: true,
      expectedCounts: {
        missingProjects: EXPECTED_PROJECTS,
        orphanRooms: EXPECTED_ROOMS,
        orphanCashFlowEntries: EXPECTED_CASH_FLOW_ENTRIES,
        foreignKeyViolations: EXPECTED_FOREIGN_KEY_VIOLATIONS,
      },
      maximumDeletions: 0,
      maximumMonetaryChangeCents: 0,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    provenance: {
      sourceArtifactSha256: "c".repeat(64),
      scopeSha256,
      generatedAt: "2026-10-12T18:00:00.000Z",
      methodology:
        "Synthetic fixture provenance for the restricted recovery proof",
      attestations: [
        {
          reviewer: "fixture-reviewer-a",
          scopeSha256,
          attestationSha256: "d".repeat(64),
        },
        {
          reviewer: "fixture-reviewer-b",
          scopeSha256,
          attestationSha256: "e".repeat(64),
        },
      ],
    },
    ...scope,
  };
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytesOrPath) {
  const bytes = Buffer.isBuffer(bytesOrPath)
    ? bytesOrPath
    : readFileSync(bytesOrPath);
  return createHash("sha256").update(bytes).digest("hex");
}

function writePrivateJson(path, value) {
  writeFileSync(path, canonicalBytes(value), { mode: 0o600, flag: "wx" });
}

function createFixture() {
  const directory = temporaryDirectory();
  const database = join(directory, "legacy-fixture.db");
  const proof = join(directory, "scope-proof.json");
  const manifest = join(directory, "manifest.json");
  assert.notEqual(database, TEST_DATABASE);
  copyFileSync(TEST_DATABASE, database);
  writePrivateJson(proof, scopeProof());

  const rooms = [
    ...ROOM_IDS_A.map((id, index) => [
      id,
      PROJECT_A,
      `Alpha room ${index + 1}`,
      String(index),
      "2026-01-01T00:00:00.000Z",
    ]),
    ...ROOM_IDS_B.map((id, index) => [
      id,
      PROJECT_B,
      `Beta room ${index + 1}`,
      String(index),
      "2026-01-02T00:00:00.000Z",
    ]),
  ];
  const cashFlowRows = CASH_FLOW_SCOPE.map((row, index) => [
    row.cashFlowEntryId,
    row.projectId,
    row.tenantId,
    row.missingExpenseId,
    String(10101 + index),
    "DESPESA",
    `2026-02-0${index + 1}T00:00:00.000Z`,
    `fixture-category-${index}`,
    `fixture-subcategory-${index}`,
    `fixture-room-label-${index}`,
    "A_VISTA",
    index % 2 === 0 ? "PAGO" : "PLANEJADO",
    `${index + 1}/4`,
    `2026-0${index + 3}`,
    `2026-03-0${index + 1}T00:00:00.000Z`,
    `2026-04-0${index + 1}T00:00:00.000Z`,
    `2026-05-0${index + 1}T00:00:00.000Z`,
  ]);

  const foreignKeyModes = sqlite(
    database,
    `
      PRAGMA foreign_keys = OFF;
      PRAGMA foreign_keys;
      INSERT INTO tenants
        (id, name, created_at, updated_at, deleted_at)
      VALUES
        (${quote(TENANT_A)}, 'Fixture tenant alpha', '2025-01-01', '2025-01-02', NULL),
        (${quote(TENANT_B)}, 'Fixture tenant beta', '2025-01-03', '2025-01-04', NULL);
      INSERT INTO projects
        (id, tenant_id, created_by_user_id, type, name, description,
         start_date, end_date, created_at, updated_at, deleted_at, onboarded_at)
      VALUES
        (${quote(ACTIVE_PROJECT_A)}, ${quote(TENANT_A)}, NULL, 'REFORMA',
         'Fixture active alpha', NULL, NULL, NULL, '2025-02-01', '2025-02-02', NULL, NULL),
        (${quote(ACTIVE_PROJECT_B)}, ${quote(TENANT_B)}, NULL, 'REFORMA',
         'Fixture active beta', NULL, NULL, NULL, '2025-02-03', '2025-02-04', NULL, NULL);
      INSERT INTO rooms
        (id, project_id, name, "order", created_at, deleted_at)
      VALUES
        ${values(rooms.map((row) => [...row, "NULL_SENTINEL"])).replaceAll(
          "'NULL_SENTINEL'",
          "NULL",
        )};
      INSERT INTO cash_flow_entries
        (id, project_id, tenant_id, receipt_id, expense_id,
         budget_allocation_id, valor, tipo, data, categoria, subcategoria,
         ambiente, forma_pagamento, status, parcela, invoice_due_month,
         created_at, updated_at, deleted_at)
      VALUES
        ${values(
          cashFlowRows.map((row) => [
            row[0],
            row[1],
            row[2],
            "NULL_SENTINEL",
            row[3],
            "NULL_SENTINEL",
            ...row.slice(4),
          ]),
        ).replaceAll("'NULL_SENTINEL'", "NULL")};
      PRAGMA foreign_keys = ON;
      PRAGMA foreign_keys;
    `,
  );
  assert.equal(
    foreignKeyModes,
    "0\n1\n",
    "fixture seeding must disable FKs only for its disposable copy, then restore them",
  );
  assertExactLegacyViolations(database);
  return { directory, database, proof, manifest };
}

function runRepair(database, args, env = {}) {
  return runRepairWithDatabaseUrl(
    dirname(database),
    recoveryDatabaseUrl(database),
    args,
    env,
  );
}

function recoveryDatabaseUrl(database) {
  return `file:${database}?socket_timeout=13&connection_limit=8`;
}

function runRepairWithDatabaseUrl(directory, databaseUrl, args, env = {}) {
  const lock = inheritedTestLock(directory);
  const command = repairCommand(args);
  try {
    return spawnSync(command.executable, command.args, {
      cwd: directory,
      encoding: "utf8",
      stdio: lock.stdio,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        LEGACY_FK_RECOVERY_OP_WRAP: "legacy-fk-integrity-v1",
        ...lock.env,
        ...env,
      },
    });
  } finally {
    lock.close();
  }
}

function launchRepair(database, args) {
  return new Promise((resolve) => {
    const lock = inheritedTestLock(dirname(database));
    const command = repairCommand(args);
    const child = spawn(command.executable, command.args, {
      cwd: repairWorkingDirectory(database),
      stdio: lock.stdio,
      env: {
        ...process.env,
        DATABASE_URL: recoveryDatabaseUrl(database),
        LEGACY_FK_RECOVERY_OP_WRAP: "legacy-fk-integrity-v1",
        ...lock.env,
      },
    });
    lock.close();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function prismaConstructorProbe(directory) {
  const capture = join(directory, "prisma-constructor-url.json");
  const preload = join(directory, "capture-prisma-constructor.cjs");
  writeFileSync(
    preload,
    `"use strict";
const fs = require("node:fs");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@prisma/client") {
    return {
      PrismaClient: class {
        constructor(options) {
          fs.writeFileSync(
            process.env.RECOVERY_TEST_PRISMA_CAPTURE,
            JSON.stringify(options.datasources.db.url),
            { flag: "wx", mode: 0o600 },
          );
          throw new Error("test-only constructor probe");
        }
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
`,
    { mode: 0o600, flag: "wx" },
  );
  return {
    capture,
    env: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`]
        .filter(Boolean)
        .join(" "),
      RECOVERY_TEST_PRISMA_CAPTURE: capture,
    },
  };
}

function repairCommand(args, platform = process.platform, scriptPath = SCRIPT) {
  if (platform === "linux") {
    return {
      executable: "sh",
      args: [
        "-c",
        'flock -x 9 || exit $?; exec "$@"',
        "repair-test-lock",
        process.execPath,
        scriptPath,
        ...args,
      ],
    };
  }
  return { executable: process.execPath, args: [scriptPath, ...args] };
}

function repairWorkingDirectory(database) {
  return dirname(database);
}

function inheritedTestLock(directory) {
  const quiesceDirectory = join(directory, ".test-quiesce");
  mkdirSync(quiesceDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(quiesceDirectory, "lock");
  const lockFd = openSync(lockPath, "a", 0o600);
  const capabilityPath = join(
    mkdtempSync(join(quiesceDirectory, ".cap-")),
    "capability",
  );
  writeFileSync(capabilityPath, "test-only inherited capability\n", {
    mode: 0o600,
  });
  const capabilityFd = openSync(capabilityPath, "r");
  unlinkSync(capabilityPath);
  const stdio = Array.from({ length: 10 }, () => "ignore");
  stdio[0] = "pipe";
  stdio[1] = "pipe";
  stdio[2] = "pipe";
  stdio[7] = capabilityFd;
  stdio[9] = lockFd;
  return {
    stdio,
    env: {
      QUIESCE_DIR: quiesceDirectory,
      LEGACY_FK_RECOVERY_LOCK_FD: "9",
      LEGACY_FK_RECOVERY_CAP_FD: "7",
    },
    close() {
      closeSync(capabilityFd);
      closeSync(lockFd);
    },
  };
}

function assertPrivateOutput(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const value of PRIVATE_VALUES) {
    assert.doesNotMatch(
      output,
      new RegExp(value),
      `public output leaked private value ${value}`,
    );
  }
  assert.doesNotMatch(output, /scope-proof|legacy-fixture|manifest\.json/);
  assert.doesNotMatch(output, /[a-f0-9]{64}/, "full hash was printed");
}

function requireSuccess(result) {
  assertPrivateOutput(result);
  assert.equal(
    result.status,
    0,
    `repair failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
}

function requireFailure(result) {
  assertPrivateOutput(result);
  assert.notEqual(result.status, 0, "unsafe repair invocation succeeded");
  assert.doesNotMatch(
    result.stderr,
    /MODULE_NOT_FOUND|Cannot find module/,
    "repair artifact is missing",
  );
}

function dryRunArgs(fixture) {
  return [
    "--dry-run",
    "--scope-proof",
    fixture.proof,
    "--scope-proof-hash",
    sha256(fixture.proof),
    "--manifest",
    fixture.manifest,
  ];
}

function applyArgs(fixture, overrides = {}) {
  return [
    "--apply",
    "--scope-proof",
    fixture.proof,
    "--scope-proof-hash",
    overrides.scopeProofHash ?? sha256(fixture.proof),
    "--manifest",
    fixture.manifest,
    "--hash",
    overrides.manifestHash ?? sha256(fixture.manifest),
    "--expected-projects",
    String(overrides.projects ?? EXPECTED_PROJECTS),
    "--expected-rooms",
    String(overrides.rooms ?? EXPECTED_ROOMS),
    "--expected-cash-flow-entries",
    String(overrides.cashFlowEntries ?? EXPECTED_CASH_FLOW_ENTRIES),
  ];
}

function foreignKeyViolations(database) {
  const output = sqlite(database, "PRAGMA foreign_key_check;", ["-json"]);
  return output.trim() ? JSON.parse(output) : [];
}

function assertExactLegacyViolations(database) {
  const violations = foreignKeyViolations(database);
  assert.equal(violations.length, EXPECTED_FOREIGN_KEY_VIOLATIONS);
  assert.deepEqual(
    Object.entries(
      violations.reduce((counts, { table, parent }) => {
        const key = `${table}->${parent}`;
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {}),
    ).sort(([left], [right]) => left.localeCompare(right)),
    [
      ["cash_flow_entries->expenses", EXPECTED_CASH_FLOW_ENTRIES],
      ["rooms->projects", EXPECTED_ROOMS],
    ],
  );
}

function snapshot(database) {
  return sqlite(
    database,
    `
      SELECT 'projects' AS source, id, tenant_id, created_by_user_id, type,
             name, description, start_date, end_date, created_at, updated_at,
             deleted_at, onboarded_at
        FROM projects
       WHERE id IN (${quote(PROJECT_A)}, ${quote(PROJECT_B)})
      UNION ALL
      SELECT 'rooms', id, project_id, NULL, NULL, name, NULL, NULL, NULL,
             created_at, NULL, deleted_at, NULL
        FROM rooms
       WHERE id LIKE 'fixture-room-%'
      UNION ALL
      SELECT 'cash', id, project_id, tenant_id, expense_id, categoria,
             subcategoria, ambiente, forma_pagamento, data, updated_at,
             deleted_at, status
        FROM cash_flow_entries
       WHERE id LIKE 'fixture-cash-flow-%'
       ORDER BY source, id;
    `,
    ["-json"],
  );
}

function cashFlowSnapshot(database) {
  return JSON.parse(
    sqlite(
      database,
      `
        SELECT *
          FROM cash_flow_entries
         WHERE id LIKE 'fixture-cash-flow-%'
         ORDER BY id;
      `,
      ["-json"],
    ),
  );
}

function dryRun(fixture) {
  const result = runRepair(fixture.database, dryRunArgs(fixture));
  requireSuccess(result);
  return JSON.parse(readFileSync(fixture.manifest, "utf8"));
}

function expectBacklink(manifest, table, count) {
  assert.deepEqual(
    manifest.roomBacklinks.find((entry) => entry.table === table),
    {
      table,
      column: "room_id",
      count,
      rowsHash: manifest.roomBacklinks.find((entry) => entry.table === table)
        ?.rowsHash,
    },
  );
  assert.match(
    manifest.roomBacklinks.find((entry) => entry.table === table)?.rowsHash,
    /^[a-f0-9]{64}$/,
  );
}

test("dry-run proves the literal 28+4/2 scope and performs no writes", () => {
  const fixture = createFixture();
  const before = snapshot(fixture.database);
  const beforeDatabase = readFileSync(fixture.database);

  const result = runRepair(fixture.database, dryRunArgs(fixture));

  requireSuccess(result);
  assert.equal(snapshot(fixture.database), before);
  assert.deepEqual(readFileSync(fixture.database), beforeDatabase);
  assert.equal(foreignKeyViolations(fixture.database).length, 32);
  assert.equal(statSync(fixture.manifest).mode & 0o777, 0o600);
  const manifestBytes = readFileSync(fixture.manifest);
  const manifest = JSON.parse(manifestBytes);
  assert.deepEqual(manifestBytes, canonicalBytes(manifest));
  assert.deepEqual(
    {
      version: manifest.version,
      scopeProofSha256: manifest.scopeProofSha256,
      counts: manifest.counts,
      missingProjects: manifest.missingProjects.map(
        ({ projectId, tenantId, roomIds }) => ({
          projectId,
          tenantId,
          roomIds,
        }),
      ),
      orphanCashFlowEntries: manifest.orphanCashFlowEntries.map(
        ({ cashFlowEntryId, missingExpenseId, tenantId, projectId }) => ({
          cashFlowEntryId,
          missingExpenseId,
          tenantId,
          projectId,
        }),
      ),
    },
    {
      version: 1,
      scopeProofSha256: sha256(fixture.proof),
      counts: {
        missingProjects: 2,
        orphanRooms: 28,
        orphanCashFlowEntries: 4,
        foreignKeyViolationsBefore: 32,
        foreignKeyViolationsAfter: 0,
      },
      missingProjects: [
        { projectId: PROJECT_A, tenantId: TENANT_A, roomIds: ROOM_IDS_A },
        { projectId: PROJECT_B, tenantId: TENANT_B, roomIds: ROOM_IDS_B },
      ],
      orphanCashFlowEntries: CASH_FLOW_SCOPE,
    },
  );
  for (const field of ["beforeHash", "postHash", "financialHash"]) {
    assert.match(manifest[field], /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(JSON.parse(result.stdout), {
    missingProjects: 2,
    orphanRooms: 28,
    orphanCashFlowEntries: 4,
    foreignKeyViolationsBefore: 32,
    foreignKeyViolationsAfter: 32,
    insertedProjects: 0,
    updatedCashFlowEntries: 0,
    manifestHash: sha256(manifestBytes).slice(0, 12),
  });

  assert.deepEqual(
    manifest.roomBacklinks.map(({ table, column, count }) => ({
      table,
      column,
      count,
    })),
    [
      { table: "expenses", column: "room_id", count: 0 },
      { table: "floor_plan_rooms", column: "room_id", count: 0 },
      { table: "pendencias", column: "room_id", count: 0 },
      { table: "room_images", column: "room_id", count: 0 },
    ],
  );
  assert.deepEqual(manifest.protectedTriggers, []);
  assert.match(manifest.inventoryHash, /^[a-f0-9]{64}$/);
});

test("trusted-operator exception is exact, one-time, bounded, and unexpired", () => {
  const mutations = [
    (proof) => {
      proof.trustedOperatorException.purpose = "another-purpose";
    },
    (proof) => {
      proof.trustedOperatorException.issue = "#721";
    },
    (proof) => {
      proof.trustedOperatorException.singleUse = false;
    },
    (proof) => {
      proof.trustedOperatorException.expectedCounts.missingProjects = 1;
    },
    (proof) => {
      proof.trustedOperatorException.expectedCounts.orphanRooms = 27;
    },
    (proof) => {
      proof.trustedOperatorException.expectedCounts.orphanCashFlowEntries = 3;
    },
    (proof) => {
      proof.trustedOperatorException.expectedCounts.foreignKeyViolations = 31;
    },
    (proof) => {
      proof.trustedOperatorException.maximumDeletions = 1;
    },
    (proof) => {
      proof.trustedOperatorException.maximumMonetaryChangeCents = 1;
    },
    (proof) => {
      proof.trustedOperatorException.expiresAt = new Date(
        Date.now() - 60 * 1000,
      ).toISOString();
    },
    (proof) => {
      proof.trustedOperatorException.unreviewedField = true;
    },
  ];

  for (const mutate of mutations) {
    const fixture = createFixture();
    const proof = scopeProof();
    mutate(proof);
    unlinkSync(fixture.proof);
    writePrivateJson(fixture.proof, proof);
    const before = snapshot(fixture.database);

    requireFailure(runRepair(fixture.database, dryRunArgs(fixture)));

    assert.equal(snapshot(fixture.database), before);
    assert.throws(() => statSync(fixture.manifest));
  }
});

test("DATABASE_URL normalization precedes filesystem and Prisma access, and only the normalized URL reaches Prisma", () => {
  const mainStart = SCRIPT_SOURCE.indexOf("async function main(argv)");
  const entrypointStart = SCRIPT_SOURCE.indexOf(
    "\nif (\n  process.argv[1]",
    mainStart,
  );
  assert.notEqual(mainStart, -1, "main is missing");
  assert.notEqual(entrypointStart, -1, "entrypoint boundary is missing");
  const mainSource = SCRIPT_SOURCE.slice(mainStart, entrypointStart);
  const normalization = mainSource.match(
    /const (?<normalized>[A-Za-z_$][\w$]*) = normalizeDatabaseUrl\((?<raw>[A-Za-z_$][\w$]*)\);/,
  );
  assert.ok(
    normalization,
    "main must normalize DATABASE_URL into a distinct value",
  );
  const normalizationIndex = normalization.index;
  const inheritedLockIndex = mainSource.indexOf(
    "await assertInheritedWatchdogLock()",
  );
  const proofReadIndex = mainSource.indexOf("loadPrivateJson(");
  const prismaIndex = mainSource.indexOf("new PrismaClient(");
  assert.ok(
    normalizationIndex < inheritedLockIndex,
    "DATABASE_URL must normalize before lock-path filesystem access",
  );
  assert.ok(
    normalizationIndex < proofReadIndex,
    "DATABASE_URL must normalize before scope-proof filesystem access",
  );
  assert.ok(
    normalizationIndex < prismaIndex,
    "DATABASE_URL must normalize before Prisma construction",
  );
  const prismaConstructor = mainSource.slice(
    prismaIndex,
    mainSource.indexOf("await prisma.$connect()", prismaIndex),
  );
  assert.match(
    prismaConstructor,
    new RegExp(
      `datasources:\\s*\\{\\s*db:\\s*\\{\\s*url:\\s*${normalization.groups.normalized}\\s*\\}`,
    ),
  );
  assert.doesNotMatch(
    prismaConstructor,
    new RegExp(`url:\\s*${normalization.groups.raw}\\b`),
  );
});

test("DATABASE_URL normalization preserves safe raw bytes and canonicalizes connection_limit", () => {
  const cases = [
    {
      name: "appends the canonical parameter",
      raw: (path) => `file:${path}`,
      expected: (path) => `file:${path}?connection_limit=1`,
    },
    {
      name: "preserves unrelated segments and their order",
      raw: (path) =>
        `file:${path}?socket_timeout=13&connection_limit=8&mode=rwc%2Fsafe`,
      expected: (path) =>
        `file:${path}?socket_timeout=13&mode=rwc%2Fsafe&connection_limit=1`,
    },
    {
      name: "collapses literal and percent-decoded target entries",
      raw: (path) =>
        `file:${path}?connection_limit=9&cache=shared&connection%5Flimit=4`,
      expected: (path) => `file:${path}?cache=shared&connection_limit=1`,
    },
    {
      name: "does not decode or rewrite path and safe query bytes",
      raw: (path) => `file:${path}%2Fraw%20name.db?label=keep%2Fraw%20bytes`,
      expected: (path) =>
        `file:${path}%2Fraw%20name.db?label=keep%2Fraw%20bytes&connection_limit=1`,
    },
  ];

  for (const scenario of cases) {
    const directory = temporaryDirectory();
    const proof = join(directory, "valid-proof.json");
    const manifest = join(directory, "must-not-exist.json");
    writePrivateJson(proof, scopeProof());
    const probe = prismaConstructorProbe(directory);
    const args = [
      "--dry-run",
      "--scope-proof",
      proof,
      "--scope-proof-hash",
      sha256(proof),
      "--manifest",
      manifest,
    ];
    const rawPath = join(directory, "fixture.db");

    const result = runRepairWithDatabaseUrl(
      directory,
      scenario.raw(rawPath),
      args,
      probe.env,
    );

    requireFailure(result);
    assert.equal(
      result.stderr,
      "legacy FK recovery failed: safety check failed\n",
      scenario.name,
    );
    assert.equal(
      JSON.parse(readFileSync(probe.capture, "utf8")),
      scenario.expected(rawPath),
      scenario.name,
    );
    assert.equal(existsSync(manifest), false, scenario.name);
  }
});

test("invalid DATABASE_URL values fail before Prisma, database, or manifest access", () => {
  const cases = [
    ["empty", () => ""],
    ["non-file", (path) => `sqlite:${path}`],
    ["empty path", () => "file:"],
    ["empty path with query", () => "file:?mode=ro"],
    ["fragment", (path) => `file:${path}#fragment`],
    ["malformed path escape", (path) => `file:${path}%`],
    ["malformed query escape", (path) => `file:${path}?mode=%GG`],
    ["raw path control", (path) => `file:${path}\n`],
    ["decoded path control", (path) => `file:${path}%00`],
    ["raw query control", (path) => `file:${path}?mode=ro\tunsafe`],
    ["decoded query control", (path) => `file:${path}?mode=%0A`],
    ["decoded key control", (path) => `file:${path}?mo%0Ade=ro`],
    ["decoded DEL control", (path) => `file:${path}?mode=%7F`],
    ["empty query", (path) => `file:${path}?`],
    ["leading empty segment", (path) => `file:${path}?&mode=ro`],
    ["middle empty segment", (path) => `file:${path}?mode=ro&&cache=x`],
    ["trailing empty segment", (path) => `file:${path}?mode=ro&`],
    ["empty key", (path) => `file:${path}?=value`],
    ["missing equals", (path) => `file:${path}?mode`],
    ["duplicate key", (path) => `file:${path}?mode=ro&mode=rw`],
    ["duplicate decoded key", (path) => `file:${path}?mode=ro&mo%64e=rw`],
    ["case-variant target", (path) => `file:${path}?Connection_Limit=8`],
    [
      "encoded case-variant target",
      (path) => `file:${path}?Connection%5FLimit=8`,
    ],
  ];

  for (const [name, databaseUrl] of cases) {
    const directory = temporaryDirectory();
    const database = join(directory, "must-not-open.db");
    const proof = join(directory, "valid-proof.json");
    const manifest = join(directory, "must-not-create.json");
    writePrivateJson(proof, scopeProof());
    const probe = prismaConstructorProbe(directory);
    const result = runRepairWithDatabaseUrl(
      directory,
      databaseUrl(database),
      [
        "--dry-run",
        "--scope-proof",
        proof,
        "--scope-proof-hash",
        sha256(proof),
        "--manifest",
        manifest,
      ],
      probe.env,
    );

    requireFailure(result);
    assert.equal(
      result.stderr,
      "legacy FK recovery failed: safety check failed\n",
      name,
    );
    assert.equal(existsSync(probe.capture), false, `${name}: Prisma opened`);
    assert.equal(existsSync(database), false, `${name}: database opened`);
    assert.equal(existsSync(manifest), false, `${name}: manifest created`);
  }
});

test("runbooks pin the trusted-root gate and single-connection URL requirement", () => {
  for (const source of [LEGACY_RUNBOOK_SOURCE, QUIESCE_README_SOURCE]) {
    assert.match(source, /legacy-fk-32-2026-10/);
    assert.match(source, /2\/28\/4\/32/);
    assert.match(source, /trusted root|trusted-root/i);
    assert.match(source, /connection_limit=1/);
  }
  assert.match(
    LEGACY_RUNBOOK_SOURCE,
    /do \*\*not\*\* authenticate\s+watchdog ancestry/,
  );
  assert.match(LEGACY_RUNBOOK_SOURCE, /not a non-bypassable security boundary/);
  assert.match(LEGACY_RUNBOOK_SOURCE, /authoritative historical source/);
  assert.match(LEGACY_RUNBOOK_SOURCE, /not\s+cryptographically authenticated/);
});

test("Linux harness and production probe require the inherited fd9 lock", () => {
  const args = ["--dry-run", "--manifest", "synthetic"];
  const isolatedDatabase = join(ROOT, "isolated-fixture", "fixture.db");
  const adversarialUrl = recoveryDatabaseUrl(isolatedDatabase);
  assert.equal(
    adversarialUrl,
    `file:${isolatedDatabase}?socket_timeout=13&connection_limit=8`,
  );
  assert.doesNotMatch(
    adversarialUrl,
    /connection_limit=1(?:&|$)/,
    "the test harness must not perform production normalization",
  );
  assert.match(
    SCRIPT_SOURCE,
    /const inherited = spawnSync\("flock", \["-n", "9"\], \{ stdio \}\);/,
    "the production continuity probe must use util-linux inherited-fd mode",
  );
  assert.doesNotMatch(
    SCRIPT_SOURCE,
    /spawnSync\("flock", \["-n", "9",/,
    "a command after fd 9 changes util-linux flock to pathname mode",
  );
  assert.deepEqual(repairCommand(args, "linux"), {
    executable: "sh",
    args: [
      "-c",
      'flock -x 9 || exit $?; exec "$@"',
      "repair-test-lock",
      process.execPath,
      SCRIPT,
      ...args,
    ],
  });
  assert.equal(
    repairWorkingDirectory(isolatedDatabase),
    join(ROOT, "isolated-fixture"),
  );
  assert.notEqual(repairWorkingDirectory(isolatedDatabase), ROOT);
  assert.deepEqual(repairCommand(args, "darwin"), {
    executable: process.execPath,
    args: [SCRIPT, ...args],
  });

  if (process.platform === "linux") {
    const directory = temporaryDirectory();
    const database = join(directory, "fixture.db");
    const lockPath = join(directory, ".test-quiesce", "lock");
    const probe = join(directory, "lock-probe.mjs");
    writeFileSync(
      probe,
      `import { fstatSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
const inherited = fstatSync(9);
const expected = statSync(process.env.EXPECTED_LOCK_PATH);
const capability = fstatSync(7);
const competing = spawnSync("flock", ["-n", process.env.EXPECTED_LOCK_PATH, "true"]);
if (process.cwd() !== process.env.EXPECTED_CWD ||
    inherited.dev !== expected.dev || inherited.ino !== expected.ino ||
    capability.nlink !== 0 || competing.status === 0) process.exit(1);
process.stdout.write("inherited lock held\\n");
`,
      { mode: 0o600 },
    );
    const lock = inheritedTestLock(directory);
    const command = repairCommand([], "linux", probe);
    try {
      const result = spawnSync(command.executable, command.args, {
        cwd: repairWorkingDirectory(database),
        encoding: "utf8",
        stdio: lock.stdio,
        env: {
          ...process.env,
          ...lock.env,
          EXPECTED_CWD: directory,
          EXPECTED_LOCK_PATH: lockPath,
        },
      });
      assert.equal(
        result.status,
        0,
        `Linux lock probe failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.equal(result.stdout, "inherited lock held\n");
    } finally {
      lock.close();
    }

    for (const scenario of [
      { name: "unlocked", fd9: "lock" },
      { name: "wrong", fd9: "wrong-lock" },
      { name: "missing", fd9: null },
      { name: "contended-unlocked", fd9: "lock", contend: true },
    ]) {
      const scenarioDirectory = temporaryDirectory();
      const quiesceDirectory = join(scenarioDirectory, ".test-quiesce");
      const lockPath = join(quiesceDirectory, "lock");
      const proof = join(scenarioDirectory, "scope-proof.json");
      const manifest = join(scenarioDirectory, "manifest.json");
      const database = join(scenarioDirectory, "must-not-open.db");
      mkdirSync(quiesceDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(lockPath, "", { mode: 0o600 });
      writePrivateJson(proof, scopeProof());

      const capabilityPath = join(quiesceDirectory, "capability");
      writeFileSync(capabilityPath, "test-only inherited capability\n", {
        mode: 0o600,
      });
      const capabilityFd = openSync(capabilityPath, "r");
      unlinkSync(capabilityPath);
      const lockFd =
        scenario.fd9 === null
          ? null
          : openSync(join(quiesceDirectory, scenario.fd9), "a", 0o600);
      const stdio = Array.from(
        { length: scenario.fd9 === null ? 8 : 10 },
        () => "ignore",
      );
      stdio[1] = "pipe";
      stdio[2] = "pipe";
      stdio[7] = capabilityFd;
      if (lockFd !== null) stdio[9] = lockFd;

      const repairArgs = [
        SCRIPT,
        "--dry-run",
        "--scope-proof",
        proof,
        "--scope-proof-hash",
        sha256(proof),
        "--manifest",
        manifest,
      ];
      const executable = scenario.contend ? "sh" : process.execPath;
      const executableArgs = scenario.contend
        ? [
            "-c",
            'exec 8>"$QUIESCE_DIR/lock"; flock -x 8 || exit $?; exec 9>"$QUIESCE_DIR/lock"; exec "$@"',
            "repair-contended-lock",
            process.execPath,
            ...repairArgs,
          ]
        : repairArgs;

      try {
        const result = spawnSync(executable, executableArgs, {
          cwd: scenarioDirectory,
          encoding: "utf8",
          stdio,
          env: {
            ...process.env,
            DATABASE_URL: `file:${database}`,
            LEGACY_FK_RECOVERY_OP_WRAP: "legacy-fk-integrity-v1",
            LEGACY_FK_RECOVERY_LOCK_FD: "9",
            LEGACY_FK_RECOVERY_CAP_FD: "7",
            QUIESCE_DIR: quiesceDirectory,
          },
        });
        requireFailure(result);
        assert.equal(
          result.stderr,
          "legacy FK recovery failed: safety check failed\n",
          `${scenario.name} fd must retain the generic public error`,
        );
        assert.equal(
          existsSync(database),
          false,
          `${scenario.name} fd opened SQLite`,
        );
        assert.equal(existsSync(manifest), false);
        assert.equal(
          existsSync(join(scenarioDirectory, "9")),
          false,
          `${scenario.name} fd fell back to pathname mode`,
        );
      } finally {
        if (lockFd !== null) closeSync(lockFd);
        closeSync(capabilityFd);
      }
    }
  }
});

test("the executable keeps exact topology and an explicit preimage-hash gate without embedded row IDs", () => {
  assert.match(
    SCRIPT_SOURCE,
    /const EXPECTED_MISSING_PROJECTS = 2;[\s\S]*const EXPECTED_ORPHAN_ROOMS = 28;[\s\S]*const EXPECTED_ORPHAN_CASH_FLOW_ENTRIES = 4;[\s\S]*const EXPECTED_FOREIGN_KEY_VIOLATIONS = 32;/,
  );
  assert.match(
    SCRIPT_SOURCE,
    /stateHash\(\{ state, inventory \}\) !== manifest\.beforeHash \|\|[\s\S]{0,160}stateHash\(protectedFinancialState\(state\)\) !== manifest\.financialHash/,
  );
  for (const fixtureIdentity of PRIVATE_VALUES) {
    assert.doesNotMatch(SCRIPT_SOURCE, new RegExp(fixtureIdentity));
  }
});

test("apply inserts two tombstones, nulls four expense FKs only, and is exactly idempotent", () => {
  const fixture = createFixture();
  const cashBefore = cashFlowSnapshot(fixture.database);
  const manifest = dryRun(fixture);

  const result = runRepair(fixture.database, applyArgs(fixture));

  requireSuccess(result);
  assert.equal(foreignKeyViolations(fixture.database).length, 0);
  assert.equal(
    sqlite(fixture.database, "PRAGMA integrity_check;").trim(),
    "ok",
  );
  const projects = JSON.parse(
    sqlite(
      fixture.database,
      `
        SELECT id, tenant_id, type, name, description, created_by_user_id,
               start_date, end_date, created_at, updated_at, deleted_at,
               onboarded_at
          FROM projects
         WHERE id IN (${quote(PROJECT_A)}, ${quote(PROJECT_B)})
         ORDER BY id;
      `,
      ["-json"],
    ),
  );
  assert.deepEqual(projects, [
    {
      id: PROJECT_A,
      tenant_id: TENANT_A,
      type: "REFORMA",
      name: "__legacy_fk_recovery_tombstone__",
      description: "Technical tombstone created by #722",
      created_by_user_id: null,
      start_date: null,
      end_date: null,
      created_at: 0,
      updated_at: 0,
      deleted_at: 0,
      onboarded_at: null,
    },
    {
      id: PROJECT_B,
      tenant_id: TENANT_B,
      type: "REFORMA",
      name: "__legacy_fk_recovery_tombstone__",
      description: "Technical tombstone created by #722",
      created_by_user_id: null,
      start_date: null,
      end_date: null,
      created_at: 0,
      updated_at: 0,
      deleted_at: 0,
      onboarded_at: null,
    },
  ]);

  const cashAfter = cashFlowSnapshot(fixture.database);
  assert.deepEqual(
    cashAfter.map((row) => ({
      ...row,
      expense_id: cashBefore.find((old) => old.id === row.id).expense_id,
    })),
    cashBefore,
  );
  assert.ok(cashAfter.every((row) => row.expense_id === null));
  assert.match(manifest.beforeHash, /^[a-f0-9]{64}$/);
  assert.match(manifest.postHash, /^[a-f0-9]{64}$/);
  assert.notEqual(manifest.beforeHash, manifest.postHash);
  assert.match(manifest.financialHash, /^[a-f0-9]{64}$/);
  assert.match(result.stdout, /"insertedProjects":2/);
  assert.match(result.stdout, /"updatedCashFlowEntries":4/);

  const postimage = snapshot(fixture.database);
  const second = runRepair(fixture.database, applyArgs(fixture));
  requireSuccess(second);
  assert.equal(snapshot(fixture.database), postimage);
  assert.match(second.stdout, /"insertedProjects":0/);
  assert.match(second.stdout, /"updatedCashFlowEntries":0/);

  sqlite(
    fixture.database,
    `
      CREATE TRIGGER reject_second_project_insert
      BEFORE INSERT ON projects
      BEGIN SELECT RAISE(ABORT, 'second project insert attempted'); END;
      CREATE TRIGGER reject_second_cash_update
      BEFORE UPDATE OF expense_id ON cash_flow_entries
      BEGIN SELECT RAISE(ABORT, 'second cash update attempted'); END;
    `,
  );
  const protectedSecond = runRepair(fixture.database, applyArgs(fixture));
  requireFailure(protectedSecond);
  assert.equal(snapshot(fixture.database), postimage);
});

test("hash, mode, expected counts, and symlinks all fail closed", () => {
  {
    const fixture = createFixture();
    const before = snapshot(fixture.database);
    requireFailure(
      runRepair(fixture.database, dryRunArgs(fixture), {
        LEGACY_FK_RECOVERY_OP_WRAP: "",
      }),
    );
    assert.equal(snapshot(fixture.database), before);
    assert.throws(() => statSync(fixture.manifest));
  }

  const scenarios = [
    (fixture) => {
      const args = dryRunArgs(fixture);
      args[args.indexOf("--scope-proof-hash") + 1] = "0".repeat(64);
      return args;
    },
    (fixture) => {
      chmodSync(fixture.proof, 0o640);
      return dryRunArgs(fixture);
    },
    (fixture) => {
      const target = join(fixture.directory, "proof-target.json");
      unlinkSync(fixture.proof);
      writePrivateJson(target, scopeProof());
      symlinkSync(target, fixture.proof);
      assert.ok(lstatSync(fixture.proof).isSymbolicLink());
      return dryRunArgs(fixture);
    },
  ];
  for (const scenario of scenarios) {
    const fixture = createFixture();
    const before = snapshot(fixture.database);
    requireFailure(runRepair(fixture.database, scenario(fixture)));
    assert.equal(snapshot(fixture.database), before);
    assert.throws(() => statSync(fixture.manifest));
  }

  {
    const fixture = createFixture();
    const before = snapshot(fixture.database);
    writePrivateJson(fixture.manifest, { sentinel: "must-not-be-replaced" });
    const oldManifest = readFileSync(fixture.manifest);
    requireFailure(runRepair(fixture.database, dryRunArgs(fixture)));
    assert.equal(snapshot(fixture.database), before);
    assert.deepEqual(readFileSync(fixture.manifest), oldManifest);
  }

  for (const overrides of [
    { manifestHash: "0".repeat(64) },
    { projects: 1 },
    { rooms: 27 },
    { cashFlowEntries: 3 },
  ]) {
    const fixture = createFixture();
    dryRun(fixture);
    const before = snapshot(fixture.database);
    requireFailure(runRepair(fixture.database, applyArgs(fixture, overrides)));
    assert.equal(snapshot(fixture.database), before);
  }

  {
    const fixture = createFixture();
    dryRun(fixture);
    chmodSync(fixture.manifest, 0o640);
    requireFailure(runRepair(fixture.database, applyArgs(fixture)));
  }
  {
    const fixture = createFixture();
    dryRun(fixture);
    const target = join(fixture.directory, "manifest-target.json");
    copyFileSync(fixture.manifest, target);
    chmodSync(target, 0o600);
    unlinkSync(fixture.manifest);
    symlinkSync(target, fixture.manifest);
    requireFailure(runRepair(fixture.database, applyArgs(fixture)));
  }
  {
    const fixture = createFixture();
    const manifest = dryRun(fixture);
    manifest.beforeHash = "0".repeat(64);
    unlinkSync(fixture.manifest);
    writePrivateJson(fixture.manifest, manifest);
    const before = snapshot(fixture.database);
    requireFailure(
      runRepair(
        fixture.database,
        applyArgs(fixture, { manifestHash: sha256(fixture.manifest) }),
      ),
    );
    assert.equal(snapshot(fixture.database), before);
  }
});

test("restricted scope requires hashed provenance and two distinct reviewer attestations", () => {
  const mutateProof = [
    (proof) => {
      delete proof.provenance;
    },
    (proof) => {
      proof.provenance.scopeSha256 = "0".repeat(64);
    },
    (proof) => {
      proof.provenance.attestations.pop();
    },
    (proof) => {
      proof.provenance.attestations[1].reviewer =
        proof.provenance.attestations[0].reviewer;
    },
    (proof) => {
      proof.provenance.attestations[1].attestationSha256 =
        proof.provenance.attestations[0].attestationSha256;
    },
  ];

  for (const mutate of mutateProof) {
    const fixture = createFixture();
    const proof = scopeProof();
    mutate(proof);
    unlinkSync(fixture.proof);
    writePrivateJson(fixture.proof, proof);
    const before = snapshot(fixture.database);
    requireFailure(runRepair(fixture.database, dryRunArgs(fixture)));
    assert.equal(snapshot(fixture.database), before);
    assert.equal(existsSync(fixture.manifest), false);
  }
});

test("a static op-wrap marker without the inherited watchdog lock fails before opening SQLite", () => {
  const directory = temporaryDirectory();
  const database = join(directory, "must-not-open.db");
  const proof = join(directory, "scope-proof.json");
  const manifest = join(directory, "manifest.json");
  writePrivateJson(proof, scopeProof());

  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--dry-run",
      "--scope-proof",
      proof,
      "--scope-proof-hash",
      sha256(proof),
      "--manifest",
      manifest,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: `file:${database}`,
        LEGACY_FK_RECOVERY_OP_WRAP: "legacy-fk-integrity-v1",
      },
    },
  );

  requireFailure(result);
  assert.equal(existsSync(database), false);
  assert.equal(existsSync(manifest), false);
});

test("op-wrap rejects malicious and non-generated manifest pointer basenames", () => {
  const directory = temporaryDirectory();
  const scopeHash = "a".repeat(64);
  const manifestHash = "b".repeat(64);
  writeFileSync(join(directory, "deadline"), `${Date.now()}\n`, {
    mode: 0o600,
  });
  writeFileSync(join(directory, "fk-scope-proof.json"), "{}\n", {
    mode: 0o600,
  });

  for (const basename of [
    "fk-manifest.test.json",
    "fk-manifest.20261012T191218Z.7.json'$(touch forged)'.json",
    "fk-manifest.20261012T191218Z.7.json;echo-forged.json",
    "fk-manifest.20261012T191218Z.7.json\nforged.json",
    "../fk-manifest.20261012T191218Z.7.json",
  ]) {
    const pointer = join(directory, "fk-manifest.current");
    writeFileSync(pointer, `${basename}\n`, { mode: 0o600 });
    if (!basename.includes("/") && !basename.includes("\n")) {
      writeFileSync(join(directory, basename), "{}\n", { mode: 0o600 });
    }
    const result = spawnSync(
      "sh",
      [OP_WRAP, "fk-apply", manifestHash, scopeHash],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, QUIESCE_DIR: directory },
      },
    );
    assert.notEqual(result.status, 0, `accepted unsafe basename: ${basename}`);
    assert.equal(existsSync(join(directory, "RUN")), false);
    rmSync(pointer, { force: true });
  }

  for (const basename of [
    "manifest.test.json",
    "manifest.20261012T191218Z.7.json'$(touch forged)'.json",
    "manifest.20261012T191218Z.7.json;echo-forged.json",
    "manifest.20261012T191218Z.7.json\nforged.json",
    "../manifest.20261012T191218Z.7.json",
  ]) {
    const pointer = join(directory, "manifest.current");
    writeFileSync(pointer, `${basename}\n`, { mode: 0o600 });
    if (!basename.includes("/") && !basename.includes("\n")) {
      writeFileSync(join(directory, basename), "{}\n", { mode: 0o600 });
    }
    const result = spawnSync("sh", [OP_WRAP, "apply", manifestHash, "1", "1"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, QUIESCE_DIR: directory },
    });
    assert.notEqual(result.status, 0, `accepted unsafe basename: ${basename}`);
    assert.equal(existsSync(join(directory, "RUN")), false);
    rmSync(pointer, { force: true });
  }
});

test("scope, topology, dependency, and post-dry-run drift abort without repair writes", () => {
  {
    const fixture = createFixture();
    const wrongTenantProof = scopeProof();
    wrongTenantProof.orphanCashFlowEntries[0].tenantId = TENANT_B;
    unlinkSync(fixture.proof);
    writePrivateJson(fixture.proof, wrongTenantProof);
    const before = snapshot(fixture.database);
    requireFailure(runRepair(fixture.database, dryRunArgs(fixture)));
    assert.equal(snapshot(fixture.database), before);
    assert.throws(() => statSync(fixture.manifest));
  }

  const mutations = [
    `UPDATE rooms SET deleted_at = '2026-06-01' WHERE id = ${quote(ROOM_IDS_A[0])};`,
    `INSERT INTO rooms (id, project_id, name, "order", created_at, deleted_at)
       VALUES ('fixture-room-unexpected', ${quote(PROJECT_A)}, 'Unexpected', 99, '2026-06-01', NULL);`,
    `INSERT INTO expenses
       (id, project_id, tenant_id, tipo_despesa, categoria_mao_de_obra,
        room_id, valor, quantidade, valor_total, titulo, fornecedor, link,
        image_url, forma_pagamento, data_pagamento, quantidade_parcela,
        data_inicio_parcela, data_compra, status, recorrente, recorrencia_fim,
        paid_parcelas, installment_date_overrides, documented_schedule,
        planned_expense_id, settled_by_expense_id, import_id, external_id,
        recurrence_key, series_key, card_last4, bank_last4, account_id, origin,
        linked_expense_id, settles_invoice_key, dedupe_key_strong,
        dedupe_key_natural, invoice_undo_state, invoice_undo_parcela_count,
        invoice_undo_due_month, invoice_undo_card_id, invoice_undo_trail_version,
        created_at, updated_at, deleted_at)
       VALUES
       (${quote(CASH_FLOW_SCOPE[0].missingExpenseId)}, ${quote(ACTIVE_PROJECT_A)},
        ${quote(TENANT_A)}, 'OUTROS', NULL, NULL, 1, 1, 1, NULL, NULL, NULL,
        NULL, 'A_VISTA', NULL, NULL, NULL, NULL, 'PAGO', 0, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'none',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        '2026-01-01', '2026-01-01', NULL);`,
  ];
  for (const mutation of mutations) {
    const fixture = createFixture();
    sqlite(fixture.database, `PRAGMA foreign_keys = OFF; ${mutation}`);
    const before = snapshot(fixture.database);
    requireFailure(runRepair(fixture.database, dryRunArgs(fixture)));
    assert.equal(snapshot(fixture.database), before);
  }

  const fixture = createFixture();
  dryRun(fixture);
  sqlite(
    fixture.database,
    `UPDATE cash_flow_entries SET status = 'DRIFTED'
      WHERE id = ${quote(CASH_FLOW_SCOPE[3].cashFlowEntryId)};`,
  );
  const drifted = snapshot(fixture.database);
  requireFailure(runRepair(fixture.database, applyArgs(fixture)));
  assert.equal(snapshot(fixture.database), drifted);

  const postFixture = createFixture();
  dryRun(postFixture);
  requireSuccess(runRepair(postFixture.database, applyArgs(postFixture)));
  sqlite(
    postFixture.database,
    `
      INSERT INTO simulations
        (id, project_id, tenant_id, name, created_at, updated_at)
      VALUES
        ('fixture-unexpected-project-dependent', ${quote(PROJECT_A)},
         ${quote(TENANT_A)}, 'Unexpected dependency', '2026-06-01', '2026-06-01');
    `,
  );
  const postWithDependency = snapshot(postFixture.database);
  requireFailure(runRepair(postFixture.database, applyArgs(postFixture)));
  assert.equal(snapshot(postFixture.database), postWithDependency);
});

test("dry-run inventories every room backlink and rejects mismatched or unreviewed backlinks", () => {
  const knownMismatches = [
    `INSERT INTO expenses
       (id, project_id, tenant_id, tipo_despesa, room_id, valor, quantidade,
        valor_total, forma_pagamento, status, recorrente, origin, created_at,
        updated_at)
     VALUES
       ('fixture-cross-tenant-expense', ${quote(ACTIVE_PROJECT_B)},
        ${quote(TENANT_B)}, 'OUTROS', ${quote(ROOM_IDS_A[0])}, 1, 1, 1,
        'A_VISTA', 'PLANEJADO', 0, 'none', '2026-01-01', '2026-01-01');`,
    `INSERT INTO floor_plans
       (id, project_id, tenant_id, name, image_url, "order", created_at,
        updated_at, deleted_at)
     VALUES
       ('fixture-cross-tenant-plan', ${quote(ACTIVE_PROJECT_B)},
        ${quote(TENANT_B)}, 'Foreign plan', '/fixture/foreign.png', 0,
        '2026-01-01', '2026-01-01', NULL);
     INSERT INTO floor_plan_rooms
       (id, floor_plan_id, room_id, label, bounds, color, created_at, updated_at)
     VALUES
       ('fixture-cross-tenant-marker', 'fixture-cross-tenant-plan',
        ${quote(ROOM_IDS_A[0])}, 'Foreign marker', '{}', '#000000',
        '2026-01-01', '2026-01-01');`,
    `INSERT INTO pendencias
       (id, project_id, tenant_id, title, status, room_id, "order", created_at,
        updated_at, deleted_at)
     VALUES
       ('fixture-cross-tenant-pendencia', ${quote(ACTIVE_PROJECT_B)},
        ${quote(TENANT_B)}, 'Foreign task', 'PENDENTE',
        ${quote(ROOM_IDS_A[0])}, 0, '2026-01-01', '2026-01-01', NULL);`,
  ];

  for (const mutation of knownMismatches) {
    const fixture = createFixture();
    sqlite(fixture.database, mutation);
    const before = snapshot(fixture.database);
    requireFailure(runRepair(fixture.database, dryRunArgs(fixture)));
    assert.equal(snapshot(fixture.database), before);
    assert.throws(() => statSync(fixture.manifest));
  }

  {
    const fixture = createFixture();
    sqlite(
      fixture.database,
      `CREATE TABLE fixture_dynamic_room_backlink (
         id TEXT PRIMARY KEY,
         room_id TEXT REFERENCES rooms(id)
       );
       INSERT INTO fixture_dynamic_room_backlink (id, room_id)
       VALUES ('fixture-dynamic-link', ${quote(ROOM_IDS_A[0])});`,
    );
    requireFailure(runRepair(fixture.database, dryRunArgs(fixture)));
    assert.throws(() => statSync(fixture.manifest));
  }

  {
    const fixture = createFixture();
    sqlite(
      fixture.database,
      `INSERT INTO room_images
         (id, room_id, image_url, caption, "order", created_at)
       VALUES
         ('fixture-recovered-room-image', ${quote(ROOM_IDS_A[0])},
          '/fixture/recovered.jpg', NULL, 0, '2026-01-01');`,
    );
    const manifest = dryRun(fixture);
    expectBacklink(manifest, "room_images", 1);
  }
});

test("apply rejects protected-table triggers before unrelated financial fields can change", () => {
  const fixture = createFixture();
  dryRun(fixture);
  sqlite(
    fixture.database,
    `
      INSERT INTO cash_flow_entries
        (id, project_id, tenant_id, valor, tipo, data, categoria,
         forma_pagamento, status, invoice_due_month, created_at, updated_at)
      VALUES
        ('fixture-unrelated-cash', ${quote(ACTIVE_PROJECT_A)}, ${quote(TENANT_A)},
         777, 'DESPESA', '2026-07-01', 'SAFE', 'A_VISTA', 'PLANEJADO',
         '2026-07', '2026-07-01', '2026-07-01');
      INSERT INTO expenses
        (id, project_id, tenant_id, tipo_despesa, valor, quantidade,
         valor_total, forma_pagamento, status, recorrente, origin, bank_last4,
         card_last4, settles_invoice_key, created_at, updated_at)
      VALUES
        ('fixture-unrelated-expense', ${quote(ACTIVE_PROJECT_A)},
         ${quote(TENANT_A)}, 'OUTROS', 888, 1, 888, 'A_VISTA', 'PLANEJADO',
         0, 'none', '1111', '2222', '2222:2026-07', '2026-07-01',
         '2026-07-01');
      CREATE TRIGGER mutate_unrelated_financial_state
      AFTER UPDATE OF expense_id ON cash_flow_entries
      BEGIN
        UPDATE cash_flow_entries
           SET valor = 1,
               status = 'PAGO',
               data = '1999-01-01',
               forma_pagamento = 'TRIGGER',
               invoice_due_month = '1999-01'
         WHERE id = 'fixture-unrelated-cash';
        UPDATE expenses
           SET bank_last4 = '9999',
               card_last4 = '9999',
               settles_invoice_key = '9999:1999-01'
         WHERE id = 'fixture-unrelated-expense';
      END;
    `,
  );
  const before = sqlite(
    fixture.database,
    `SELECT * FROM cash_flow_entries WHERE id = 'fixture-unrelated-cash';
     SELECT * FROM expenses WHERE id = 'fixture-unrelated-expense';`,
    ["-json"],
  );

  requireFailure(runRepair(fixture.database, applyArgs(fixture)));

  assert.equal(
    sqlite(
      fixture.database,
      `SELECT * FROM cash_flow_entries WHERE id = 'fixture-unrelated-cash';
       SELECT * FROM expenses WHERE id = 'fixture-unrelated-expense';`,
      ["-json"],
    ),
    before,
  );
  assert.equal(foreignKeyViolations(fixture.database).length, 32);
});

test("a late write failure rolls the entire immediate transaction back", () => {
  const fixture = createFixture();
  dryRun(fixture);
  sqlite(
    fixture.database,
    `
      CREATE TRIGGER reject_late_fk_repair
      BEFORE UPDATE OF expense_id ON cash_flow_entries
      WHEN OLD.id = ${quote(CASH_FLOW_SCOPE[3].cashFlowEntryId)}
      BEGIN SELECT RAISE(ABORT, 'forced late failure'); END;
    `,
  );
  const before = snapshot(fixture.database);

  requireFailure(runRepair(fixture.database, applyArgs(fixture)));

  assert.equal(snapshot(fixture.database), before);
  assert.equal(foreignKeyViolations(fixture.database).length, 32);
});

test("concurrent applies serialize; exactly one repairs and the other observes the exact postimage", async () => {
  const fixture = createFixture();
  dryRun(fixture);
  const args = applyArgs(fixture);

  const results =
    process.platform === "linux"
      ? await Promise.all([
          launchRepair(fixture.database, args),
          launchRepair(fixture.database, args),
        ])
      : [
          await launchRepair(fixture.database, args),
          await launchRepair(fixture.database, args),
        ];

  for (const result of results) requireSuccess(result);
  assert.deepEqual(
    results
      .map((result) => JSON.parse(result.stdout).insertedProjects)
      .sort((a, b) => a - b),
    [0, 2],
  );
  assert.deepEqual(
    results
      .map((result) => JSON.parse(result.stdout).updatedCashFlowEntries)
      .sort((a, b) => a - b),
    [0, 4],
  );
  assert.equal(foreignKeyViolations(fixture.database).length, 0);
});

test(
  "Linux repeatedly pins internal Prisma work while two recovery processes serialize",
  { skip: process.platform !== "linux" },
  async () => {
    for (let round = 0; round < 2; round += 1) {
      const fixture = createFixture();
      dryRun(fixture);
      const results = await Promise.all([
        launchRepair(fixture.database, applyArgs(fixture)),
        launchRepair(fixture.database, applyArgs(fixture)),
      ]);

      for (const result of results) requireSuccess(result);
      assert.deepEqual(
        results
          .map((result) => JSON.parse(result.stdout).insertedProjects)
          .sort((left, right) => left - right),
        [0, 2],
      );
      assert.deepEqual(
        results
          .map((result) => JSON.parse(result.stdout).updatedCashFlowEntries)
          .sort((left, right) => left - right),
        [0, 4],
      );
      assert.equal(foreignKeyViolations(fixture.database).length, 0);
    }
  },
);
