/**
 * #704 R3 — canDelete must read in bulk. 2000 valid purpose sources and 2000
 * legacy linked sources, one shared fixture, real PrismaService.
 *
 * The SQL counter uses the client's own `query` events (through a log-enabled
 * PrismaClient base), so it sees every statement — nested reads, raw SQL and
 * transaction control included — which `$use` cannot. Chunked `IN` lists are
 * legitimate; a per-source query is not: the budget is measured, not per row.
 */
import { writeFileSync } from "node:fs";

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  class LoggingPrismaClient extends actual.PrismaClient {
    constructor(options: Record<string, unknown> = {}) {
      super({ ...options, log: [{ emit: "event", level: "query" }] });
    }
  }
  return { ...actual, PrismaClient: LoggingPrismaClient };
});

import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { refundFixture } from "./__tests__/refund-purpose.fixture";
import { ExpenseService } from "./expense.service";

const N = 2000;
const WARM = 3;
const MEDIAN_BUDGET_MS = 2000;
// Measured statements (all kinds, incl. transaction control) for a 2000-row read: purpose 56,
// linked 34; budget = measured + ~25%. Chunked `IN` lists (900 ids) explain the growth from N=100.
const SQL_BUDGET = { purpose: 70, linked: 45 } as const;
// Growing 20x may only add chunks of the same fixed set of loaders, never a query per source.
const MAX_EXTRA_SQL_FROM_100_TO_2000 = 45;
const SMALL_N = 100;

const db = new PrismaClient();
const prisma = new PrismaService();
const expenses = new ExpenseService(prisma, new ConciliacaoService(prisma));
const sql: string[] = [];
(prisma as unknown as { $on: (e: string, cb: (q: { query: string }) => void) => void }).$on("query", (q) =>
  sql.push(q.query),
);

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

describe("#704 R3 canDelete batch read (2000 sources)", () => {
  let f: Awaited<ReturnType<typeof refundFixture>>;
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    f = await refundFixture(db, prisma, "refund-r3-batch");
    await f.apply();
    const src = await db.expense.findUniqueOrThrow({ where: { id: f.source.id } });
    const srcCfe = await db.cashFlowEntry.findMany({ where: { expenseId: src.id } });
    const edge = await db.rateioAllocation.findFirstOrThrow({ where: { sourceExpenseId: src.id } });
    const tgt = await db.expense.findUniqueOrThrow({ where: { id: edge.targetExpenseId } });
    const tgtCfe = await db.cashFlowEntry.findMany({ where: { expenseId: tgt.id } });
    for (const scenario of ["purpose", "linked"] as const) {
      const S: unknown[] = [], T: unknown[] = [], C: unknown[] = [], E: unknown[] = [];
      for (let i = 0; i < N; i++) {
        const sid = `r3b-${scenario}-${i}-s`, tid = `r3b-${scenario}-${i}-t`;
        const at = new Date(Date.UTC(2026, 8, 1, 0, 0, i % 60, i));
        S.push({ ...src, id: sid, externalId: `r3b-${scenario}-${i}`, linkedExpenseId: tid, createdAt: at, updatedAt: at });
        T.push({ ...tgt, id: tid, createdAt: at, updatedAt: at });
        for (const c of srcCfe) C.push({ ...c, id: `${sid}-c`, expenseId: sid });
        for (const c of tgtCfe) C.push({ ...c, id: `${tid}-c`, expenseId: tid, createdAt: at, updatedAt: at });
        if (scenario === "purpose") E.push({ ...edge, id: `r3b-${scenario}-${i}-e`, sourceExpenseId: sid, targetExpenseId: tid });
      }
      await db.expense.createMany({ data: [...S, ...T] as never });
      await db.cashFlowEntry.createMany({ data: C as never });
      if (E.length) await db.rateioAllocation.createMany({ data: E as never });
    }
  }, 300000);

  afterAll(async () => {
    if (process.env.R3_BENCH_OUT) writeFileSync(process.env.R3_BENCH_OUT, JSON.stringify(results, null, 1));
    await f.cleanup();
    await db.$disconnect();
    await prisma.$disconnect();
  });

  it.each(["purpose", "linked"] as const)("%s: 2000 rows within budget, all true, no per-source SQL", async (scenario) => {
    const rows = await db.expense.findMany({
      where: { tenantId: f.tenantId, projectId: f.projectId, externalId: { startsWith: `r3b-${scenario}-` } },
      orderBy: { id: "asc" },
    });
    expect(rows).toHaveLength(N);
    const runs: Array<{ run: string; ms: number; sql: number; trueCount: number }> = [];
    for (let i = 0; i < 1 + WARM; i++) {
      sql.length = 0;
      const t0 = performance.now();
      const out = await expenses.withDeleteCapabilities(f.tenantId, rows, f.requester as never);
      const ms = performance.now() - t0;
      const flags = out.map((row) => (row as { canDelete?: boolean }).canDelete);
      runs.push({ run: i === 0 ? "cold" : `warm${i}`, ms: +ms.toFixed(1), sql: sql.length, trueCount: flags.filter((v) => v === true).length });
      expect(flags.every((v) => v === true)).toBe(true);
    }
    sql.length = 0;
    const small = await expenses.withDeleteCapabilities(f.tenantId, rows.slice(0, SMALL_N), f.requester as never);
    expect(small.every((row) => (row as { canDelete?: boolean }).canDelete === true)).toBe(true);
    const smallSql = sql.length;
    results[scenario] = { runs, smallSql, budgetMs: MEDIAN_BUDGET_MS, sqlBudget: SQL_BUDGET[scenario] };
    const warm = runs.slice(1);
    expect(median(warm.map((r) => r.ms))).toBeLessThanOrEqual(MEDIAN_BUDGET_MS);
    for (const r of runs) expect(r.sql).toBeLessThanOrEqual(SQL_BUDGET[scenario]);
    for (const r of runs) expect(r.sql - smallSql).toBeLessThanOrEqual(MAX_EXTRA_SQL_FROM_100_TO_2000);
  }, 120000);
});
