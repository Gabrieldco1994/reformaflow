require("../../../../scripts/test-db-env.cjs");

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  DedupeKeys,
  DedupeQueryClient,
  type DedupeEnumeration as Enumeration,
  enumerateDedupeMatches,
  findDedupeMatches,
} from "./cross-origin-dedupe";

type Enumerate = (
  db: DedupeQueryClient,
  tenantId: string,
  projectId: string,
  keys: readonly DedupeKeys[],
  remaining: number,
) => Promise<Enumeration>;

function load(): Enumerate {
  const exports = { enumerateDedupeMatches } satisfies {
    enumerateDedupeMatches: Enumerate;
  };
  expect({
    export: "enumerateDedupeMatches",
    type: typeof exports.enumerateDedupeMatches,
  }).toEqual({ export: "enumerateDedupeMatches", type: "function" });
  if (!exports.enumerateDedupeMatches)
    throw new Error("Export assertion failed");
  return exports.enumerateDedupeMatches;
}

interface Read {
  sql: string;
  values: unknown[];
  limit: number;
  ids: string[];
}
const DAY = new Date("2026-06-10T00:00:00.000Z");
const TOMBSTONE = new Date("2026-09-01T00:00:00.000Z");
const keys: readonly DedupeKeys[] = [
  {
    externalId: "document-ext",
    strong: "document-strong",
    natural: "same-day",
  },
];

describe("canonical bounded cross-origin contract (#701)", () => {
  const db = new PrismaService();
  let sequence = 0;
  let tenantId: string;
  let projectId: string;
  let reads: Read[];
  let reached: boolean;

  beforeAll(() => db.$connect());
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    sequence += 1;
    tenantId = `bounded-dedupe-${sequence}`;
    projectId = `${tenantId}-project`;
    reads = [];
    reached = false;
    await db.tenant.create({ data: { id: tenantId, name: "Synthetic QA" } });
    await db.project.create({
      data: { id: projectId, tenantId, type: "PESSOAL", name: "Synthetic QA" },
    });
  });
  afterEach(() => {
    const evidence = process.env.CANONICAL_QA_EVIDENCE_DIR;
    if (evidence)
      writeFileSync(
        join(evidence, `dedupe-${sequence}.json`),
        JSON.stringify(
          { test: expect.getState().currentTestName, reached, reads },
          (_, value) => (typeof value === "bigint" ? String(value) : value),
          2,
        ),
        { mode: 0o600 },
      );
  });

  function expense(
    id: string,
    patch: Partial<Prisma.ExpenseCreateManyInput> = {},
  ): Prisma.ExpenseCreateManyInput {
    return {
      id: `${tenantId}-${id}`,
      tenantId,
      projectId,
      tipoDespesa: "OUTROS",
      valor: 6984,
      valorTotal: 6984,
      quantidade: 1,
      formaPagamento: "A_VISTA",
      status: "PAGO",
      origin: "import",
      dataCompra: DAY,
      createdAt: DAY,
      updatedAt: DAY,
      externalId: null,
      dedupeKeyStrong: null,
      dedupeKeyNatural: "same-day",
      ...patch,
    };
  }

  function receipt(
    id: string,
    patch: Partial<Prisma.ReceiptCreateManyInput> = {},
  ): Prisma.ReceiptCreateManyInput {
    return {
      id: `${tenantId}-${id}`,
      tenantId,
      projectId,
      tipo: "OUTROS",
      valor: 6984,
      data: DAY,
      createdAt: DAY,
      updatedAt: DAY,
      origin: "account",
      externalId: null,
      dedupeKeyStrong: null,
      dedupeKeyNatural: "same-day",
      ...patch,
    };
  }

  async function enumerate(remaining: number, input = keys) {
    const fn = load();
    reads = [];
    const client: DedupeQueryClient = {
      $queryRaw: async (query, ...values) => {
        const sql = Array.isArray(query)
          ? Prisma.sql(query as TemplateStringsArray, ...values)
          : (query as Prisma.Sql);
        expect(sql.sql).toMatch(/^\s*SELECT\b/i);
        expect(sql.sql).toMatch(
          /\bORDER\s+BY\s+(?:["\w]+\.)?["`]?id["`]?(?:\s+ASC)?/i,
        );
        const limitMatch = /\bLIMIT\s+(\?|\d+)/i.exec(sql.sql);
        expect(limitMatch).not.toBeNull();
        if (!limitMatch) throw new Error("Missing SQL LIMIT");
        const parameter =
          sql.sql.slice(0, limitMatch.index).split("?").length - 1;
        const limit =
          limitMatch[1] === "?"
            ? Number(sql.values[parameter])
            : Number(limitMatch[1]);
        expect(Number.isSafeInteger(limit)).toBe(true);
        expect(limit).toBeGreaterThan(0);
        const visited = reads.reduce((sum, read) => sum + read.ids.length, 0);
        expect(visited).toBeLessThanOrEqual(remaining);
        expect(limit).toBeLessThanOrEqual(remaining - visited + 1);
        expect(sql.values.length).toBeLessThanOrEqual(999);
        const result: unknown = await db.$queryRaw(sql);
        expect(Array.isArray(result)).toBe(true);
        if (!Array.isArray(result)) throw new Error("Raw read is not an array");
        const ids = result.map((row: unknown) => {
          if (!row || typeof row !== "object" || !("id" in row))
            throw new Error("Materialized row has no identity");
          expect(typeof row.id).toBe("string");
          return String(row.id);
        });
        reads.push({ sql: sql.sql, values: sql.values, limit, ids });
        return result;
      },
    };
    reached = true;
    const result = await fn(client, tenantId, projectId, input, remaining);
    expect(result.visitedRows).toBe(
      reads.reduce((sum, read) => sum + read.ids.length, 0),
    );
    return result;
  }

  it("enumerates all 30 matches, candidate 26, tombstones and kind/id namespaces", async () => {
    const otherProject = `${projectId}-other`;
    const foreignTenant = `${tenantId}-foreign`;
    const foreignProject = `${foreignTenant}-project`;
    await db.tenant.create({ data: { id: foreignTenant, name: "Foreign QA" } });
    await db.project.createMany({
      data: [
        { id: otherProject, tenantId, type: "PESSOAL", name: "Other project" },
        {
          id: foreignProject,
          tenantId: foreignTenant,
          type: "PESSOAL",
          name: "Foreign",
        },
      ],
    });
    await db.expense.createMany({
      data: [
        ...Array.from({ length: 26 }, (_, index) =>
          expense(`natural-${String(index).padStart(2, "0")}`, {
            deletedAt: index === 25 ? TOMBSTONE : null,
          }),
        ),
        expense("shared"),
        expense("strong-only", {
          dedupeKeyNatural: null,
          dedupeKeyStrong: "document-strong",
        }),
        expense("external-only", {
          dedupeKeyNatural: null,
          externalId: "document-ext",
        }),
        expense("wrong-project", { projectId: otherProject }),
        expense("wrong-tenant", {
          tenantId: foreignTenant,
          projectId: foreignProject,
        }),
      ],
    });
    await db.receipt.createMany({
      data: [
        receipt("shared", { deletedAt: TOMBSTONE }),
        receipt("wrong-project", { projectId: otherProject }),
        receipt("wrong-tenant", {
          tenantId: foreignTenant,
          projectId: foreignProject,
        }),
      ],
    });
    const result = await enumerate(100);
    expect(result.kind).toBe("EXHAUSTED");
    if (result.kind !== "EXHAUSTED") throw new Error("Unexpected overflow");
    expect(result.visitedRows).toBe(30);
    expect(result.rows).toHaveLength(30);
    expect(
      result.rows.filter((row) => row.id === `${tenantId}-shared`),
    ).toEqual(
      expect.arrayContaining([
        {
          kind: "EXPENSE",
          id: `${tenantId}-shared`,
          tenantId,
          projectId,
          externalId: null,
          dedupeKeyStrong: null,
          dedupeKeyNatural: "same-day",
          deletedAt: null,
          origin: "import",
          date: "2026-06-10",
          amountCents: 6984,
        },
        {
          kind: "RECEIPT",
          id: `${tenantId}-shared`,
          tenantId,
          projectId,
          externalId: null,
          dedupeKeyStrong: null,
          dedupeKeyNatural: "same-day",
          deletedAt: TOMBSTONE,
          origin: "account",
          date: "2026-06-10",
          amountCents: 6984,
        },
      ]),
    );
    expect(
      result.rows.find((row) => row.id === `${tenantId}-natural-25`),
    ).toMatchObject({ kind: "EXPENSE", deletedAt: TOMBSTONE });
    expect(
      result.rows.every(
        (row) => row.tenantId === tenantId && row.projectId === projectId,
      ),
    ).toBe(true);
    expect(
      new Set(result.rows.map((row) => `${row.kind}:${row.id}`)).size,
    ).toBe(30);
    expect(result.rows.map((row) => `${row.kind}:${row.id}`).sort()).toEqual(
      [
        ...Array.from(
          { length: 26 },
          (_, index) =>
            `EXPENSE:${tenantId}-natural-${String(index).padStart(2, "0")}`,
        ),
        `EXPENSE:${tenantId}-shared`,
        `RECEIPT:${tenantId}-shared`,
        `EXPENSE:${tenantId}-strong-only`,
        `EXPENSE:${tenantId}-external-only`,
      ].sort(),
    );
  });

  it("chunks 301 keys and counts a second physical read even when output dedupes", async () => {
    const input = Array.from({ length: 301 }, (_, index) => ({
      externalId: `ext-${index}`,
      strong: `strong-${index}`,
      natural: `nat-${index}`,
    }));
    await db.expense.createMany({
      data: [
        expense("reread", { externalId: "ext-0", dedupeKeyNatural: "nat-300" }),
        expense("last-chunk", { dedupeKeyNatural: "nat-300" }),
      ],
    });
    const result = await enumerate(3, input);
    expect(result.kind).toBe("EXHAUSTED");
    if (result.kind !== "EXHAUSTED") throw new Error("Unexpected overflow");
    expect(result.rows.map((row) => row.id).sort()).toEqual([
      `${tenantId}-last-chunk`,
      `${tenantId}-reread`,
    ]);
    expect(result.visitedRows).toBe(3);
    expect(
      reads
        .flatMap((read) => read.ids)
        .filter((id) => id === `${tenantId}-reread`),
    ).toHaveLength(2);
    expect(
      reads.some(
        (read) =>
          read.values.includes("ext-0") && read.values.includes("ext-300"),
      ),
    ).toBe(false);
  });

  it("remaining zero proves an empty search rather than assuming exhaustion", async () => {
    expect(await enumerate(0)).toEqual({
      kind: "EXHAUSTED",
      visitedRows: 0,
      rows: [],
    });
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every((read) => read.limit === 1)).toBe(true);
  });

  it.each(["expense", "receipt"] as const)(
    "remaining zero counts the first %s witness with no partial rows",
    async (table) => {
      if (table === "expense")
        await db.expense.createMany({ data: [expense("witness")] });
      else await db.receipt.createMany({ data: [receipt("witness")] });
      expect(await enumerate(0)).toEqual({
        kind: "BUDGET_EXCEEDED",
        visitedRows: 1,
      });
      expect(reads.at(-1)?.ids).toEqual([`${tenantId}-witness`]);
    },
  );

  it.each([-1, 0.5, NaN, Infinity, -Infinity])(
    "rejects invalid remaining %s before IO",
    async (remaining) => {
      const fn = load();
      const query = jest.fn();
      reached = true;
      await expect(async () =>
        fn({ $queryRaw: query }, tenantId, projectId, keys, remaining),
      ).rejects.toBeInstanceOf(Error);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["date", { date_iso: "not-a-date" }],
    ["amount", { amount_cents: null }],
  ] as const)(
    "rejects an invalid driver %s projection instead of returning a catalog",
    async (_field, invalid) => {
      const fn = load();
      const valid = {
        id: `${tenantId}-projection`,
        tenant_id: tenantId,
        project_id: projectId,
        external_id: "document-ext",
        dedupe_key_strong: null,
        dedupe_key_natural: "same-day",
        deleted_at: null,
        origin: "import",
        date_iso: "2026-10-05",
        amount_cents: 6984,
      };
      const query = jest
        .fn()
        .mockResolvedValueOnce([valid])
        .mockResolvedValue([]);
      reached = true;
      expect(
        await fn({ $queryRaw: query }, tenantId, projectId, keys, 10),
      ).toEqual({
        kind: "EXHAUSTED",
        visitedRows: 1,
        rows: [
          {
            kind: "EXPENSE",
            id: `${tenantId}-projection`,
            tenantId,
            projectId,
            externalId: "document-ext",
            dedupeKeyStrong: null,
            dedupeKeyNatural: "same-day",
            deletedAt: null,
            origin: "import",
            date: "2026-10-05",
            amountCents: 6984,
          },
        ],
      });
      query.mockReset().mockResolvedValue([{ ...valid, ...invalid }]);
      await expect(
        fn({ $queryRaw: query }, tenantId, projectId, keys, 10),
      ).rejects.toBeInstanceOf(RangeError);
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "materializes exactly 5000, with overflow Receipt=%s counted as 5001",
    async (overflow) => {
      for (let start = 0; start < 5000; start += 100)
        await db.expense.createMany({
          data: Array.from({ length: 100 }, (_, index) =>
            expense(`bulk-${String(start + index).padStart(4, "0")}`),
          ),
        });
      if (overflow)
        await db.receipt.createMany({ data: [receipt("witness-5001")] });
      const result = await enumerate(5000);
      if (overflow)
        expect(result).toEqual({ kind: "BUDGET_EXCEEDED", visitedRows: 5001 });
      else {
        expect(result.kind).toBe("EXHAUSTED");
        if (result.kind !== "EXHAUSTED") throw new Error("Unexpected overflow");
        expect(result.visitedRows).toBe(5000);
        expect(result.rows).toHaveLength(5000);
        expect(new Set(result.rows.map((row) => row.id)).size).toBe(5000);
      }
      const pages = reads.filter(
        (read) => /\bFROM\s+["`]?expenses\b/i.test(read.sql) && read.ids.length,
      );
      expect(pages.length).toBeGreaterThan(1);
      if (pages.length > 1)
        for (const page of pages.slice(1))
          expect(page.sql).toMatch(/["`]?id["`]?\s*>\s*\?/i);
    },
  );

  it("legacy control keeps the driver first-natural choice and its unordered query", async () => {
    await db.expense.createMany({
      data: [expense("z-first"), expense("a-second")],
    });
    const rawQueries: string[] = [];
    let first: string | undefined;
    const client: DedupeQueryClient = {
      $queryRaw: async (query, ...values) => {
        const sql = Array.isArray(query)
          ? Prisma.sql(query as TemplateStringsArray, ...values)
          : (query as Prisma.Sql);
        rawQueries.push(sql.sql);
        const rows = await db.$queryRaw<Array<{ id: string }>>(sql);
        first ??= rows[0]?.id;
        return rows;
      },
    };
    const result = await findDedupeMatches(client, tenantId, projectId, [
      ...keys,
    ]);
    expect(first).toBeDefined();
    expect(result.possibleDuplicates.get("document-ext")?.existingId).toBe(
      first,
    );
    expect(result.strongDuplicates.size).toBe(0);
    expect(rawQueries).toHaveLength(2);
    expect(rawQueries.every((sql) => !/\bORDER\s+BY\b/i.test(sql))).toBe(true);
  });
});
