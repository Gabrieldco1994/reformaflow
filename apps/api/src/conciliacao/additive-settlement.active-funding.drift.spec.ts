/**
 * #704 R3 — the SQL guard (`guardActiveFunding`) and the batched read
 * (`assertNoActiveFunding` over a RemovalContext) must never disagree about what
 * "active funding" is. Real PrismaService + test DB, no Prisma fake: the SQL side
 * is executed, not mimicked.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { refundFixture } from "../expense/__tests__/refund-purpose.fixture";
import { RemovalContext, assertNoActiveFunding } from "../expense/removal-context";
import {
  ACTIVE_FUNDING_WHERE,
  ADDITIVE,
  LEGACY_REPLACEMENT,
  guardActiveFunding,
  isActiveFundingRow,
} from "./additive-settlement";

const db = new PrismaClient();
const prisma = new PrismaService();

type Fixture = Awaited<ReturnType<typeof refundFixture>>;
let a: Fixture;
let b: Fixture;
let n = 0;

const expense = (f: Fixture, projectId: string, valorTotal: number) =>
  db.expense.create({
    data: {
      tenantId: f.tenantId, projectId, tipoDespesa: "OUTROS", valor: valorTotal, valorTotal, quantidade: 1,
      formaPagamento: "A_VISTA", status: "PAGO", dataPagamento: new Date("2026-09-10T00:00:00Z"),
    } as never,
  });

const settle = (f: Fixture, sourceExpenseId: string, targetExpenseId: string, mode: string, parcelaIndex: number) => {
  n += 1;
  return db.crossProjectSettlement.create({
    data: {
      tenantId: f.tenantId, sourceExpenseId, targetExpenseId, parcelaIndex, realValor: 1000,
      plannedValor: 5000, plannedStatus: "PLANEJADO", mode,
      ...(mode === ADDITIVE
        ? {
            requestId: `drift-${n}`, createdByUserId: f.requester.id, snapshot: "{}",
            sourceCashFlowEntryId: `sc-${n}`, targetPaidCashFlowEntryId: `tp-${n}`, targetPendingCashFlowEntryId: `tn-${n}`,
          }
        : {}),
    },
  });
};

const ids: Record<string, string> = {};
const rows: Record<string, Awaited<ReturnType<typeof settle>>> = {};

beforeAll(async () => {
  a = await refundFixture(db, prisma, "funding-drift-a");
  b = await refundFixture(db, prisma, "funding-drift-b");
  for (const name of ["active", "legacy", "reverted"]) {
    ids[`${name}-src`] = (await expense(a, a.projectId, -1000)).id;
    ids[`${name}-tgt`] = (await expense(a, a.targetProjectId, 5000)).id;
  }
  ids["b-src"] = (await expense(b, b.projectId, -1000)).id;
  ids["b-tgt"] = (await expense(b, b.targetProjectId, 5000)).id;
  rows.active = await settle(a, ids["active-src"], ids["active-tgt"], ADDITIVE, 0);
  rows.legacy = await settle(a, ids["legacy-src"], ids["legacy-tgt"], LEGACY_REPLACEMENT, 0);
  rows.reverted = await settle(a, ids["reverted-src"], ids["reverted-tgt"], ADDITIVE, 0);
  rows.reverted = await db.crossProjectSettlement.update({
    where: { id: rows.reverted.id },
    data: { reversedAt: new Date(), reversedByUserId: a.requester.id },
  });
  rows.other = await settle(b, ids["b-src"], ids["b-tgt"], ADDITIVE, 0);
}, 120000);

afterAll(async () => {
  await db.crossProjectSettlement.deleteMany({ where: { tenantId: { in: [a.tenantId, b.tenantId] } } });
  await a.cleanup();
  await b.cleanup();
  await db.$disconnect();
  await prisma.$disconnect();
});

const sqlRefuses = async (tenantId: string, subject: string[]) => {
  try {
    await guardActiveFunding(prisma as never, tenantId, subject);
    return false;
  } catch {
    return true;
  }
};

const contextRefuses = async (tenantId: string, subject: string[]) => {
  const ctx = new RemovalContext(tenantId);
  await ctx.loadSettlements(prisma as never, subject);
  try {
    assertNoActiveFunding(ctx, subject);
    return false;
  } catch {
    return true;
  }
};

describe("active funding: SQL predicate === isActiveFundingRow === context read", () => {
  it.each([
    ["active ADDITIVE", "active", true],
    ["LEGACY_REPLACEMENT", "legacy", false],
    ["reverted ADDITIVE", "reverted", false],
    ["other tenant's active ADDITIVE", "other", true],
  ])("row state %s", async (_label, key, expected) => {
    const row = rows[key];
    const inSql = await db.crossProjectSettlement.count({ where: { id: row.id, ...ACTIVE_FUNDING_WHERE } });
    expect(inSql === 1).toBe(expected);
    expect(isActiveFundingRow(row)).toBe(expected);
  });

  // Literal expectations: (tenant scope, subject ids) -> refused?
  const CASES: Array<[string, () => [string, string[]], boolean]> = [
    ["source of an active ADDITIVE", () => [a.tenantId, [ids["active-src"]]], true],
    ["target of an active ADDITIVE", () => [a.tenantId, [ids["active-tgt"]]], true],
    ["source of a LEGACY_REPLACEMENT", () => [a.tenantId, [ids["legacy-src"]]], false],
    ["target of a LEGACY_REPLACEMENT", () => [a.tenantId, [ids["legacy-tgt"]]], false],
    ["source of a reverted ADDITIVE only", () => [a.tenantId, [ids["reverted-src"]]], false],
    ["target of a reverted ADDITIVE only", () => [a.tenantId, [ids["reverted-tgt"]]], false],
    ["mixed batch containing one active", () => [a.tenantId, [ids["legacy-src"], ids["active-tgt"]]], true],
    ["same ids read under ANOTHER tenant", () => [b.tenantId, [ids["active-src"], ids["active-tgt"]]], false],
    ["other tenant's ids under this tenant", () => [a.tenantId, [ids["b-src"], ids["b-tgt"]]], false],
    ["other tenant's ids under its own tenant", () => [b.tenantId, [ids["b-src"]]], true],
    ["ids that participate in no settlement", () => [a.tenantId, ["no-such-expense"]], false],
  ];

  it.each(CASES)("%s", async (_label, build, expected) => {
    const [tenantId, subject] = build();
    expect(await sqlRefuses(tenantId, subject)).toBe(expected);
    expect(await contextRefuses(tenantId, subject)).toBe(expected);
  });
});
