require("../../../../scripts/test-db-env.cjs");

import { ConflictException } from "@nestjs/common";
import {
  PrismaClient,
  type Prisma,
  type CreditCard,
  type CreditCardStatementImport,
} from "@prisma/client";
import {
  ExpenseType,
  type ImportSessionDraftLineV1,
  type ImportSessionObservationViewV1,
} from "@reformaflow/domain";
import * as identity from "./card-purchase-identity";
import { ExpenseService } from "../expense/expense.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { parseStoredExpenseSchedule } from "../expense/documented-schedule";
import { PrismaService } from "../prisma/prisma.service";
import {
  buildSeriesKey,
  CARD_PURCHASE_INSPECTION,
  inspectCardPurchaseCompanions,
  RestoreInspection,
} from "./card-purchase-identity";

/**
 * Import admission must inspect only what can decide the outcome. These tests
 * pin the identity closure (strong ids, homonym cards, monetary guard, foreign
 * CFE, >999 candidates) with literal fixtures and prove, by counting rows the
 * real PrismaService returns, that unrelated cash flow is never hydrated and
 * the RESTORE-only unowned query is not issued for IMPORT.
 */
const TENANT = "qa-p01-import-scope";
const OTHER_TENANT = "qa-p01-import-scope-other";
const P1 = `${TENANT}-p1`;
const P2 = `${TENANT}-p2`;
const P_DELETED = `${TENANT}-pdel`;
const CARD_A = `${TENANT}-card-a`;
const CARD_B = `${TENANT}-card-b`;
const IMPORT_A = `${TENANT}-imp-a`;
const IMPORT_B = `${TENANT}-imp-b`;
const NOW = new Date("2026-09-28T12:00:00.000Z");
const SERIES_A10 = buildSeriesKey(CARD_A, "QA LOJA", 10000, 10);

interface Captured {
  model?: string;
  action: string;
  rows: number;
  hydratedIds: string[];
  isUnownedQuery: boolean;
  take?: number;
  nestedCashFlow: boolean;
  args: unknown;
}

type Purchase = Parameters<typeof identity.classifyCardImport>[2];
type Facts = identity.ImportInspection & {
  imports: readonly Pick<
    CreditCardStatementImport,
    "id" | "tenantId" | "cardId" | "deletedAt"
  >[];
  cards: readonly Pick<
    CreditCard,
    "id" | "tenantId" | "projectId" | "last4" | "deletedAt"
  >[];
};
type InspectBounded = (
  tx: Prisma.TransactionClient,
  tenant: string,
  purchase: Purchase,
  remaining: number,
  isSibling?: (externalId: string) => boolean,
) => Promise<
  | {
      kind: "EXHAUSTED";
      visitedRows: number;
      inspection: Facts;
      admission: identity.ImportAdmission;
    }
  | { kind: "BUDGET_EXCEEDED"; visitedRows: number }
>;
type KeepLine = Pick<
  ImportSessionDraftLineV1,
  | "amountMeaning"
  | "amountCents"
  | "installmentCount"
  | "dataCompra"
  | "firstDueDate"
>;
type KeepObservation = Pick<
  ImportSessionObservationViewV1,
  | "id"
  | "amountMeaning"
  | "amountCents"
  | "installmentCount"
  | "installmentIndex"
  | "dataCompra"
>;
type CheckKeep = (
  tenant: string,
  purchase: Purchase,
  facts: Facts,
  rootId: string,
  line: KeepLine,
  observations: readonly KeepObservation[],
) =>
  | {
      kind: "COMPATIBLE";
      bindings: readonly {
        observationId: string;
        canonicalIndex: number;
        cashFlowEntryId: string;
      }[];
    }
  | { kind: "NEEDS_INPUT" | "BLOCKED" };
function boundedEntry(): InspectBounded {
  const candidate: unknown = Reflect.get(identity, "inspectCardImportInTx");
  function assertEntry(value: unknown): asserts value is InspectBounded {
    expect({ export: "inspectCardImportInTx", type: typeof value }).toEqual({
      export: "inspectCardImportInTx",
      type: "function",
    });
  }
  assertEntry(candidate);
  return candidate;
}
function keepEntry(): CheckKeep {
  const candidate: unknown = Reflect.get(identity, "checkCardImportKeep");
  function assertEntry(value: unknown): asserts value is CheckKeep {
    expect({ export: "checkCardImportKeep", type: typeof value }).toEqual({
      export: "checkCardImportKeep",
      type: "function",
    });
  }
  assertEntry(candidate);
  return candidate;
}

describe("card purchase identity: IMPORT scope", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  let captured: Captured[] = [];
  let capturing = false;
  prisma.$use(async (params, next) => {
    const result = await next(params);
    if (capturing) {
      const list: any[] = Array.isArray(result) ? result : [];
      captured.push({
        model: params.model,
        action: params.action,
        rows: list.length,
        hydratedIds: list
          .filter((row) => row && "cashFlow" in row)
          .map((row) => row.id),
        isUnownedQuery:
          params.model === "CashFlowEntry" &&
          params.args?.where?.expenseId === null,
        take: params.args?.take,
        nestedCashFlow: Boolean(
          params.args?.include?.cashFlow || params.args?.select?.cashFlow,
        ),
        args: structuredClone(params.args),
      });
    }
    return result;
  });

  const inspect = async (
    purchase: Partial<Parameters<typeof inspectCardPurchaseCompanions>[2]>,
    intent: "import" | "restore" = CARD_PURCHASE_INSPECTION.IMPORT,
  ) => {
    captured = [];
    capturing = true;
    try {
      return await prisma.$transaction((tx) =>
        inspectCardPurchaseCompanions(
          tx,
          TENANT,
          {
            cardId: CARD_A,
            projectId: P1,
            merchant: "QA LOJA",
            total: 10,
            seriesKey: SERIES_A10,
            externalId: "purchase-ext",
            dedupeKeyStrong: "purchase-strong",
            ...purchase,
          },
          intent,
        ),
      );
    } finally {
      capturing = false;
    }
  };

  let seq = 0;
  const expense = (data: Record<string, unknown> = {}) => {
    seq += 1;
    return setup.expense.create({
      data: {
        id: `${TENANT}-e-${String(seq).padStart(5, "0")}`,
        tenantId: TENANT,
        projectId: P1,
        tipoDespesa: "OUTROS",
        titulo: "QA LOJA",
        fornecedor: "QA LOJA",
        valor: 10000,
        quantidade: 1,
        valorTotal: 80000,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 8,
        status: "PLANEJADO",
        seriesKey: SERIES_A10,
        cardLast4: "1234",
        importId: IMPORT_A,
        externalId: `ext-${seq}`,
        ...data,
      } as never,
    });
  };
  const cfe = (
    expenseId: string | null,
    data: Record<string, unknown> = {},
    tenantId = TENANT,
  ) => {
    seq += 1;
    return setup.cashFlowEntry.create({
      data: {
        id: `${tenantId}-cf-${String(seq).padStart(5, "0")}`,
        tenantId,
        projectId: tenantId === TENANT ? P1 : `${OTHER_TENANT}-p`,
        expenseId,
        valor: 10000,
        tipo: "DESPESA",
        categoria: "OUTROS",
        data: NOW,
        status: "PLANEJADO",
        formaPagamento: "CARTAO_CREDITO",
        ...data,
      } as never,
    });
  };
  const bulkExpenses = async (rows: Record<string, unknown>[]) => {
    for (let i = 0; i < rows.length; i += 100)
      await setup.expense.createMany({ data: rows.slice(i, i + 100) as never });
  };

  async function wipe() {
    for (const tenantId of [TENANT, OTHER_TENANT]) {
      await setup.cashFlowEntry.deleteMany({ where: { tenantId } });
      await setup.receipt.deleteMany({ where: { tenantId } });
      await setup.expense.deleteMany({ where: { tenantId } });
      await setup.creditCardStatementImport.deleteMany({ where: { tenantId } });
      await setup.creditCard.deleteMany({ where: { tenantId } });
      await setup.project.deleteMany({ where: { tenantId } });
      await setup.user.deleteMany({ where: { tenantId } });
      await setup.tenant.deleteMany({ where: { id: tenantId } });
    }
  }

  beforeAll(async () => {
    await setup.$connect();
    await prisma.$connect();
  });
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
    await setup.$disconnect();
  });
  beforeEach(async () => {
    seq = 0;
    await wipe();
    await setup.tenant.createMany({
      data: [
        { id: TENANT, name: "scope" },
        { id: OTHER_TENANT, name: "other" },
      ],
    });
    await setup.project.createMany({
      data: [
        { id: P1, tenantId: TENANT, type: "PESSOAL", name: "p1" },
        { id: P2, tenantId: TENANT, type: "PESSOAL", name: "p2" },
        {
          id: P_DELETED,
          tenantId: TENANT,
          type: "PESSOAL",
          name: "pd",
          deletedAt: NOW,
        },
        {
          id: `${OTHER_TENANT}-p`,
          tenantId: OTHER_TENANT,
          type: "PESSOAL",
          name: "op",
        },
      ],
    });
    for (const [id, last4] of [
      [CARD_A, "1234"],
      [CARD_B, "1234"],
    ] as const)
      await setup.creditCard.create({
        data: {
          id,
          tenantId: TENANT,
          projectId: P1,
          institution: "ITAU",
          brand: "Visa",
          nickname: id,
          last4,
        },
      });
    await setup.creditCardStatementImport.createMany({
      data: [
        {
          id: IMPORT_A,
          tenantId: TENANT,
          cardId: CARD_A,
          periodLabel: "a",
          source: "OFX",
        },
        {
          id: IMPORT_B,
          tenantId: TENANT,
          cardId: CARD_B,
          periodLabel: "b",
          source: "OFX",
        },
      ],
    });
    await setup.user.create({
      data: {
        id: `${TENANT}-actor`,
        tenantId: TENANT,
        username: `${TENANT}-actor`,
        name: "Synthetic native actor",
        role: "OWNER",
      },
    });
  });

  // ── Hydration / query scope (RED on the full-scan implementation) ────────

  it("hydrates cash flow only for family and strong-identity roots, never unrelated or unowned", async () => {
    const noise: string[] = [];
    for (let i = 0; i < 25; i++) {
      const row = await expense({
        titulo: `NOISE ${i} (2/6)`,
        fornecedor: `NOISE ${i}`,
        seriesKey: buildSeriesKey(CARD_A, `noise ${i}`, 1000, 6),
        quantidadeParcela: 5,
      });
      await cfe(row.id, { valor: 1000 });
      await cfe(row.id, { valor: 1000 });
      noise.push(row.id);
    }
    await cfe(null, { valor: 4321, parcela: "2/5" }); // unowned card CFE
    const family = await expense({ deletedAt: NOW, externalId: "family-ext" });
    const strong = await expense({
      deletedAt: NOW,
      seriesKey: null,
      titulo: "OUTRA",
      fornecedor: "OUTRA",
      quantidadeParcela: null,
      formaPagamento: "A_VISTA",
      dedupeKeyStrong: "purchase-strong",
    });

    const out = await inspect({ total: 10 });
    expect(out.companions.map((row) => row.id).sort()).toEqual(
      [family.id, strong.id].sort(),
    );
    const hydrated = captured.flatMap((call) => call.hydratedIds);
    expect(hydrated.every((id) => [family.id, strong.id].includes(id))).toBe(
      true,
    );
    expect(hydrated.some((id) => noise.includes(id))).toBe(false);
    expect(captured.some((call) => call.model === "CashFlowEntry")).toBe(false);
    expect(captured.some((call) => call.isUnownedQuery)).toBe(false);
  });

  it("a single line reads only its strong-identity rows instead of scanning the tenant", async () => {
    for (let i = 0; i < 25; i++) {
      const row = await expense({
        titulo: `NOISE ${i}`,
        seriesKey: null,
        quantidadeParcela: null,
      });
      await cfe(row.id);
    }
    const strong = await expense({
      deletedAt: NOW,
      externalId: "purchase-ext",
    });
    const out = await inspect({ total: 1, seriesKey: null });
    expect(out.companions.map((row) => row.id)).toEqual([strong.id]);
    const expenseRows = captured
      .filter((call) => call.model === "Expense")
      .reduce((sum, call) => sum + call.rows, 0);
    expect(expenseRows).toBe(1);
    expect(captured.some((call) => call.isUnownedQuery)).toBe(false);
  });

  it("keeps every candidate beyond the 999-parameter boundary (1281 family + 1281 strong-id companions)", async () => {
    const family: Record<string, unknown>[] = [];
    const foreign: Record<string, unknown>[] = [];
    for (let i = 0; i < 1281; i++) {
      const ext = `bulk-ext-${String(i).padStart(4, "0")}`;
      const stamp = String(i).padStart(4, "0");
      family.push({
        id: `${TENANT}-fam-${stamp}`,
        tenantId: TENANT,
        projectId: P1,
        tipoDespesa: "OUTROS",
        titulo: "QA LOJA",
        fornecedor: "QA LOJA",
        valor: 10000,
        quantidade: 1,
        valorTotal: 80000,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 8,
        status: "PLANEJADO",
        seriesKey: SERIES_A10,
        cardLast4: "1234",
        importId: IMPORT_A,
        externalId: ext,
        deletedAt: NOW,
      });
      foreign.push({
        id: `${TENANT}-for-${stamp}`,
        tenantId: TENANT,
        projectId: P2,
        tipoDespesa: "OUTROS",
        titulo: "OUTRA",
        fornecedor: "OUTRA",
        valor: 1,
        quantidade: 1,
        valorTotal: 1,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
        externalId: ext,
        deletedAt: NOW,
      });
    }
    await bulkExpenses([...family, ...foreign]);
    const out = await inspect({ total: 10 });
    expect(out.companions).toHaveLength(2562);
    expect(new Set(out.companions.map((row) => row.id)).size).toBe(2562);
    // With a negation (`id not`) Prisma cannot split an oversized IN list on
    // its own, so the helper's own chunking must carry it.
    const withSelf = await inspect({ total: 10, id: `${TENANT}-self` });
    expect(withSelf.companions).toHaveLength(2562);

    // A receipt matching only the LAST family identity must still be found.
    await setup.receipt.create({
      data: {
        id: `${TENANT}-late-receipt`,
        tenantId: TENANT,
        projectId: P2,
        valor: 1,
        data: NOW,
        tipo: "OUTROS",
        externalId: "bulk-ext-1280",
      },
    });
    await expect(inspect({ total: 10 })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  // ── Identity closure characterization (must hold before and after) ───────

  it("strong external or dedupe identity blocks single lines across project, card and total; a strong receipt too", async () => {
    const other = await expense({
      projectId: P2,
      seriesKey: null,
      quantidadeParcela: null,
      formaPagamento: "A_VISTA",
      valorTotal: 500,
      importId: null,
      cardLast4: "9999",
      externalId: "purchase-ext",
    });
    await cfe(other.id, { projectId: P2 });
    await expect(inspect({ total: 1, seriesKey: null })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.receipt.create({
      data: {
        id: `${TENANT}-strong-r`,
        tenantId: TENANT,
        projectId: P2,
        valor: 1,
        data: NOW,
        tipo: "OUTROS",
        dedupeKeyStrong: "purchase-strong",
      },
    });
    await expect(inspect({ total: 1, seriesKey: null })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("closes over the strong identity of a family row, but not over non-family rows without a match", async () => {
    const family = await expense({ deletedAt: NOW, externalId: "family-ext" });
    const viaFamily = await expense({
      projectId: P2,
      seriesKey: null,
      quantidadeParcela: null,
      formaPagamento: "A_VISTA",
      importId: null,
      cardLast4: null,
      titulo: "X",
      fornecedor: "X",
      externalId: "family-ext",
      deletedAt: NOW,
    });
    const unrelated = await expense({
      seriesKey: buildSeriesKey(CARD_A, "outra loja", 10000, 10),
      fornecedor: "OUTRA LOJA",
      titulo: "OUTRA LOJA (2/10)",
      deletedAt: NOW,
    });
    const out = await inspect({ total: 10 });
    const ids = out.companions.map((row) => row.id);
    expect(ids).toContain(family.id);
    expect(ids).toContain(viaFamily.id);
    expect(ids).not.toContain(unrelated.id);
  });

  it("applies the monetary guard only after cash flow is known, never on a negative total alone", async () => {
    // valorTotal <= 0 and no positive cash flow: not a family member.
    await expense({ valorTotal: 0 });
    await expense({ valorTotal: -500 });
    await expect(inspect({ total: 10 })).resolves.toMatchObject({
      companions: [],
    });
    // valorTotal <= 0 but a positive alive cash flow: still a family member (alive => conflict).
    const negative = await expense({ valorTotal: -500 });
    await cfe(negative.id, { valor: 10000 });
    await expect(inspect({ total: 10 })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("keeps homonym last4 cards apart, and explicit contradictory identities ambiguous", async () => {
    // Explicit import of card B: not card A's family, even with the same last4.
    const viaB = await expense({
      seriesKey: null,
      importId: IMPORT_B,
      titulo: "QA LOJA (3/10)",
      deletedAt: NOW,
    });
    expect(
      (await inspect({ total: 10, seriesKey: null })).companions.map(
        (r) => r.id,
      ),
    ).not.toContain(viaB.id);
    expect(
      (
        await inspect({ cardId: CARD_B, total: 10, seriesKey: null })
      ).companions.map((r) => r.id),
    ).toContain(viaB.id);
    // No explicit identity: falls back to last4, which both homonym cards share.
    const legacy = await expense({
      seriesKey: null,
      importId: null,
      titulo: "QA LOJA (3/10)",
      deletedAt: NOW,
    });
    expect(
      (await inspect({ total: 10, seriesKey: null })).companions.map(
        (r) => r.id,
      ),
    ).toContain(legacy.id);
    expect(
      (
        await inspect({ cardId: CARD_B, total: 10, seriesKey: null })
      ).companions.map((r) => r.id),
    ).toContain(legacy.id);
    // Contradictory explicit identities (import of B, seriesKey of A) are ambiguous for both.
    const contradictory = await expense({ importId: IMPORT_B, deletedAt: NOW });
    expect(
      (await inspect({ total: 10 })).companions.map((r) => r.id),
    ).toContain(contradictory.id);
    expect(
      (
        await inspect({ cardId: CARD_B, total: 10, seriesKey: null })
      ).companions.map((r) => r.id),
    ).toContain(contradictory.id);
  });

  it("counts a foreign-tenant cash flow, but ignores soft-deleted projects and other tenants", async () => {
    await expense({ projectId: P_DELETED }); // alive row in a deleted project: ignored
    await setup.expense.create({
      data: {
        id: `${OTHER_TENANT}-e`,
        tenantId: OTHER_TENANT,
        projectId: `${OTHER_TENANT}-p`,
        tipoDespesa: "OUTROS",
        titulo: "QA LOJA",
        valor: 1,
        quantidade: 1,
        valorTotal: 1,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 8,
        status: "PLANEJADO",
        seriesKey: SERIES_A10,
        externalId: "purchase-ext",
      },
    });
    await expect(inspect({ total: 10 })).resolves.toMatchObject({
      companions: [],
    });
    const tombstone = await expense({ deletedAt: NOW });
    await expect(inspect({ total: 10 })).resolves.toMatchObject({
      companions: [expect.objectContaining({ id: tombstone.id })],
    });
    await cfe(tombstone.id, {}, OTHER_TENANT); // foreign-tenant CFE attached to our tombstone
    await expect(inspect({ total: 10 })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("RESTORE keeps returning companions, receipts, unowned, imports and cards with full rows", async () => {
    await expense({ deletedAt: NOW });
    const out = (await inspect(
      { total: 10, id: `${TENANT}-restoring` },
      CARD_PURCHASE_INSPECTION.RESTORE,
    )) as RestoreInspection;
    expect(Object.keys(out)).toEqual([
      "companions",
      "receipts",
      "unowned",
      "imports",
      "cards",
    ]);
    expect(out.companions).toHaveLength(1);
    expect(out.imports.map((row) => row.id)).toEqual([IMPORT_A, IMPORT_B]);
    expect(out.cards.map((row) => row.id)).toEqual([CARD_A, CARD_B]);
    expect(out.cards[0]).toHaveProperty("createdAt");
    await cfe(null, { valor: 77 });
    await expect(
      inspect(
        { total: 10, id: `${TENANT}-restoring` },
        CARD_PURCHASE_INSPECTION.RESTORE,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(captured.some((call) => call.isUnownedQuery)).toBe(true);
  });

  describe("M1 bounded canonical reads and pure KEEP", () => {
    const purchase = (overrides: Partial<Purchase> = {}): Purchase => ({
      cardId: CARD_A,
      projectId: P1,
      merchant: "QA LOJA",
      total: 10,
      seriesKey: SERIES_A10,
      externalId: "purchase-ext",
      dedupeKeyStrong: "purchase-strong",
      ...overrides,
    });
    async function bounded(
      input = purchase(),
      remaining = 5000,
      sibling?: (id: string) => boolean,
    ) {
      const entry = boundedEntry();
      captured = [];
      capturing = true;
      try {
        const out = await prisma.$transaction((tx) =>
          entry(tx, TENANT, input, remaining, sibling),
        );
        expect(out.visitedRows).toBe(
          captured.reduce((sum, call) => sum + call.rows, 0),
        );
        let used = 0;
        for (const call of captured.filter(
          (call) => call.action === "findMany",
        )) {
          expect(call.take).toBeLessThanOrEqual(
            Math.min(300, remaining - used + 1),
          );
          expect(call.take).toBeGreaterThan(0);
          expect(call.rows).toBeLessThanOrEqual(call.take!);
          expect(call.nestedCashFlow).toBe(false);
          expect(call.isUnownedQuery).toBe(false);
          used += call.rows;
        }
        return out;
      } finally {
        capturing = false;
      }
    }
    async function native(
      partial = false,
      unknownCycle = false,
      single = false,
    ) {
      const months = [
        "2026-11",
        "2026-12",
        "2027-01",
        "2027-02",
        "2027-03",
        "2027-04",
        "2027-05",
        "2027-06",
        "2027-07",
        "2027-08",
      ];
      const selectedMonths = single
        ? months.slice(0, 1)
        : months.slice(partial ? 1 : 0);
      const occurrences = selectedMonths.map((month, index) => ({
        index,
        parcela: single ? null : `${index + (partial ? 2 : 1)}/10`,
        valor: 6984,
        data: `${month}-10`,
        invoiceDueMonth: unknownCycle ? null : month,
      }));
      const service = new ExpenseService(
        prisma,
        new ConciliacaoService(prisma),
      );
      return prisma.$transaction((tx) =>
        service.createPlannedCardPurchaseInTx(
          tx,
          TENANT,
          P1,
          {
            titulo: "QA LOJA",
            fornecedor: "QA LOJA",
            tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
            categoriaMaoDeObra: null,
            dataCompra: "2026-10-05",
            totalCents: single ? 6984 : partial ? 62856 : 69840,
            schedule: { version: 1, occurrences },
            cardId: CARD_A,
            evidence: {
              documentSha256: "a".repeat(64),
              reference: `synthetic-${++seq}`,
            },
            reason:
              "Synthetic documented history without legacy import reference",
          },
          `${TENANT}-actor`,
          { id: `${TENANT}-actor`, role: "OWNER" },
        ),
      );
    }
    const keepPurchase = () =>
      purchase({ seriesKey: null, externalId: null, dedupeKeyStrong: null });
    const line = (change: Partial<KeepLine> = {}): KeepLine => ({
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 6984,
      installmentCount: 10,
      dataCompra: "2026-10-05",
      firstDueDate: "2026-11-10",
      ...change,
    });
    const observation = (
      change: Partial<KeepObservation> = {},
    ): KeepObservation => ({
      id: "observation-2-of-10",
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 6984,
      installmentCount: 10,
      installmentIndex: 2,
      dataCompra: "2026-10-05",
      ...change,
    });
    async function facts(): Promise<Facts> {
      const out = await bounded(keepPurchase());
      expect(out.kind).toBe("EXHAUSTED");
      if (out.kind !== "EXHAUSTED")
        throw new Error("Expected complete inspection");
      return out.inspection;
    }

    it("CONTROL: native full/partial V2 facts really use 2/10 at local indices 1/0", async () => {
      const full = await native();
      const partial = await native(true);
      expect(
        parseStoredExpenseSchedule(full.documentedSchedule)?.occurrences[1],
      ).toMatchObject({
        index: 1,
        parcela: "2/10",
        valor: 6984,
        data: "2026-12-10",
      });
      expect(
        parseStoredExpenseSchedule(partial.documentedSchedule)?.occurrences[0],
      ).toMatchObject({
        index: 0,
        parcela: "2/10",
        valor: 6984,
        data: "2026-12-10",
      });
    });

    it.each([
      "scalar",
      "import",
      "card",
      "root",
      "CFE",
      "strong-closure",
      "Receipt",
    ] as const)(
      "caps_every_materializing_card_read: overflow during %s exposes no partial facts",
      async (stage) => {
        boundedEntry();
        const root = await expense({ externalId: "family-ext" });
        await cfe(root.id, { parcela: "3/10" });
        await cfe(root.id, { parcela: "4/10" });
        await expense({
          projectId: P2,
          importId: IMPORT_B,
          externalId: "family-ext",
          seriesKey: null,
          quantidadeParcela: 1,
          titulo: "OTHER",
          fornecedor: "OTHER",
        });
        await setup.receipt.create({
          data: {
            id: `${TENANT}-bounded-receipt`,
            tenantId: TENANT,
            projectId: P2,
            valor: 1,
            data: NOW,
            tipo: "OUTROS",
            externalId: "family-ext",
          },
        });
        await bounded();
        const calls = captured.filter((call) => call.action === "findMany");
        const index = calls.findIndex(
          (call) =>
            call.rows > 0 &&
            (stage === "scalar"
              ? call.model === "Expense" &&
                !JSON.stringify(call.args).includes("_count")
              : stage === "root"
                ? call.model === "Expense" &&
                  JSON.stringify(call.args).includes("_count")
                : stage === "strong-closure"
                  ? call.model === "Expense" &&
                    JSON.stringify(call.args).includes("family-ext")
                  : call.model ===
                    {
                      import: "CreditCardStatementImport",
                      card: "CreditCard",
                      CFE: "CashFlowEntry",
                      Receipt: "Receipt",
                    }[stage]),
        );
        expect(index).toBeGreaterThanOrEqual(0);
        const remaining = calls
          .slice(0, index)
          .reduce((sum, call) => sum + call.rows, 0);
        expect(await bounded(purchase(), remaining)).toEqual({
          kind: "BUDGET_EXCEEDED",
          visitedRows: remaining + 1,
        });
        expect(
          captured.filter((call) => call.action === "findMany").at(-1)?.rows,
        ).toBe(1);
      },
    );

    it.each([
      "CLEAR",
      "REVIEW",
      "strong",
      "tombstone",
      "foreign-count",
      "sibling",
      "V2",
    ] as const)("bounded_admission_preserves_legacy: %s", async (scenario) => {
      boundedEntry();
      let sibling: ((id: string) => boolean) | undefined;
      if (scenario === "V2") await native();
      else if (scenario !== "CLEAR") {
        const root = await expense({
          externalId: scenario === "strong" ? "purchase-ext" : "sibling-ext",
          deletedAt: scenario === "tombstone" ? NOW : null,
        });
        if (scenario !== "tombstone") await cfe(root.id, { parcela: "3/10" });
        if (scenario === "REVIEW") {
          const twin = await expense();
          await cfe(twin.id, { parcela: "3/10" });
        }
        if (scenario === "foreign-count") await cfe(root.id, {}, OTHER_TENANT);
        if (scenario === "sibling") sibling = (id) => id === "sibling-ext";
      }
      const expected = await prisma.$transaction((tx) =>
        identity.classifyCardImport(tx, TENANT, purchase(), sibling),
      );
      const out = await bounded(purchase(), 5000, sibling);
      expect(out.kind).toBe("EXHAUSTED");
      if (out.kind !== "EXHAUSTED")
        throw new Error("Expected complete inspection");
      expect(out.admission).toEqual(expected);
      if (scenario === "foreign-count") {
        expect(out.inspection.companions[0]._count.cashFlow).toBe(1);
        expect(
          out.inspection.companions[0].cashFlow.every(
            (row) => row.tenantId === TENANT,
          ),
        ).toBe(true);
      }
    });

    it("strong-only root imports are included and scopes are not narrowed to purchase.projectId", async () => {
      boundedEntry();
      const root = await expense({
        projectId: P2,
        externalId: "purchase-ext",
        importId: IMPORT_B,
        seriesKey: null,
        quantidadeParcela: 1,
      });
      const out = await bounded(purchase({ total: 1, seriesKey: null }));
      expect(out.kind).toBe("EXHAUSTED");
      if (out.kind !== "EXHAUSTED")
        throw new Error("Expected complete inspection");
      expect(out.inspection.companions.map((row) => row.id)).toEqual([root.id]);
      expect(out.inspection.imports).toContainEqual({
        id: IMPORT_B,
        tenantId: TENANT,
        cardId: CARD_B,
        deletedAt: null,
      });
      expect(out.inspection.cards.some((row) => row.id === CARD_B)).toBe(true);
    });

    it("key chunks retain the last of 301 family identities and its cross-project Receipt", async () => {
      boundedEntry();
      for (let index = 0; index < 301; index += 1) {
        await expense({
          externalId: `family-chunk-${String(index).padStart(3, "0")}`,
        });
      }
      await setup.receipt.create({
        data: {
          id: `${TENANT}-last-chunk`,
          tenantId: TENANT,
          projectId: P2,
          valor: 1,
          data: NOW,
          tipo: "OUTROS",
          externalId: "family-chunk-300",
        },
      });
      const out = await bounded();
      expect(out.kind).toBe("EXHAUSTED");
      if (out.kind !== "EXHAUSTED")
        throw new Error("Expected complete inspection");
      expect(out.inspection.companions).toHaveLength(301);
      expect(out.inspection.receipts.map((row) => row.id)).toEqual([
        `${TENANT}-last-chunk`,
      ]);
      expect(out.admission).toEqual({ kind: "BLOCKED", sameSeries: false });
    });

    it("zero balance queries with take1; no invented exhaustion or fresh 5000 allowance", async () => {
      boundedEntry();
      expect(
        await bounded(purchase({ cardId: "missing", total: 1 }), 0),
      ).toMatchObject({
        kind: "EXHAUSTED",
        visitedRows: 0,
      });
      expect(
        captured.filter((call) => call.action === "findMany").length,
      ).toBeGreaterThan(0);
      expect(await bounded(purchase(), 0)).toEqual({
        kind: "BUDGET_EXCEEDED",
        visitedRows: 1,
      });
    });

    it.each([-1, 0.25, NaN, Infinity])(
      "invalid card remaining %s fails before reads",
      async (remaining) => {
        const entry = boundedEntry();
        captured = [];
        capturing = true;
        try {
          await expect(
            prisma.$transaction((tx) =>
              entry(tx, TENANT, purchase(), remaining),
            ),
          ).rejects.toBeInstanceOf(RangeError);
          expect(captured).toEqual([]);
        } finally {
          capturing = false;
        }
      },
    );

    it("global_balance_and_fresh_recheck observes new CFEs and spends only the supplied remainder", async () => {
      boundedEntry();
      const root = await expense();
      const first = await bounded();
      expect(first.kind).toBe("EXHAUSTED");
      await cfe(root.id, { parcela: "3/10" });
      const fresh = await bounded();
      expect(fresh.kind).toBe("EXHAUSTED");
      if (first.kind !== "EXHAUSTED" || fresh.kind !== "EXHAUSTED")
        throw new Error("Expected complete inspection");
      expect(fresh.inspection.companions[0].cashFlow).toHaveLength(1);
      expect(first.inspection.companions[0].cashFlow).toHaveLength(0);
      expect((await bounded(purchase(), first.visitedRows)).kind).toBe(
        "BUDGET_EXCEEDED",
      );
    });

    it("twins_require_explicit_keep: V2 admission remains BLOCKED, both roots can bind observation2 to local1", async () => {
      const check = keepEntry();
      const first = await native();
      const second = await native();
      const out = await bounded(keepPurchase());
      expect(out.kind).toBe("EXHAUSTED");
      if (out.kind !== "EXHAUSTED")
        throw new Error("Expected complete inspection");
      expect(out.admission).toEqual({ kind: "BLOCKED", sameSeries: false });
      const before = JSON.stringify(out.inspection);
      for (const root of [first, second]) {
        const cash = out.inspection.companions
          .find((row) => row.id === root.id)!
          .cashFlow.find((row) => row.parcela === "2/10")!;
        expect(
          check(TENANT, keepPurchase(), out.inspection, root.id, line(), [
            observation(),
          ]),
        ).toEqual({
          kind: "COMPATIBLE",
          bindings: [
            {
              observationId: "observation-2-of-10",
              canonicalIndex: 1,
              cashFlowEntryId: cash.id,
            },
          ],
        });
      }
      expect(JSON.stringify(out.inspection)).toBe(before);
      expect(
        check(TENANT, keepPurchase(), out.inspection, "not-selected", line(), [
          observation(),
        ]),
      ).toEqual({ kind: "BLOCKED" });
    });

    it("printed_index_is_not_local_index: first remaining 2/10 binds local0, not printed minus one", async () => {
      const check = keepEntry();
      const root = await native(true);
      const current = await facts();
      const cash = current.companions[0].cashFlow.find(
        (row) => row.parcela === "2/10",
      )!;
      expect(
        check(
          TENANT,
          keepPurchase(),
          current,
          root.id,
          line({ firstDueDate: "2026-12-10" }),
          [observation()],
        ),
      ).toEqual({
        kind: "COMPATIBLE",
        bindings: [
          {
            observationId: "observation-2-of-10",
            canonicalIndex: 0,
            cashFlowEntryId: cash.id,
          },
        ],
      });
    });

    describe("canonical-gap regressions", () => {
      it("full first anchor permits later observations with their own distinct cycles", async () => {
        const check = keepEntry();
        const root = await native();
        const current = await facts();
        const observations = [
          observation(),
          observation({ id: "observation-3-of-10", installmentIndex: 3 }),
        ];
        const before = JSON.stringify(current);
        expect(
          check(
            TENANT,
            keepPurchase(),
            current,
            root.id,
            line({ firstDueDate: "2026-11-10" }),
            observations,
          ),
        ).toEqual({
          kind: "COMPATIBLE",
          bindings: observations.map((item, index) => ({
            observationId: item.id,
            canonicalIndex: index + 1,
            cashFlowEntryId: current.companions[0].cashFlow.find(
              (cash) => cash.parcela === `${index + 2}/10`,
            )!.id,
          })),
        });
        expect(JSON.stringify(current)).toBe(before);
      });

      it.each([false, true])(
        "known first-date contradictions remain blocked with historical unknown cycles=%s",
        async (unknownCycle) => {
          const check = keepEntry();
          const root = await native(false, unknownCycle);
          const current = await facts();
          const first = [observation({ installmentIndex: 1 })];
          expect(
            check(TENANT, keepPurchase(), current, root.id, line(), first).kind,
          ).toBe("COMPATIBLE");
          const before = JSON.stringify(current);
          for (const firstDueDate of ["2026-11-11", "2026-12-10"])
            expect(
              check(
                TENANT,
                keepPurchase(),
                current,
                root.id,
                line({ firstDueDate }),
                first,
              ),
            ).toEqual({ kind: "BLOCKED" });
          expect(JSON.stringify(current)).toBe(before);
        },
      );

      it("V1 import tombstone blocks independently; an absent import remains NEEDS_INPUT", async () => {
        const check = keepEntry();
        const root = await native();
        const stored = parseStoredExpenseSchedule(root.documentedSchedule)!;
        const { version: _version, ...rest } = stored;
        const v1 = {
          ...rest,
          version: 1,
          importId: IMPORT_A,
          externalId: "v1-source",
        };
        Reflect.deleteProperty(v1, "provenance");
        await setup.expense.update({
          where: { id: root.id },
          data: {
            importId: IMPORT_A,
            externalId: "v1-source",
            documentedSchedule: JSON.stringify(v1),
          },
        });
        const input = line({ firstDueDate: null });
        const current = await facts();
        expect(
          check(TENANT, keepPurchase(), current, root.id, input, [
            observation(),
          ]).kind,
        ).toBe("COMPATIBLE");
        expect(
          check(
            TENANT,
            keepPurchase(),
            { ...current, imports: [] },
            root.id,
            input,
            [observation()],
          ),
        ).toEqual({ kind: "NEEDS_INPUT" });
        await prisma.creditCardStatementImport.delete({
          where: { id: IMPORT_A },
        });
        const deleted = await facts();
        expect(
          deleted.imports.find((item) => item.id === IMPORT_A)?.deletedAt,
        ).toBeInstanceOf(Date);
        const before = JSON.stringify(deleted);
        expect(
          check(TENANT, keepPurchase(), deleted, root.id, input, [
            observation(),
          ]),
        ).toEqual({ kind: "BLOCKED" });
        expect(JSON.stringify(deleted)).toBe(before);
      });
    });

    it("consistent V1 identities are accepted without rewriting the import or schedule", async () => {
      const check = keepEntry();
      const root = await native();
      const stored = parseStoredExpenseSchedule(root.documentedSchedule)!;
      expect(stored.kind).toBe("source");
      const { version: _version, ...rest } = stored;
      const v1 = {
        ...rest,
        version: 1,
        importId: IMPORT_A,
        externalId: "v1-source",
      };
      Reflect.deleteProperty(v1, "provenance");
      await setup.expense.update({
        where: { id: root.id },
        data: {
          importId: IMPORT_A,
          externalId: "v1-source",
          documentedSchedule: JSON.stringify(v1),
        },
      });
      expect(
        check(TENANT, keepPurchase(), await facts(), root.id, line(), [
          observation(),
        ]).kind,
      ).toBe("COMPATIBLE");
      const current = await facts();
      current.imports.find((row) => row.id === IMPORT_A)!.cardId = CARD_B;
      expect(
        check(TENANT, keepPurchase(), current, root.id, line(), [
          observation(),
        ]),
      ).toEqual({ kind: "BLOCKED" });
    });

    it("single occurrence retains the canonical null/1/1 label equivalence", async () => {
      const check = keepEntry();
      const root = await native(false, false, true);
      const cashFlow = await prisma.cashFlowEntry.findMany({
        where: { tenantId: TENANT, expenseId: root.id },
      });
      cashFlow[0].parcela = "1/1";
      const current: Facts = {
        companions: [{ ...root, cashFlow, _count: { cashFlow: 0 } }],
        receipts: [],
        imports: [],
        cards: await prisma.creditCard.findMany({
          where: { tenantId: TENANT, id: CARD_A },
        }),
      };
      const before = JSON.stringify(current);
      expect(
        check(
          TENANT,
          purchase({
            total: 1,
            seriesKey: null,
            externalId: null,
            dedupeKeyStrong: null,
          }),
          current,
          root.id,
          line({ installmentCount: 1, firstDueDate: "2026-11-10" }),
          [observation({ installmentCount: 1, installmentIndex: null })],
        ),
      ).toEqual({
        kind: "COMPATIBLE",
        bindings: [
          {
            observationId: "observation-2-of-10",
            canonicalIndex: 0,
            cashFlowEntryId: cashFlow[0].id,
          },
        ],
      });
      expect(JSON.stringify(current)).toBe(before);
    });

    it("selected source cannot neutralize a strong collision in the complete family", async () => {
      const check = keepEntry();
      const root = await native();
      await native();
      const current = await facts();
      for (const row of current.companions)
        row.dedupeKeyStrong = "shared-existing-identity";
      expect(
        check(TENANT, keepPurchase(), current, root.id, line(), [
          observation(),
        ]),
      ).toEqual({ kind: "BLOCKED" });
    });

    it("keep_preserves_paid_and_unknown_cycles without defaulting the historical invoice month", async () => {
      const check = keepEntry();
      const root = await native(false, true);
      const service = new ExpenseService(
        prisma,
        new ConciliacaoService(prisma),
      );
      await prisma.$transaction((tx) =>
        service.markPaidInPlace(TENANT, root.id, new Date("2026-12-10"), tx),
      );
      const current = await facts();
      const before = JSON.stringify(current);
      expect(
        check(TENANT, keepPurchase(), current, root.id, line(), [observation()])
          .kind,
      ).toBe("COMPATIBLE");
      expect(JSON.stringify(current)).toBe(before);
      expect(
        current.companions[0].cashFlow.every(
          (row) => row.status === "PAGO" && row.invoiceDueMonth === null,
        ),
      ).toBe(true);
    });

    it.each([
      "value",
      "date",
      "cycle",
      "source-id",
      "tenant",
      "card",
      "import-card",
      "tombstone",
      "strong",
      "Receipt",
      "foreign-count",
    ] as const)(
      "KEEP blocks known %s contradiction without changing financial facts",
      async (scenario) => {
        const check = keepEntry();
        const root = await native();
        const current = await facts();
        const selected = current.companions.find((row) => row.id === root.id)!;
        const cash = selected.cashFlow.find((row) => row.parcela === "2/10")!;
        if (scenario === "value") cash.valor += 1;
        if (scenario === "date") cash.data = new Date("2026-12-11");
        if (scenario === "cycle") cash.invoiceDueMonth = "2027-01";
        if (scenario === "tenant") selected.tenantId = OTHER_TENANT;
        if (scenario === "tombstone") selected.deletedAt = NOW;
        if (scenario === "strong") selected.externalId = "purchase-ext";
        if (scenario === "foreign-count") selected._count.cashFlow = 1;
        if (scenario === "source-id" || scenario === "card") {
          const schedule = parseStoredExpenseSchedule(
            selected.documentedSchedule,
          )!;
          if (scenario === "source-id")
            schedule.sourceExpenseId = "different-root";
          else schedule.cardId = CARD_B;
          selected.documentedSchedule = JSON.stringify(schedule);
        }
        if (scenario === "import-card") {
          selected.importId = IMPORT_B;
          current.imports = [
            { id: IMPORT_B, tenantId: TENANT, cardId: CARD_B, deletedAt: null },
          ];
        }
        if (scenario === "Receipt") {
          const row = await setup.receipt.create({
            data: {
              tenantId: TENANT,
              projectId: P2,
              valor: 6984,
              data: NOW,
              tipo: "OUTROS",
              externalId: "purchase-ext",
            },
          });
          current.receipts.push(row);
        }
        const before = JSON.stringify(current);
        expect(
          check(
            TENANT,
            scenario === "strong" ? purchase() : keepPurchase(),
            current,
            root.id,
            line(),
            [observation()],
          ),
        ).toEqual({ kind: "BLOCKED" });
        expect(JSON.stringify(current)).toBe(before);
      },
    );

    it.each([
      "no-schedule",
      "unknown-amount",
      "no-printed-index",
      "duplicate-label",
    ] as const)(
      "KEEP %s is insufficient, never a generated/default binding",
      async (scenario) => {
        const check = keepEntry();
        const root = await native();
        const current = await facts();
        const selected = current.companions[0];
        const observed = observation();
        if (scenario === "no-schedule") selected.documentedSchedule = null;
        if (scenario === "unknown-amount") observed.amountCents = null;
        if (scenario === "no-printed-index") observed.installmentIndex = null;
        if (scenario === "duplicate-label") {
          const stored = parseStoredExpenseSchedule(
            selected.documentedSchedule,
          )!;
          stored.occurrences[2].parcela = "2/10";
          selected.documentedSchedule = JSON.stringify(stored);
        }
        expect(
          check(TENANT, keepPurchase(), current, root.id, line(), [observed]),
        ).toEqual({ kind: "NEEDS_INPUT" });
      },
    );

    it("INSTALLMENT_CHARGE is compared to one occurrence, never multiplied into TOTAL_PURCHASE", async () => {
      const check = keepEntry();
      const root = await native();
      const current = await facts();
      expect(
        check(
          TENANT,
          keepPurchase(),
          current,
          root.id,
          line({ amountCents: 69840 }),
          [observation()],
        ),
      ).toEqual({ kind: "BLOCKED" });
      expect(
        check(
          TENANT,
          keepPurchase(),
          current,
          root.id,
          line({ amountMeaning: "TOTAL_PURCHASE", amountCents: 69840 }),
          [
            observation({
              amountMeaning: "TOTAL_PURCHASE",
              amountCents: 69840,
            }),
          ],
        ).kind,
      ).toBe("COMPATIBLE");
    });
  });
});
