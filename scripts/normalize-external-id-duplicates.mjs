#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const TABLES = Object.freeze(["expenses", "receipts"]);
const MANIFEST_VERSION = 1;
const CLI_OPTIONS = new Set([
  "dry-run",
  "apply",
  "manifest",
  "hash",
  "expected-groups",
  "expected-updates",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function normalizeTimestamp(value, nullable = false) {
  if (value === null && nullable) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const timestamp = new Date(value);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
  }
  throw new Error("invalid timestamp in database");
}

function normalizeRow(table, row) {
  const normalized = {
    table,
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    externalId: row.external_id,
    createdAt: normalizeTimestamp(row.created_at),
    deletedAt: normalizeTimestamp(row.deleted_at, true),
  };
  for (const field of ["id", "tenantId", "projectId"]) {
    if (
      typeof normalized[field] !== "string" ||
      normalized[field].length === 0
    ) {
      throw new Error("invalid identity in database");
    }
  }
  if (
    normalized.externalId !== null &&
    (typeof normalized.externalId !== "string" ||
      normalized.externalId.length === 0)
  ) {
    throw new Error("invalid external ID in database");
  }
  return normalized;
}

function compareRows(left, right) {
  return (
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
    left.id.localeCompare(right.id)
  );
}

function compareGroups(left, right) {
  return (
    left.table.localeCompare(right.table) ||
    left.tenantId.localeCompare(right.tenantId) ||
    left.projectId.localeCompare(right.projectId) ||
    left.externalId.localeCompare(right.externalId)
  );
}

function buildManifest(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (row.externalId === null) continue;
    const key = JSON.stringify([
      row.table,
      row.tenantId,
      row.projectId,
      row.externalId,
    ]);
    const entries = grouped.get(key) ?? [];
    entries.push(row);
    grouped.set(key, entries);
  }

  const groups = [];
  for (const entries of grouped.values()) {
    if (entries.length < 2) continue;
    entries.sort(compareRows);
    const active = entries.filter((row) => row.deletedAt === null);
    if (active.length > 1) {
      throw new Error("duplicate group has more than one active row");
    }
    const keeper = active[0] ?? entries[0];
    const nonkeepers = entries.filter((row) => row.id !== keeper.id);
    if (nonkeepers.some((row) => row.deletedAt === null)) {
      throw new Error("duplicate group contains an active nonkeeper");
    }
    groups.push({
      table: keeper.table,
      tenantId: keeper.tenantId,
      projectId: keeper.projectId,
      externalId: keeper.externalId,
      keeperId: keeper.id,
      nonkeeperIds: nonkeepers.map((row) => row.id).sort(),
    });
  }
  groups.sort(compareGroups);

  return {
    version: MANIFEST_VERSION,
    expectedGroups: groups.length,
    expectedUpdates: groups.reduce(
      (total, group) => total + group.nonkeeperIds.length,
      0,
    ),
    groups,
  };
}

async function readRows(prisma) {
  const rows = [];
  for (const table of TABLES) {
    const tableRows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, project_id, external_id, created_at, deleted_at
         FROM "${table}"`,
    );
    rows.push(...tableRows.map((row) => normalizeRow(table, row)));
  }
  return rows;
}

function validateManifest(manifest) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    !hasExactKeys(manifest, [
      "version",
      "expectedGroups",
      "expectedUpdates",
      "groups",
    ]) ||
    manifest.version !== MANIFEST_VERSION ||
    !Number.isSafeInteger(manifest.expectedGroups) ||
    !Number.isSafeInteger(manifest.expectedUpdates) ||
    !Array.isArray(manifest.groups) ||
    manifest.expectedGroups !== manifest.groups.length
  ) {
    throw new Error("invalid manifest");
  }

  let updates = 0;
  const identities = new Set();
  for (const group of manifest.groups) {
    if (
      group === null ||
      typeof group !== "object" ||
      !hasExactKeys(group, [
        "table",
        "tenantId",
        "projectId",
        "externalId",
        "keeperId",
        "nonkeeperIds",
      ]) ||
      !TABLES.includes(group.table) ||
      !["tenantId", "projectId", "externalId", "keeperId"].every(
        (field) => typeof group[field] === "string" && group[field].length > 0,
      ) ||
      !Array.isArray(group.nonkeeperIds) ||
      group.nonkeeperIds.length === 0 ||
      group.nonkeeperIds.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      throw new Error("invalid manifest group");
    }
    for (const id of [group.keeperId, ...group.nonkeeperIds]) {
      const identity = `${group.table}\0${id}`;
      if (identities.has(identity)) throw new Error("duplicate manifest row");
      identities.add(identity);
    }
    updates += group.nonkeeperIds.length;
  }
  const sortedGroups = [...manifest.groups].sort(compareGroups);
  if (
    updates !== manifest.expectedUpdates ||
    manifest.groups.some(
      (group, index) =>
        group !== sortedGroups[index] ||
        group.nonkeeperIds.some(
          (id, idIndex) =>
            idIndex > 0 &&
            id.localeCompare(group.nonkeeperIds[idIndex - 1]) <= 0,
        ),
    )
  ) {
    throw new Error("invalid manifest");
  }
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    expected
      .slice()
      .sort()
      .every((key, index) => key === actual[index])
  );
}

function sameManifest(left, right) {
  return manifestBytes(left).equals(manifestBytes(right));
}

function findRow(rows, table, id) {
  return rows.find((row) => row.table === table && row.id === id);
}

function matchesScope(row, group) {
  return row?.tenantId === group.tenantId && row?.projectId === group.projectId;
}

function classifyImage(rows, manifest) {
  const classifications = [];
  for (const group of manifest.groups) {
    const keeper = findRow(rows, group.table, group.keeperId);
    classifications.push({
      pre:
        matchesScope(keeper, group) && keeper.externalId === group.externalId,
      post:
        matchesScope(keeper, group) && keeper.externalId === group.externalId,
    });
    for (const id of group.nonkeeperIds) {
      const nonkeeper = findRow(rows, group.table, id);
      classifications.push({
        pre:
          matchesScope(nonkeeper, group) &&
          nonkeeper.externalId === group.externalId &&
          nonkeeper.deletedAt !== null,
        post:
          matchesScope(nonkeeper, group) &&
          nonkeeper.externalId === null &&
          nonkeeper.deletedAt !== null,
      });
    }
  }
  return {
    allPre: classifications.every(({ pre }) => pre),
    allPost: classifications.every(({ post }) => post),
  };
}

async function applyManifest(prisma, manifest) {
  await prisma.$executeRawUnsafe("BEGIN IMMEDIATE");
  try {
    const before = await readRows(prisma);
    const { allPre, allPost } = classifyImage(before, manifest);
    if (!allPre && !allPost) {
      throw new Error("partial or drifted state");
    }

    const liveManifest = buildManifest(before);
    if (allPost) {
      if (liveManifest.expectedGroups !== 0) {
        throw new Error("unexpected duplicate groups remain");
      }
      await prisma.$executeRawUnsafe("COMMIT");
      return 0;
    }
    if (!sameManifest(liveManifest, manifest)) {
      throw new Error("duplicate preimage changed");
    }

    let updated = 0;
    for (const group of manifest.groups) {
      for (const id of group.nonkeeperIds) {
        const count = await prisma.$executeRawUnsafe(
          `UPDATE "${group.table}"
              SET external_id = NULL
            WHERE id = ?
              AND tenant_id = ?
              AND project_id = ?
              AND external_id = ?
              AND deleted_at IS NOT NULL`,
          id,
          group.tenantId,
          group.projectId,
          group.externalId,
        );
        if (count !== 1) throw new Error("CAS update count was not one");
        updated += count;
      }
    }

    const after = await readRows(prisma);
    const postimage = classifyImage(after, manifest);
    if (
      !postimage.allPost ||
      buildManifest(after).expectedGroups !== 0 ||
      updated !== manifest.expectedUpdates
    ) {
      throw new Error("postimage validation failed");
    }
    await prisma.$executeRawUnsafe("COMMIT");
    return updated;
  } catch (error) {
    try {
      await prisma.$executeRawUnsafe("ROLLBACK");
    } catch {
      // Preserve the original failure; disconnect also rolls back an open tx.
    }
    throw error;
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = argument.startsWith("--") ? argument.slice(2) : "";
    if (!CLI_OPTIONS.has(name) || Object.hasOwn(options, name)) {
      throw new Error("invalid arguments");
    }
    if (argument === "--dry-run" || argument === "--apply") {
      options[name] = true;
      continue;
    }
    if (index + 1 >= argv.length) {
      throw new Error("invalid arguments");
    }
    options[name] = argv[index + 1];
    index += 1;
  }

  if (
    Boolean(options["dry-run"]) === Boolean(options.apply) ||
    typeof options.manifest !== "string"
  ) {
    throw new Error("choose --dry-run or --apply and provide --manifest");
  }
  if (
    options["dry-run"] &&
    ["hash", "expected-groups", "expected-updates"].some((name) =>
      Object.hasOwn(options, name),
    )
  ) {
    throw new Error("dry-run accepts only --manifest");
  }
  if (options.apply) {
    for (const name of ["hash", "expected-groups", "expected-updates"]) {
      if (typeof options[name] !== "string") {
        throw new Error("apply requires hash and expected counts");
      }
    }
    if (
      !/^[a-f0-9]{64}$/.test(options.hash) ||
      !/^(0|[1-9][0-9]*)$/.test(options["expected-groups"]) ||
      !/^(0|[1-9][0-9]*)$/.test(options["expected-updates"])
    ) {
      throw new Error("invalid hash or expected counts");
    }
  }
  return options;
}

async function readManifest(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("manifest must be a 0600 regular file");
    }
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

async function main(argv) {
  const options = parseArguments(argv);
  const databaseUrl = process.env.DATABASE_URL;
  if (typeof databaseUrl !== "string" || !databaseUrl.startsWith("file:")) {
    throw new Error("explicit DATABASE_URL file: value is required");
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  await prisma.$connect();
  try {
    if (options["dry-run"]) {
      const manifest = buildManifest(await readRows(prisma));
      const bytes = manifestBytes(manifest);
      const handle = await open(options.manifest, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      console.log(
        JSON.stringify({
          expectedGroups: manifest.expectedGroups,
          expectedUpdates: manifest.expectedUpdates,
          sha256: sha256(bytes),
        }),
      );
      return;
    }

    const bytes = await readManifest(options.manifest);
    if (sha256(bytes) !== options.hash)
      throw new Error("manifest hash mismatch");
    const manifest = JSON.parse(bytes.toString("utf8"));
    validateManifest(manifest);
    if (!manifestBytes(manifest).equals(bytes)) {
      throw new Error("manifest is not canonical");
    }
    if (
      manifest.expectedGroups !== Number(options["expected-groups"]) ||
      manifest.expectedUpdates !== Number(options["expected-updates"])
    ) {
      throw new Error("expected counts mismatch");
    }

    const updated = await applyManifest(prisma, manifest);
    console.log(
      JSON.stringify({
        expectedGroups: manifest.expectedGroups,
        expectedUpdates: manifest.expectedUpdates,
        updated,
        sha256: options.hash,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `normalization failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
