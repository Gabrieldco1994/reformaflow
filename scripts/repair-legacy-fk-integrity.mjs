#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants, fstatSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const MANIFEST_VERSION = 1;
const EXPECTED_MISSING_PROJECTS = 2;
const EXPECTED_ORPHAN_ROOMS = 28;
const EXPECTED_ORPHAN_CASH_FLOW_ENTRIES = 4;
const EXPECTED_FOREIGN_KEY_VIOLATIONS = 32;
const TOMBSTONE_TYPE = "REFORMA";
const TOMBSTONE_NAME = "__legacy_fk_recovery_tombstone__";
const TOMBSTONE_DESCRIPTION = "Technical tombstone created by #722";
const TOMBSTONE_TIMESTAMP = new Date(0);
const OP_WRAP_MARKER = "legacy-fk-integrity-v1";
const REQUIRED_REVIEWERS = 2;
const REVIEWED_ROOM_BACKLINKS = new Map([
  ["expenses.room_id", "direct"],
  ["floor_plan_rooms.room_id", "floor-plan"],
  ["pendencias.room_id", "direct"],
  ["room_images.room_id", "room-owned"],
]);
const PROTECTED_TRIGGER_TABLES = ["cash_flow_entries", "projects"];
const CLI_OPTIONS = new Set([
  "dry-run",
  "apply",
  "scope-proof",
  "scope-proof-hash",
  "manifest",
  "hash",
  "expected-projects",
  "expected-rooms",
  "expected-cash-flow-entries",
]);

function fail() {
  throw new Error("safety check failed");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

async function assertInheritedWatchdogLock() {
  if (
    process.env.LEGACY_FK_RECOVERY_OP_WRAP !== OP_WRAP_MARKER ||
    process.env.LEGACY_FK_RECOVERY_LOCK_FD !== "9" ||
    process.env.LEGACY_FK_RECOVERY_CAP_FD !== "7" ||
    !nonEmptyString(process.env.QUIESCE_DIR) ||
    !isAbsolute(process.env.QUIESCE_DIR)
  ) {
    fail();
  }
  const quiesceDirectory = realpathSync(process.env.QUIESCE_DIR);
  const lockPath = join(quiesceDirectory, "lock");
  if (realpathSync(lockPath) !== lockPath) fail();

  const inheritedLock = fstatSync(9);
  const lockFile = statSync(lockPath);
  const capability = fstatSync(7);
  if (
    !inheritedLock.isFile() ||
    inheritedLock.dev !== lockFile.dev ||
    inheritedLock.ino !== lockFile.ino ||
    !capability.isFile() ||
    capability.nlink !== 0 ||
    (capability.mode & 0o777) !== 0o600
  ) {
    fail();
  }

  // Production is Linux. Prove both halves of lock ownership: a fresh open
  // cannot acquire Q/lock, while the inherited watchdog OFD on fd 9 can.
  if (process.platform === "linux") {
    const competing = spawnSync("flock", ["-n", lockPath, "true"], {
      stdio: "ignore",
    });
    const stdio = Array.from({ length: 10 }, () => "ignore");
    stdio[9] = 9;
    const inherited = spawnSync("flock", ["-n", "9", "true"], { stdio });
    if (competing.status === 0 || inherited.status !== 0) fail();
  }
}

function compareProject(left, right) {
  return (
    left.projectId.localeCompare(right.projectId) ||
    left.tenantId.localeCompare(right.tenantId)
  );
}

function compareCashFlow(left, right) {
  return left.cashFlowEntryId.localeCompare(right.cashFlowEntryId);
}

function validateScopeProof(proof) {
  if (
    !hasExactKeys(proof, [
      "version",
      "provenance",
      "missingProjects",
      "orphanCashFlowEntries",
    ]) ||
    proof.version !== MANIFEST_VERSION ||
    !Array.isArray(proof.missingProjects) ||
    !Array.isArray(proof.orphanCashFlowEntries) ||
    proof.missingProjects.length !== EXPECTED_MISSING_PROJECTS ||
    proof.orphanCashFlowEntries.length !== EXPECTED_ORPHAN_CASH_FLOW_ENTRIES
  ) {
    fail();
  }

  const scopeBytes = canonicalBytes({
    missingProjects: proof.missingProjects,
    orphanCashFlowEntries: proof.orphanCashFlowEntries,
  });
  if (
    !hasExactKeys(proof.provenance, [
      "sourceArtifactSha256",
      "scopeSha256",
      "generatedAt",
      "methodology",
      "attestations",
    ]) ||
    !/^[a-f0-9]{64}$/.test(proof.provenance.sourceArtifactSha256) ||
    proof.provenance.sourceArtifactSha256 === "0".repeat(64) ||
    proof.provenance.scopeSha256 !== sha256(scopeBytes) ||
    !nonEmptyString(proof.provenance.generatedAt) ||
    normalizeTimestamp(proof.provenance.generatedAt) !==
      proof.provenance.generatedAt ||
    !nonEmptyString(proof.provenance.methodology) ||
    !Array.isArray(proof.provenance.attestations) ||
    proof.provenance.attestations.length !== REQUIRED_REVIEWERS
  ) {
    fail();
  }
  const reviewers = new Set();
  const attestationHashes = new Set();
  for (const attestation of proof.provenance.attestations) {
    if (
      !hasExactKeys(attestation, [
        "reviewer",
        "scopeSha256",
        "attestationSha256",
      ]) ||
      !nonEmptyString(attestation.reviewer) ||
      attestation.scopeSha256 !== proof.provenance.scopeSha256 ||
      !/^[a-f0-9]{64}$/.test(attestation.attestationSha256) ||
      attestation.attestationSha256 === "0".repeat(64) ||
      reviewers.has(attestation.reviewer) ||
      attestationHashes.has(attestation.attestationSha256)
    ) {
      fail();
    }
    reviewers.add(attestation.reviewer);
    attestationHashes.add(attestation.attestationSha256);
  }

  const identities = new Set();
  let roomCount = 0;
  for (const project of proof.missingProjects) {
    if (
      !hasExactKeys(project, ["projectId", "tenantId", "roomIds"]) ||
      !nonEmptyString(project.projectId) ||
      !nonEmptyString(project.tenantId) ||
      !Array.isArray(project.roomIds) ||
      project.roomIds.length === 0 ||
      project.roomIds.some((id) => !nonEmptyString(id))
    ) {
      fail();
    }
    for (const identity of [
      `project:${project.projectId}`,
      ...project.roomIds.map((id) => `room:${id}`),
    ]) {
      if (identities.has(identity)) fail();
      identities.add(identity);
    }
    if (
      project.roomIds.some(
        (id, index) =>
          index > 0 && id.localeCompare(project.roomIds[index - 1]) <= 0,
      )
    ) {
      fail();
    }
    roomCount += project.roomIds.length;
  }
  if (
    roomCount !== EXPECTED_ORPHAN_ROOMS ||
    proof.missingProjects.some(
      (project, index) =>
        index > 0 &&
        compareProject(project, proof.missingProjects[index - 1]) <= 0,
    )
  ) {
    fail();
  }

  for (const row of proof.orphanCashFlowEntries) {
    if (
      !hasExactKeys(row, [
        "cashFlowEntryId",
        "missingExpenseId",
        "tenantId",
        "projectId",
      ]) ||
      ![
        row.cashFlowEntryId,
        row.missingExpenseId,
        row.tenantId,
        row.projectId,
      ].every(nonEmptyString)
    ) {
      fail();
    }
    for (const identity of [
      `cash:${row.cashFlowEntryId}`,
      `expense:${row.missingExpenseId}`,
    ]) {
      if (identities.has(identity)) fail();
      identities.add(identity);
    }
  }
  if (
    proof.orphanCashFlowEntries.some(
      (row, index) =>
        index > 0 &&
        compareCashFlow(row, proof.orphanCashFlowEntries[index - 1]) <= 0,
    )
  ) {
    fail();
  }
}

async function readPrivateCanonicalJson(path, expectedHash) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) fail();
    const bytes = await handle.readFile();
    if (sha256(bytes) !== expectedHash) fail();
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail();
    }
    if (!canonicalBytes(value).equals(bytes)) fail();
    return { bytes, value };
  } finally {
    await handle.close();
  }
}

function normalizeTimestamp(value, nullable = false) {
  if (value === null && nullable) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "bigint" || typeof value === "number") {
    const date = new Date(Number(value));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const numeric = /^[0-9]+$/.test(value) ? Number(value) : value;
    const date = new Date(numeric);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  fail();
}

function normalizeScalar(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { bytes: value.toString("base64") };
  fail();
}

function normalizeObject(row) {
  return Object.fromEntries(
    Object.keys(row)
      .sort()
      .map((key) => [key, normalizeScalar(row[key])]),
  );
}

function normalizeRoom(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    order: Number(row.order),
    createdAt: normalizeTimestamp(row.created_at),
    deletedAt: normalizeTimestamp(row.deleted_at, true),
  };
}

function normalizeProject(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    createdByUserId: row.created_by_user_id,
    type: row.type,
    name: row.name,
    description: row.description,
    startDate: normalizeTimestamp(row.start_date, true),
    endDate: normalizeTimestamp(row.end_date, true),
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
    deletedAt: normalizeTimestamp(row.deleted_at, true),
    onboardedAt: normalizeTimestamp(row.onboarded_at, true),
  };
}

function expectedTombstone(project) {
  return {
    id: project.projectId,
    tenantId: project.tenantId,
    createdByUserId: null,
    type: TOMBSTONE_TYPE,
    name: TOMBSTONE_NAME,
    description: TOMBSTONE_DESCRIPTION,
    startDate: null,
    endDate: null,
    createdAt: TOMBSTONE_TIMESTAMP.toISOString(),
    updatedAt: TOMBSTONE_TIMESTAMP.toISOString(),
    deletedAt: TOMBSTONE_TIMESTAMP.toISOString(),
    onboardedAt: null,
  };
}

async function placeholdersQuery(prisma, prefix, values, suffix = "") {
  if (values.length === 0) fail();
  return prisma.$queryRawUnsafe(
    `${prefix}${values.map(() => "?").join(", ")}${suffix}`,
    ...values,
  );
}

async function readAffectedState(prisma, proof) {
  const projectIds = proof.missingProjects.map(({ projectId }) => projectId);
  const roomIds = proof.missingProjects.flatMap(({ roomIds }) => roomIds);
  const cashIds = proof.orphanCashFlowEntries.map(
    ({ cashFlowEntryId }) => cashFlowEntryId,
  );

  const projects = await placeholdersQuery(
    prisma,
    `SELECT id, tenant_id, created_by_user_id, type, name, description,
            start_date, end_date, created_at, updated_at, deleted_at, onboarded_at
       FROM projects
      WHERE id IN (`,
    projectIds,
    ") ORDER BY id",
  );
  const rooms = await placeholdersQuery(
    prisma,
    `SELECT id, project_id, name, "order", created_at, deleted_at
       FROM rooms
      WHERE id IN (`,
    roomIds,
    ") ORDER BY id",
  );
  const cash = await placeholdersQuery(
    prisma,
    `SELECT *
       FROM cash_flow_entries
      WHERE id IN (`,
    cashIds,
    ") ORDER BY id",
  );
  return {
    projects: projects.map(normalizeProject),
    rooms: rooms.map(normalizeRoom),
    cash: cash.map(normalizeObject),
  };
}

function stateHash(state) {
  return sha256(canonicalBytes(state));
}

function protectedFinancialState(state) {
  return {
    rooms: state.rooms,
    cash: state.cash.map(({ expense_id: _allowedMutation, ...row }) => row),
  };
}

function expectedPostState(preState, proof) {
  const missingByCashId = new Set(
    proof.orphanCashFlowEntries.map(({ cashFlowEntryId }) => cashFlowEntryId),
  );
  return {
    projects: proof.missingProjects
      .map(expectedTombstone)
      .sort((left, right) => left.id.localeCompare(right.id)),
    rooms: preState.rooms,
    cash: preState.cash.map((row) =>
      missingByCashId.has(row.id) ? { ...row, expense_id: null } : row,
    ),
  };
}

function expectedRoomMap(proof) {
  return new Map(
    proof.missingProjects.flatMap((project) =>
      project.roomIds.map((roomId) => [roomId, project.projectId]),
    ),
  );
}

function rowsMatchProof(state, proof) {
  const rooms = expectedRoomMap(proof);
  if (
    state.rooms.length !== EXPECTED_ORPHAN_ROOMS ||
    state.cash.length !== EXPECTED_ORPHAN_CASH_FLOW_ENTRIES
  ) {
    return false;
  }
  for (const room of state.rooms) {
    if (rooms.get(room.id) !== room.projectId || room.deletedAt !== null) {
      return false;
    }
  }
  const cashById = new Map(state.cash.map((row) => [row.id, row]));
  for (const expected of proof.orphanCashFlowEntries) {
    const row = cashById.get(expected.cashFlowEntryId);
    if (
      !row ||
      row.tenant_id !== expected.tenantId ||
      row.project_id !== expected.projectId ||
      row.deleted_at === null
    ) {
      return false;
    }
  }
  return true;
}

function isPreimage(state, proof) {
  if (state.projects.length !== 0 || !rowsMatchProof(state, proof))
    return false;
  const cashById = new Map(state.cash.map((row) => [row.id, row]));
  return proof.orphanCashFlowEntries.every(
    (expected) =>
      cashById.get(expected.cashFlowEntryId)?.expense_id ===
      expected.missingExpenseId,
  );
}

function isPostimage(state, proof) {
  if (!rowsMatchProof(state, proof)) return false;
  const expectedProjects = proof.missingProjects
    .map(expectedTombstone)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    canonicalBytes(state.projects).compare(canonicalBytes(expectedProjects)) !==
    0
  ) {
    return false;
  }
  return state.cash.every((row) => row.expense_id === null);
}

async function pragmaForeignKeyCheck(prisma) {
  return prisma.$queryRawUnsafe("PRAGMA foreign_key_check");
}

function quoteIdentifier(value) {
  if (!nonEmptyString(value)) fail();
  return `"${value.replaceAll('"', '""')}"`;
}

function compareBacklink(left, right) {
  return (
    left.table.localeCompare(right.table) ||
    left.column.localeCompare(right.column)
  );
}

async function readRoomBacklinkInventory(prisma, proof) {
  const roomScope = new Map(
    proof.missingProjects.flatMap(({ projectId, tenantId, roomIds }) =>
      roomIds.map((roomId) => [roomId, { projectId, tenantId }]),
    ),
  );
  const roomIds = [...roomScope.keys()];
  const tables = await prisma.$queryRawUnsafe(
    `SELECT name
       FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name`,
  );
  const discovered = [];
  for (const { name } of tables) {
    const table = quoteIdentifier(name);
    const foreignKeys = await prisma.$queryRawUnsafe(
      `PRAGMA foreign_key_list(${table})`,
    );
    for (const foreignKey of foreignKeys) {
      if (foreignKey.table === "rooms" && foreignKey.to === "id") {
        discovered.push({
          table: name,
          column: foreignKey.from,
          onUpdate: foreignKey.on_update,
          onDelete: foreignKey.on_delete,
        });
      }
    }
  }
  discovered.sort(compareBacklink);

  const knownKeys = new Set(
    discovered.map(({ table, column }) => `${table}.${column}`),
  );
  if ([...REVIEWED_ROOM_BACKLINKS.keys()].some((key) => !knownKeys.has(key))) {
    fail();
  }

  const inventory = [];
  for (const foreignKey of discovered) {
    const key = `${foreignKey.table}.${foreignKey.column}`;
    const strategy = REVIEWED_ROOM_BACKLINKS.get(key);
    const table = quoteIdentifier(foreignKey.table);
    const column = quoteIdentifier(foreignKey.column);
    let rows;
    if (strategy === "floor-plan") {
      rows = await placeholdersQuery(
        prisma,
        `SELECT child.id, child.room_id,
                owner.project_id AS __scope_project_id,
                owner.tenant_id AS __scope_tenant_id
           FROM ${table} child
           JOIN floor_plans owner ON owner.id = child.floor_plan_id
          WHERE child.${column} IN (`,
        roomIds,
        `) ORDER BY child.id`,
      );
    } else if (strategy === "direct") {
      rows = await placeholdersQuery(
        prisma,
        `SELECT id, ${column}, project_id, tenant_id
           FROM ${table}
          WHERE ${column} IN (`,
        roomIds,
        `) ORDER BY ${column}, id`,
      );
    } else {
      rows = await placeholdersQuery(
        prisma,
        `SELECT rowid AS __rowid, ${column}
           FROM ${table}
          WHERE ${column} IN (`,
        roomIds,
        `) ORDER BY ${column}, rowid`,
      );
    }

    if (!REVIEWED_ROOM_BACKLINKS.has(key) && rows.length > 0) fail();
    for (const row of rows) {
      const expected = roomScope.get(row[foreignKey.column]);
      if (!expected) fail();
      if (
        strategy === "direct" &&
        (row.project_id !== expected.projectId ||
          row.tenant_id !== expected.tenantId)
      ) {
        fail();
      }
      if (
        strategy === "floor-plan" &&
        (row.__scope_project_id !== expected.projectId ||
          row.__scope_tenant_id !== expected.tenantId)
      ) {
        fail();
      }
    }
    inventory.push({
      table: foreignKey.table,
      column: foreignKey.column,
      count: rows.length,
      rowsHash: sha256(canonicalBytes(rows.map(normalizeObject))),
    });
  }
  return inventory;
}

async function readProtectedTriggerInventory(prisma) {
  const triggers = await placeholdersQuery(
    prisma,
    `SELECT name, tbl_name, sql
       FROM sqlite_master
      WHERE type = 'trigger'
        AND tbl_name IN (`,
    PROTECTED_TRIGGER_TABLES,
    `) ORDER BY tbl_name, name`,
  );
  if (triggers.length !== 0) fail();
  return triggers.map(normalizeObject);
}

async function readSecurityInventory(prisma, proof) {
  const roomBacklinks = await readRoomBacklinkInventory(prisma, proof);
  const protectedTriggers = await readProtectedTriggerInventory(prisma);
  return {
    roomBacklinks,
    protectedTriggers,
    inventoryHash: sha256(canonicalBytes({ roomBacklinks, protectedTriggers })),
  };
}

async function assertExactProjectDependencies(prisma, proof) {
  const projectIds = proof.missingProjects.map(({ projectId }) => projectId);
  const expectedRooms = expectedRoomMap(proof);
  const scopedRooms = await placeholdersQuery(
    prisma,
    `SELECT id, project_id, deleted_at
       FROM rooms
      WHERE project_id IN (`,
    projectIds,
    ") ORDER BY id",
  );
  if (
    scopedRooms.length !== EXPECTED_ORPHAN_ROOMS ||
    scopedRooms.some(
      (row) =>
        expectedRooms.get(row.id) !== row.project_id || row.deleted_at !== null,
    )
  ) {
    fail();
  }

  const tables = await prisma.$queryRawUnsafe(
    `SELECT name
       FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name`,
  );
  for (const { name } of tables) {
    const table = quoteIdentifier(name);
    const foreignKeys = await prisma.$queryRawUnsafe(
      `PRAGMA foreign_key_list(${table})`,
    );
    for (const foreignKey of foreignKeys) {
      if (foreignKey.table !== "projects" || foreignKey.to !== "id") continue;
      if (name === "rooms" && foreignKey.from === "project_id") continue;
      const column = quoteIdentifier(foreignKey.from);
      const dependencies = await placeholdersQuery(
        prisma,
        `SELECT COUNT(*) AS count
           FROM ${table}
          WHERE ${column} IN (`,
        projectIds,
        ")",
      );
      if (Number(dependencies[0]?.count) !== 0) fail();
    }
  }
}

async function assertIntegrity(prisma) {
  const rows = await prisma.$queryRawUnsafe("PRAGMA integrity_check");
  if (
    rows.length !== 1 ||
    String(Object.values(rows[0])[0]).toLowerCase() !== "ok"
  ) {
    fail();
  }
}

async function assertForeignKeysEnabled(prisma) {
  const rows = await prisma.$queryRawUnsafe("PRAGMA foreign_keys = ON");
  const status = await prisma.$queryRawUnsafe("PRAGMA foreign_keys");
  void rows;
  if (status.length !== 1 || Number(Object.values(status[0])[0]) !== 1) {
    fail();
  }
}

async function assertPreimageTopology(prisma, proof, state) {
  if (!isPreimage(state, proof)) fail();
  await assertExactProjectDependencies(prisma, proof);

  const tenantIds = [
    ...new Set(proof.missingProjects.map(({ tenantId }) => tenantId)),
  ];
  const tenants = await placeholdersQuery(
    prisma,
    `SELECT id FROM tenants WHERE deleted_at IS NULL AND id IN (`,
    tenantIds,
    ") ORDER BY id",
  );
  if (
    tenants.length !== tenantIds.length ||
    new Set(tenants.map(({ id }) => id)).size !== tenantIds.length
  ) {
    fail();
  }

  const projectPairs = await placeholdersQuery(
    prisma,
    `SELECT id, tenant_id, deleted_at
       FROM projects
      WHERE id IN (`,
    proof.orphanCashFlowEntries.map(({ projectId }) => projectId),
    ")",
  );
  const activeProjectById = new Map(
    projectPairs
      .filter(({ deleted_at }) => deleted_at === null)
      .map(({ id, tenant_id }) => [id, tenant_id]),
  );
  if (
    proof.orphanCashFlowEntries.some(
      ({ projectId, tenantId }) =>
        activeProjectById.get(projectId) !== tenantId,
    )
  ) {
    fail();
  }

  const missingExpenseIds = proof.orphanCashFlowEntries.map(
    ({ missingExpenseId }) => missingExpenseId,
  );
  const expenses = await placeholdersQuery(
    prisma,
    "SELECT id FROM expenses WHERE id IN (",
    missingExpenseIds,
    ")",
  );
  if (expenses.length !== 0) fail();

  const orphanRooms = await prisma.$queryRawUnsafe(
    `SELECT r.id, r.project_id, r.deleted_at
       FROM rooms r
       LEFT JOIN projects p ON p.id = r.project_id
      WHERE p.id IS NULL
      ORDER BY r.id`,
  );
  const orphanCash = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.expense_id, c.deleted_at
       FROM cash_flow_entries c
       LEFT JOIN expenses e ON e.id = c.expense_id
      WHERE c.expense_id IS NOT NULL
        AND e.id IS NULL
      ORDER BY c.id`,
  );
  if (
    orphanRooms.length !== EXPECTED_ORPHAN_ROOMS ||
    orphanCash.length !== EXPECTED_ORPHAN_CASH_FLOW_ENTRIES
  ) {
    fail();
  }

  const violations = await pragmaForeignKeyCheck(prisma);
  if (
    violations.length !== EXPECTED_FOREIGN_KEY_VIOLATIONS ||
    violations.some(
      (row) =>
        !(
          (row.table === "rooms" && row.parent === "projects") ||
          (row.table === "cash_flow_entries" && row.parent === "expenses")
        ),
    )
  ) {
    fail();
  }
  await assertIntegrity(prisma);
}

async function assertPostimageTopology(prisma, proof, state) {
  if (!isPostimage(state, proof)) fail();
  await assertExactProjectDependencies(prisma, proof);
  const violations = await pragmaForeignKeyCheck(prisma);
  if (violations.length !== 0) fail();
  await assertIntegrity(prisma);
}

function buildManifest(proof, scopeProofSha256, preState, inventory) {
  const postState = expectedPostState(preState, proof);
  return {
    version: MANIFEST_VERSION,
    scopeProofSha256,
    counts: {
      missingProjects: EXPECTED_MISSING_PROJECTS,
      orphanRooms: EXPECTED_ORPHAN_ROOMS,
      orphanCashFlowEntries: EXPECTED_ORPHAN_CASH_FLOW_ENTRIES,
      foreignKeyViolationsBefore: EXPECTED_FOREIGN_KEY_VIOLATIONS,
      foreignKeyViolationsAfter: 0,
    },
    beforeHash: stateHash({ state: preState, inventory }),
    postHash: stateHash({ state: postState, inventory }),
    financialHash: stateHash(protectedFinancialState(preState)),
    roomBacklinks: inventory.roomBacklinks,
    protectedTriggers: inventory.protectedTriggers,
    inventoryHash: inventory.inventoryHash,
    missingProjects: proof.missingProjects,
    orphanCashFlowEntries: proof.orphanCashFlowEntries,
  };
}

function validateManifest(manifest, proof, scopeProofSha256) {
  if (
    !hasExactKeys(manifest, [
      "version",
      "scopeProofSha256",
      "counts",
      "beforeHash",
      "postHash",
      "financialHash",
      "roomBacklinks",
      "protectedTriggers",
      "inventoryHash",
      "missingProjects",
      "orphanCashFlowEntries",
    ]) ||
    manifest.version !== MANIFEST_VERSION ||
    manifest.scopeProofSha256 !== scopeProofSha256 ||
    !["beforeHash", "postHash", "financialHash", "inventoryHash"].every(
      (field) => /^[a-f0-9]{64}$/.test(manifest[field]),
    ) ||
    !hasExactKeys(manifest.counts, [
      "missingProjects",
      "orphanRooms",
      "orphanCashFlowEntries",
      "foreignKeyViolationsBefore",
      "foreignKeyViolationsAfter",
    ]) ||
    manifest.counts.missingProjects !== EXPECTED_MISSING_PROJECTS ||
    manifest.counts.orphanRooms !== EXPECTED_ORPHAN_ROOMS ||
    manifest.counts.orphanCashFlowEntries !==
      EXPECTED_ORPHAN_CASH_FLOW_ENTRIES ||
    manifest.counts.foreignKeyViolationsBefore !==
      EXPECTED_FOREIGN_KEY_VIOLATIONS ||
    manifest.counts.foreignKeyViolationsAfter !== 0 ||
    !canonicalBytes(manifest.missingProjects).equals(
      canonicalBytes(proof.missingProjects),
    ) ||
    !canonicalBytes(manifest.orphanCashFlowEntries).equals(
      canonicalBytes(proof.orphanCashFlowEntries),
    ) ||
    !Array.isArray(manifest.roomBacklinks) ||
    !Array.isArray(manifest.protectedTriggers)
  ) {
    fail();
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = argument.startsWith("--") ? argument.slice(2) : "";
    if (!CLI_OPTIONS.has(name) || Object.hasOwn(options, name)) fail();
    if (name === "dry-run" || name === "apply") {
      options[name] = true;
      continue;
    }
    if (index + 1 >= argv.length) fail();
    options[name] = argv[index + 1];
    index += 1;
  }

  if (
    Boolean(options["dry-run"]) === Boolean(options.apply) ||
    !["scope-proof", "scope-proof-hash", "manifest"].every((name) =>
      nonEmptyString(options[name]),
    ) ||
    !/^[a-f0-9]{64}$/.test(options["scope-proof-hash"])
  ) {
    fail();
  }
  if (options["dry-run"]) {
    if (
      [
        "hash",
        "expected-projects",
        "expected-rooms",
        "expected-cash-flow-entries",
      ].some((name) => Object.hasOwn(options, name))
    ) {
      fail();
    }
  } else {
    for (const name of [
      "hash",
      "expected-projects",
      "expected-rooms",
      "expected-cash-flow-entries",
    ]) {
      if (!nonEmptyString(options[name])) fail();
    }
    if (
      !/^[a-f0-9]{64}$/.test(options.hash) ||
      options["expected-projects"] !== String(EXPECTED_MISSING_PROJECTS) ||
      options["expected-rooms"] !== String(EXPECTED_ORPHAN_ROOMS) ||
      options["expected-cash-flow-entries"] !==
        String(EXPECTED_ORPHAN_CASH_FLOW_ENTRIES)
    ) {
      fail();
    }
  }
  return options;
}

async function writeManifest(path, bytes) {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) fail();
  } finally {
    await handle.close();
  }
}

function resultPayload({
  foreignKeyViolationsAfter,
  insertedProjects,
  updatedCashFlowEntries,
  manifestHash,
}) {
  return {
    missingProjects: EXPECTED_MISSING_PROJECTS,
    orphanRooms: EXPECTED_ORPHAN_ROOMS,
    orphanCashFlowEntries: EXPECTED_ORPHAN_CASH_FLOW_ENTRIES,
    foreignKeyViolationsBefore: EXPECTED_FOREIGN_KEY_VIOLATIONS,
    foreignKeyViolationsAfter,
    insertedProjects,
    updatedCashFlowEntries,
    manifestHash: manifestHash.slice(0, 12),
  };
}

async function insertTombstone(prisma, project) {
  return prisma.$executeRawUnsafe(
    `INSERT INTO projects
       (id, tenant_id, created_by_user_id, type, name, description,
        start_date, end_date, created_at, updated_at, deleted_at, onboarded_at)
     SELECT ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL
      WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = ?)`,
    project.projectId,
    project.tenantId,
    TOMBSTONE_TYPE,
    TOMBSTONE_NAME,
    TOMBSTONE_DESCRIPTION,
    TOMBSTONE_TIMESTAMP,
    TOMBSTONE_TIMESTAMP,
    TOMBSTONE_TIMESTAMP,
    project.projectId,
  );
}

async function nullOrphanExpense(prisma, row) {
  return prisma.$executeRawUnsafe(
    `UPDATE cash_flow_entries
        SET expense_id = NULL
      WHERE id = ?
        AND tenant_id = ?
        AND project_id = ?
        AND expense_id = ?
        AND deleted_at IS NOT NULL`,
    row.cashFlowEntryId,
    row.tenantId,
    row.projectId,
    row.missingExpenseId,
  );
}

async function applyManifest(prisma, proof, manifest) {
  await prisma.$executeRawUnsafe("BEGIN IMMEDIATE");
  try {
    const state = await readAffectedState(prisma, proof);
    const inventory = await readSecurityInventory(prisma, proof);
    if (
      inventory.inventoryHash !== manifest.inventoryHash ||
      !canonicalBytes(inventory.roomBacklinks).equals(
        canonicalBytes(manifest.roomBacklinks),
      ) ||
      !canonicalBytes(inventory.protectedTriggers).equals(
        canonicalBytes(manifest.protectedTriggers),
      )
    ) {
      fail();
    }
    const preimage = isPreimage(state, proof);
    const postimage = isPostimage(state, proof);
    if (preimage === postimage) fail();

    if (postimage) {
      await assertPostimageTopology(prisma, proof, state);
      if (
        stateHash({ state, inventory }) !== manifest.postHash ||
        stateHash(protectedFinancialState(state)) !== manifest.financialHash
      ) {
        fail();
      }
      await prisma.$executeRawUnsafe("COMMIT");
      return { insertedProjects: 0, updatedCashFlowEntries: 0 };
    }

    await assertPreimageTopology(prisma, proof, state);
    if (
      stateHash({ state, inventory }) !== manifest.beforeHash ||
      stateHash(protectedFinancialState(state)) !== manifest.financialHash
    ) {
      fail();
    }
    const rebuilt = buildManifest(
      proof,
      manifest.scopeProofSha256,
      state,
      inventory,
    );
    if (!canonicalBytes(rebuilt).equals(canonicalBytes(manifest))) fail();

    let insertedProjects = 0;
    for (const project of proof.missingProjects) {
      const count = await insertTombstone(prisma, project);
      if (count !== 1) fail();
      insertedProjects += count;
    }
    let updatedCashFlowEntries = 0;
    for (const row of proof.orphanCashFlowEntries) {
      const count = await nullOrphanExpense(prisma, row);
      if (count !== 1) fail();
      updatedCashFlowEntries += count;
    }
    if (
      insertedProjects !== EXPECTED_MISSING_PROJECTS ||
      updatedCashFlowEntries !== EXPECTED_ORPHAN_CASH_FLOW_ENTRIES
    ) {
      fail();
    }

    const after = await readAffectedState(prisma, proof);
    await assertPostimageTopology(prisma, proof, after);
    if (
      stateHash({ state: after, inventory }) !== manifest.postHash ||
      stateHash(protectedFinancialState(after)) !== manifest.financialHash
    ) {
      fail();
    }
    await prisma.$executeRawUnsafe("COMMIT");
    return { insertedProjects, updatedCashFlowEntries };
  } catch (error) {
    try {
      await prisma.$executeRawUnsafe("ROLLBACK");
    } catch {
      // Disconnect also rolls back an open transaction; keep the first error.
    }
    throw error;
  }
}

async function main(argv) {
  await assertInheritedWatchdogLock();
  const options = parseArguments(argv);
  const databaseUrl = process.env.DATABASE_URL;
  if (!nonEmptyString(databaseUrl) || !databaseUrl.startsWith("file:")) fail();

  const scope = await readPrivateCanonicalJson(
    options["scope-proof"],
    options["scope-proof-hash"],
  );
  validateScopeProof(scope.value);

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  await prisma.$connect();
  try {
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 10000");
    await assertForeignKeysEnabled(prisma);
    if (options["dry-run"]) {
      await prisma.$executeRawUnsafe("BEGIN");
      let manifest;
      try {
        const state = await readAffectedState(prisma, scope.value);
        await assertPreimageTopology(prisma, scope.value, state);
        const inventory = await readSecurityInventory(prisma, scope.value);
        manifest = buildManifest(
          scope.value,
          options["scope-proof-hash"],
          state,
          inventory,
        );
      } finally {
        await prisma.$executeRawUnsafe("ROLLBACK");
      }
      const bytes = canonicalBytes(manifest);
      await writeManifest(options.manifest, bytes);
      console.log(
        JSON.stringify(
          resultPayload({
            foreignKeyViolationsAfter: EXPECTED_FOREIGN_KEY_VIOLATIONS,
            insertedProjects: 0,
            updatedCashFlowEntries: 0,
            manifestHash: sha256(bytes),
          }),
        ),
      );
      return;
    }

    const manifestFile = await readPrivateCanonicalJson(
      options.manifest,
      options.hash,
    );
    validateManifest(
      manifestFile.value,
      scope.value,
      options["scope-proof-hash"],
    );
    const applied = await applyManifest(
      prisma,
      scope.value,
      manifestFile.value,
    );
    console.log(
      JSON.stringify(
        resultPayload({
          foreignKeyViolationsAfter: 0,
          ...applied,
          manifestHash: options.hash,
        }),
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch(() => {
    console.error("legacy FK recovery failed: safety check failed");
    process.exitCode = 1;
  });
}
