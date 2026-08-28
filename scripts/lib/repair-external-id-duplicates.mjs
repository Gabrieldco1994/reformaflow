import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

export const REPAIR_TABLES = Object.freeze(["expenses", "receipts"]);
const MANIFEST_VERSION = 1;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalManifestBytes(manifest) {
  return Buffer.from(
    `${JSON.stringify(canonicalize(manifest), null, 2)}\n`,
    "utf8",
  );
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeTimestamp(value, field) {
  if (value === null && field === "deletedAt") return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const timestamp = new Date(value);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
  }
  throw new Error(`invalid ${field} in repair input`);
}

function normalizeRow(input) {
  const externalId = Object.hasOwn(input, "externalId")
    ? input.externalId
    : input.external_id;
  const table = input.table;
  const row = {
    id: input.id,
    tenantId: input.tenantId ?? input.tenant_id,
    projectId: input.projectId ?? input.project_id,
    externalId,
    createdAt: normalizeTimestamp(
      input.createdAt ?? input.created_at,
      "createdAt",
    ),
    updatedAt: normalizeTimestamp(
      input.updatedAt ?? input.updated_at,
      "updatedAt",
    ),
    deletedAt: normalizeTimestamp(
      input.deletedAt ?? input.deleted_at ?? null,
      "deletedAt",
    ),
  };

  if (!REPAIR_TABLES.includes(table))
    throw new Error("unsupported repair table");
  for (const field of ["id", "tenantId", "projectId"]) {
    if (typeof row[field] !== "string" || row[field].length === 0) {
      throw new Error(`invalid ${field} in repair input`);
    }
  }
  if (
    externalId !== null &&
    (typeof externalId !== "string" || externalId.length === 0)
  ) {
    throw new Error("invalid externalId in repair input");
  }

  return { table, ...row };
}

function compareRows(left, right) {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
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

export function manifestCounts(manifest) {
  const counts = Object.fromEntries(
    REPAIR_TABLES.map((table) => [
      table,
      { groups: 0, rows: 0, nonkeepers: 0 },
    ]),
  );
  for (const group of manifest.groups) {
    const tableCounts = counts[group.table];
    if (!tableCounts) throw new Error("manifest contains an unsupported table");
    tableCounts.groups += 1;
    tableCounts.rows += group.rows.length;
    tableCounts.nonkeepers += group.rows.length - 1;
  }
  return counts;
}

export function buildRepairManifest(
  inputs,
  generatedAt = new Date().toISOString(),
) {
  const grouped = new Map();

  for (const input of inputs) {
    const row = normalizeRow(input);
    if (row.externalId === null) continue;
    const key = JSON.stringify([
      row.table,
      row.tenantId,
      row.projectId,
      row.externalId,
    ]);
    const rows = grouped.get(key) ?? [];
    rows.push(row);
    grouped.set(key, rows);
  }

  const groups = [];
  for (const rows of grouped.values()) {
    if (rows.length < 2) continue;
    rows.sort(compareRows);
    const activeRows = rows.filter((row) => row.deletedAt === null);
    if (activeRows.length > 1) {
      throw new Error("duplicate group has more than one active row");
    }
    const keeper = activeRows[0] ?? rows[0];
    if (rows.some((row) => row.id !== keeper.id && row.deletedAt === null)) {
      throw new Error("duplicate group contains an active nonkeeper");
    }

    groups.push({
      table: keeper.table,
      tenantId: keeper.tenantId,
      projectId: keeper.projectId,
      externalId: keeper.externalId,
      keeperId: keeper.id,
      rows: rows.map(({ table: _table, ...row }) => ({
        ...row,
        keeper: row.id === keeper.id,
      })),
    });
  }
  groups.sort(compareGroups);

  const manifest = {
    version: MANIFEST_VERSION,
    generatedAt,
    groups,
  };
  return { ...manifest, counts: manifestCounts(manifest) };
}

async function readRepairRows(prisma) {
  const rows = [];
  for (const table of REPAIR_TABLES) {
    const tableRows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, project_id, external_id, created_at, updated_at, deleted_at
         FROM "${table}"
        WHERE external_id IS NOT NULL`,
    );
    rows.push(...tableRows.map((row) => ({ table, ...row })));
  }
  return rows;
}

async function readManifestRows(prisma, manifest) {
  const actual = new Map();
  for (const group of manifest.groups) {
    for (const expected of group.rows) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, tenant_id, project_id, external_id, created_at, updated_at, deleted_at
           FROM "${group.table}"
          WHERE id = ?`,
        expected.id,
      );
      if (rows.length !== 1)
        throw new Error("manifest row is missing or duplicated");
      actual.set(
        `${group.table}\0${expected.id}`,
        normalizeRow({ table: group.table, ...rows[0] }),
      );
    }
  }
  return actual;
}

function comparableGroups(manifest) {
  return manifest.groups.map((group) => ({
    ...group,
    rows: group.rows.map(({ keeper, ...row }) => ({ ...row, keeper })),
  }));
}

function equalJson(left, right) {
  return (
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
  );
}

function rowMatches(expected, actual, postimage) {
  return equalJson(
    {
      id: actual.id,
      tenantId: actual.tenantId,
      projectId: actual.projectId,
      externalId: actual.externalId,
      createdAt: actual.createdAt,
      updatedAt: actual.updatedAt,
      deletedAt: actual.deletedAt,
    },
    {
      id: expected.id,
      tenantId: expected.tenantId,
      projectId: expected.projectId,
      externalId: postimage && !expected.keeper ? null : expected.externalId,
      createdAt: expected.createdAt,
      updatedAt: expected.updatedAt,
      deletedAt: expected.deletedAt,
    },
  );
}

function validateManifest(manifest) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    manifest.version !== MANIFEST_VERSION ||
    typeof manifest.generatedAt !== "string" ||
    !Array.isArray(manifest.groups)
  ) {
    throw new Error("invalid repair manifest");
  }

  const rebuiltRows = manifest.groups.flatMap((group) =>
    group.rows.map(({ keeper: _keeper, ...row }) => ({
      table: group.table,
      ...row,
    })),
  );
  const rebuilt = buildRepairManifest(rebuiltRows, manifest.generatedAt);
  if (!equalJson(rebuilt, manifest))
    throw new Error("invalid or non-canonical repair manifest");
}

function validateExpectedCounts(manifest, expectedCounts) {
  if (!expectedCounts || !equalJson(manifestCounts(manifest), expectedCounts)) {
    throw new Error("expected counts mismatch");
  }
}

async function applyManifest(prisma, manifest) {
  await prisma.$executeRawUnsafe("BEGIN IMMEDIATE");
  try {
    const actualRows = await readManifestRows(prisma, manifest);
    const classifications = manifest.groups.flatMap((group) =>
      group.rows.map((expected) => {
        const actual = actualRows.get(`${group.table}\0${expected.id}`);
        return {
          pre: rowMatches(expected, actual, false),
          post: rowMatches(expected, actual, true),
        };
      }),
    );
    const allPre = classifications.every(({ pre }) => pre);
    const allPost = classifications.every(({ post }) => post);
    if (!allPre && !allPost)
      throw new Error("partial or drifted state; refusing repair");

    const live = buildRepairManifest(
      await readRepairRows(prisma),
      manifest.generatedAt,
    );
    if (allPost) {
      if (live.groups.length !== 0) {
        throw new Error(
          "partial or drifted state; unexpected duplicate groups remain",
        );
      }
      await prisma.$executeRawUnsafe("COMMIT");
      return { mode: "no-op", updated: 0 };
    }
    if (!equalJson(comparableGroups(live), comparableGroups(manifest))) {
      throw new Error("partial or drifted state; duplicate preimage changed");
    }

    let updated = 0;
    for (const group of manifest.groups) {
      for (const row of group.rows) {
        if (row.keeper) continue;
        const count = await prisma.$executeRawUnsafe(
          `UPDATE "${group.table}"
              SET external_id = NULL
            WHERE id = ?
              AND tenant_id = ?
              AND project_id = ?
              AND external_id = ?
              AND deleted_at IS NOT NULL`,
          row.id,
          row.tenantId,
          row.projectId,
          row.externalId,
        );
        if (count !== 1)
          throw new Error("CAS update count was not exactly one");
        updated += count;
      }
    }

    const postRows = await readManifestRows(prisma, manifest);
    const exactPostimage = manifest.groups.every((group) =>
      group.rows.every((expected) =>
        rowMatches(
          expected,
          postRows.get(`${group.table}\0${expected.id}`),
          true,
        ),
      ),
    );
    const remaining = buildRepairManifest(
      await readRepairRows(prisma),
      manifest.generatedAt,
    );
    if (!exactPostimage || remaining.groups.length !== 0) {
      throw new Error("repair postimage validation failed");
    }

    await prisma.$executeRawUnsafe("COMMIT");
    return { mode: "applied", updated };
  } catch (error) {
    try {
      await prisma.$executeRawUnsafe("ROLLBACK");
    } catch {
      // Preserve the original failure; a disconnected transaction is already rolled back.
    }
    throw error;
  }
}

export async function runRepair({
  databaseUrl,
  manifestPath,
  apply = false,
  manifestSha256,
  expectedCounts,
}) {
  if (typeof databaseUrl !== "string" || !databaseUrl.startsWith("file:")) {
    throw new Error("an explicit SQLite file: database URL is required");
  }
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    throw new Error("an explicit local manifest path is required");
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  await prisma.$connect();
  try {
    if (!apply) {
      const manifest = buildRepairManifest(await readRepairRows(prisma));
      const bytes = canonicalManifestBytes(manifest);
      const handle = await open(manifestPath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      return {
        mode: "dry-run",
        manifest,
        manifestSha256: sha256(bytes),
        counts: manifestCounts(manifest),
      };
    }

    const handle = await open(
      manifestPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let bytes;
    try {
      const manifestStat = await handle.stat();
      if (!manifestStat.isFile() || (manifestStat.mode & 0o777) !== 0o600) {
        throw new Error("manifest must be a regular local file with mode 0600");
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const actualHash = sha256(bytes);
    if (
      typeof manifestSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifestSha256) ||
      actualHash !== manifestSha256
    ) {
      throw new Error("manifest SHA-256 mismatch");
    }
    const manifest = JSON.parse(bytes.toString("utf8"));
    validateManifest(manifest);
    if (!canonicalManifestBytes(manifest).equals(bytes)) {
      throw new Error("manifest is not canonical JSON");
    }
    validateExpectedCounts(manifest, expectedCounts);
    const result = await applyManifest(prisma, manifest);
    return {
      ...result,
      manifestSha256: actualHash,
      counts: manifestCounts(manifest),
    };
  } finally {
    await prisma.$disconnect();
  }
}
