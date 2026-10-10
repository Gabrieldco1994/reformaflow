/**
 * #704 R3 QA — scale: the exact list path the UI calls (findAll pageSize 2000 -> withDeleteCapabilities)
 * on 2000 real purpose sources / legacy linked sources, real PrismaService. The old per-source planner
 * hit P2028 (5 s interactive-tx timeout) at 1000+. Fixed sequence, 1 warm + 5 samples, every sample
 * asserted (no best-of), timeout untouched. Beyond "no error" it pins cardinality, ids, order, sums,
 * the exact set of planted `false` rows (a claimed source, a soft-deleted target), zero writes, an
 * unchanged DB digest, and that capability agrees with the real DELETE on a sample.
 */

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
const WARM = 1;
const SAMPLES = 5;
// Generous vs the ~300 ms measured; the failure being guarded is a 5 s transaction timeout.
const MAX_CAPS_MS = 4000;
const SQL_BUDGET = {
  normal: 25,
  purpose: 70,
  linked: 50,
  targets: 40,
} as const;

const db = new PrismaClient();
const prisma = new PrismaService();
const expenses = new ExpenseService(prisma, new ConciliacaoService(prisma));
const sql: Array<{ q: string; ms: number }> = [];
(prisma as any).$on("query", (e: { query: string; duration: number }) =>
  sql.push({ q: e.query, ms: e.duration }),
);
const writes: string[] = [];
prisma.$use(async (params, next) => {
  if (
    /^(create|createMany|update|updateMany|delete|deleteMany|upsert|executeRaw)/.test(
      params.action,
    )
  )
    writes.push(`${params.model}.${params.action}`);
  return next(params);
});

type Scenario = "normal" | "purpose" | "linked";
const claimEvery = (i: number) => i % 100 === 7; // planted false: an active ledger claim on the source
const targetGoneEvery = (i: number) => i % 100 === 13; // planted false: soft-deleted target

async function seed(scenario: Scenario, n: number) {
  const f = await refundFixture(db, prisma, "refund-r3-cand");
  if (scenario !== "normal") await f.apply();
  const src = await db.expense.findUniqueOrThrow({
    where: { id: f.source.id },
  });
  const srcCfe = await db.cashFlowEntry.findMany({
    where: { expenseId: src.id },
  });
  const edge =
    scenario !== "normal"
      ? await db.rateioAllocation.findFirstOrThrow({
          where: { sourceExpenseId: src.id },
        })
      : null;
  const tgt = edge
    ? await db.expense.findUniqueOrThrow({
        where: { id: edge.targetExpenseId },
      })
    : null;
  const tgtCfe = tgt
    ? await db.cashFlowEntry.findMany({ where: { expenseId: tgt.id } })
    : [];
  const S: any[] = [],
    T: any[] = [],
    C: any[] = [],
    E: any[] = [],
    L: any[] = [];
  const expectFalse = new Set<string>();
  const sourceIds: string[] = [f.source.id];
  const targetIds: string[] = tgt ? [tgt.id] : [];
  const imp = `${f.tenantId}-imp`;
  if (scenario !== "normal") {
    // a real import + card so planted claims satisfy the FKs
  }
  for (let i = 1; i < n; i++) {
    const sid = `r3c-${scenario}-${i}-s`,
      tid = `r3c-${scenario}-${i}-t`;
    const createdAt = new Date(Date.UTC(2026, 8, 1, 0, 0, i));
    S.push({
      ...src,
      id: sid,
      externalId: `r3c-${scenario}-${i}`,
      linkedExpenseId: tgt ? tid : null,
      createdAt,
      updatedAt: createdAt,
    });
    sourceIds.push(sid);
    for (const c of srcCfe)
      C.push({ ...c, id: `${sid}-c${c.id.slice(-4)}`, expenseId: sid });
    if (tgt && edge) {
      T.push({
        ...tgt,
        id: tid,
        createdAt,
        updatedAt: createdAt,
        deletedAt: targetGoneEvery(i) ? createdAt : null,
      });
      targetIds.push(tid);
      for (const c of tgtCfe)
        C.push({ ...c, id: `${tid}-c${c.id.slice(-4)}`, expenseId: tid });
      if (scenario === "purpose")
        E.push({
          ...edge,
          id: `r3c-${scenario}-${i}-e`,
          sourceExpenseId: sid,
          targetExpenseId: tid,
        });
      if (targetGoneEvery(i)) expectFalse.add(sid);
    }
    if (scenario !== "normal" && claimEvery(i)) {
      expectFalse.add(sid);
      L.push({ sid, cfeId: `${sid}-c${srcCfe[0].id.slice(-4)}` });
    }
  }
  await db.expense.createMany({ data: [...S, ...T] });
  await db.cashFlowEntry.createMany({ data: C });
  if (E.length) await db.rateioAllocation.createMany({ data: E });
  if (L.length) {
    const account = await db.bankAccount.findFirst({
      where: { tenantId: f.tenantId },
    });
    const acc =
      account ??
      (await (
        await import("../bank-account/__tests__/invoice-undo.fixtures")
      ).seedBankAccount(db, {
        tenantId: f.tenantId,
        projectId: f.projectId,
        last4: "0706",
      }));
    await (
      await import("../bank-account/__tests__/invoice-undo.fixtures")
    ).seedStatementImport(db, {
      tenantId: f.tenantId,
      accountId: acc.id,
      id: imp,
    });
    await db.importedInvoiceLiquidation.createMany({
      data: L.map((x, k) => ({
        id: `r3c-l-${k}`,
        tenantId: f.tenantId,
        paymentExpenseId: x.sid,
        importId: imp,
        purchaseExpenseId: x.sid,
        cashFlowEntryId: x.cfeId,
        cardId: f.card.id,
        prevStatus: "PLANEJADO",
        entryValorCents: 100,
        dueMonth: "2026-09",
      })),
    });
  }
  return { f, sourceIds, targetIds, expectFalse };
}

const digest = async (tenantId: string) => {
  const one = async (q: string) =>
    (await db.$queryRawUnsafe<any[]>(q, tenantId))[0];
  const e = await one(
    `SELECT COUNT(*) c, COALESCE(SUM(valor_total),0) v, COALESCE(MAX(updated_at),0) u, SUM(deleted_at IS NOT NULL) d, SUM(linked_expense_id IS NOT NULL) l FROM expenses WHERE tenant_id=?`,
  );
  const c = await one(
    `SELECT COUNT(*) c, COALESCE(SUM(valor),0) v, SUM(deleted_at IS NOT NULL) d FROM cash_flow_entries WHERE tenant_id=?`,
  );
  const a = await one(
    `SELECT COUNT(*) c, COALESCE(SUM(allocation),0) v FROM rateio_allocations WHERE tenant_id=?`,
  );
  const s = await one(
    `SELECT COUNT(*) c FROM cross_project_settlements WHERE tenant_id=?`,
  );
  const l = await one(
    `SELECT COUNT(*) c, SUM(deleted_at IS NOT NULL) d FROM imported_invoice_liquidations WHERE tenant_id=?`,
  );
  return JSON.parse(
    JSON.stringify({ e, c, a, s, l }, (_k, v) =>
      typeof v === "bigint" ? Number(v) : v,
    ),
  );
};

const num = (v: unknown) => Number(v);

type Sample = { capsMs: number; capsSql: number; findAllSql: number };

async function sample(
  tenantId: string,
  projectId: string,
  expectedIds: string[],
  expectFalse: Set<string>,
  expectAllTrue: boolean,
  budget: number,
) {
  const actor = { id: `${tenantId}-owner`, role: "OWNER" };
  const expectedSet = new Set(expectedIds);
  const dbSum = num(
    (
      await db.$queryRawUnsafe<any[]>(
        `SELECT COALESCE(SUM(valor_total),0) v FROM expenses WHERE tenant_id=? AND project_id=? AND deleted_at IS NULL`,
        tenantId,
        projectId,
      )
    )[0].v,
  );
  const dbCount = num(
    (
      await db.$queryRawUnsafe<any[]>(
        `SELECT COUNT(*) c FROM expenses WHERE tenant_id=? AND project_id=? AND deleted_at IS NULL`,
        tenantId,
        projectId,
      )
    )[0].c,
  );
  expect(dbCount).toBe(expectedIds.length);
  const samples: Sample[] = [];
  for (let run = 0; run < WARM + SAMPLES; run++) {
    const before = await digest(tenantId);
    sql.length = 0;
    writes.length = 0;
    const page = await expenses.findAll(
      tenantId,
      projectId,
      { page: 1, pageSize: 2000 },
      actor as never,
    );
    const findAllSql = sql.length;
    expect(page.items).toHaveLength(dbCount);
    expect(page.total).toBe(dbCount);
    sql.length = 0;
    const t1 = performance.now();
    const out: any[] = await expenses.withDeleteCapabilities(
      tenantId,
      page.items,
      actor as never,
    );
    const capsMs = performance.now() - t1;
    const capsSql = sql.length;
    const trueIds = out.filter((r) => r.canDelete === true).map((r) => r.id);
    const falseIds = out.filter((r) => r.canDelete === false).map((r) => r.id);
    expect(out).toHaveLength(dbCount);
    expect(out.map((r) => r.id)).toEqual(page.items.map((r: any) => r.id));
    expect(new Set(out.map((r) => r.id))).toEqual(expectedSet);
    expect(out.reduce((a, r) => a + r.valorTotal, 0)).toBe(dbSum);
    expect(trueIds.length + falseIds.length).toBe(dbCount);
    expect(new Set(falseIds)).toEqual(
      expectAllTrue ? expectFalse : expectedSet,
    );
    if (expectAllTrue)
      expect(trueIds.every((id) => !expectFalse.has(id))).toBe(true);
    else expect(trueIds).toHaveLength(0);
    expect(writes).toEqual([]);
    expect(await digest(tenantId)).toEqual(before);
    expect(capsMs).toBeLessThan(MAX_CAPS_MS);
    expect(capsSql).toBeLessThanOrEqual(budget);
    samples.push({ capsMs, capsSql, findAllSql });
  }
  return samples;
}

describe("#704 R3 QA canDelete at list scale (2000, real PrismaService)", () => {
  it.each(["normal", "purpose", "linked"] as const)(
    "%s sources: exact true/false sets, zero writes, budgeted SQL",
    async (scenario) => {
      const { f, sourceIds, expectFalse } = await seed(scenario, N);
      try {
        expect(sourceIds).toHaveLength(N);
        await sample(
          f.tenantId,
          f.projectId,
          sourceIds,
          expectFalse,
          true,
          SQL_BUDGET[scenario],
        );
        if (scenario === "purpose") {
          // Protected refund targets are never deletable: every live target is false.
          const live = await db.expense.findMany({
            where: {
              tenantId: f.tenantId,
              projectId: f.targetProjectId,
              deletedAt: null,
            },
            select: { id: true },
          });
          expect(live).toHaveLength(1980); // 2000 targets, 20 planted soft-deleted (i % 100 === 13)
          await sample(
            f.tenantId,
            f.targetProjectId,
            live.map((x) => x.id),
            new Set(live.map((x) => x.id)),
            false,
            SQL_BUDGET.targets,
          );
        }
        if (scenario !== "normal") {
          // capability agrees with the real DELETE on the same rows, after the timed runs
          const actor = { id: `${f.tenantId}-owner`, role: "OWNER" };
          const picks = [
            ...sourceIds.filter((id) => !expectFalse.has(id)).slice(1, 7),
            ...[...expectFalse].slice(0, 6),
          ];
          for (const id of picks) {
            const r = await db.expense.findUniqueOrThrow({ where: { id } });
            const [cap] = await expenses.withDeleteCapabilities(
              f.tenantId,
              [r] as never,
              actor as never,
            );
            let outcome: "ok" | number = "ok";
            try {
              await expenses.remove(
                f.tenantId,
                f.projectId,
                id,
                actor as never,
              );
            } catch (e) {
              outcome = (e as any).status ?? -1;
            }
            expect([id, (cap as any).canDelete]).toEqual([
              id,
              !expectFalse.has(id),
            ]);
            expect([id, outcome === "ok"]).toEqual([id, !expectFalse.has(id)]);
            expect(
              (await db.expense.findUniqueOrThrow({ where: { id } }))
                .deletedAt !== null,
            ).toBe(!expectFalse.has(id));
          }
        }
      } finally {
        await f.cleanup();
      }
    },
    300000,
  );
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});
