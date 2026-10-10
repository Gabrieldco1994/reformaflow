/**
 * #704 read contract — `expenseIsCredit` is the AUTHORITATIVE, read-only sign of
 * the source `Expense.valorTotal` (< 0). It never comes from the CFE/occurrence
 * value or the window, and it is omitted when there is no Expense row.
 * It expresses no purpose, ownership, canDelete or permission.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { MonthlyOverviewService } from "./monthly-overview.service";
import { PendenciaService } from "../pendencia/pendencia.service";
import {
  resetTenant,
  seedBankAccount,
  seedPessoal,
} from "../bank-account/__tests__/invoice-undo.fixtures";

const TENANT = "credit-flag";
const PROJECT = `${TENANT}-personal`;
const REQUESTER = { id: `${TENANT}-owner`, role: "OWNER" };
const MONTH = "2026-09";

/** Two occurrences whose SIGNS deliberately disagree with the root's sign. */
const schedule = (id: string, first: number, second: number) =>
  JSON.stringify({
    version: 1,
    kind: "source",
    tenantId: TENANT,
    sourceExpenseId: id,
    sourceProjectId: PROJECT,
    cardId: "synthetic-card",
    recordedByUserId: REQUESTER.id,
    recordedAt: "2026-09-01T12:00:00.000Z",
    importId: "synthetic-import",
    externalId: `schedule-${id}`,
    occurrences: [
      {
        index: 0,
        parcela: "1/2",
        valor: first,
        data: "2026-09-05",
        invoiceDueMonth: null,
        amountEvidence: null,
        cycleEvidence: null,
      },
      {
        index: 1,
        parcela: "2/2",
        valor: second,
        data: "2026-09-20",
        invoiceDueMonth: null,
        amountEvidence: null,
        cycleEvidence: null,
      },
    ],
    projections: [],
    lastOperation: null,
  });

describe("#704 expenseIsCredit read contract", () => {
  const db = new PrismaClient();
  const prisma = new PrismaService();
  const monthly = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );

  beforeEach(async () => {
    jest.useFakeTimers({
      doNotFake: [
        "nextTick",
        "setImmediate",
        "setTimeout",
        "clearTimeout",
        "hrtime",
        "performance",
      ],
    });
    jest.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    await db.user.deleteMany({ where: { tenantId: TENANT } });
    await resetTenant(db, TENANT);
    await seedPessoal(db, { tenantId: TENANT, projectId: PROJECT });
    await db.user.create({
      data: {
        ...REQUESTER,
        tenantId: TENANT,
        username: "owner",
        name: "Synthetic owner",
      },
    });
  });
  afterEach(async () => {
    jest.useRealTimers();
    await db.user.deleteMany({ where: { tenantId: TENANT } });
    await resetTenant(db, TENANT);
  });
  afterAll(async () => {
    await db.$disconnect();
    await prisma.$disconnect();
  });

  let account: { last4: string };
  /** Bank installment expense; the CFEs mirror the occurrence values exactly. */
  const seedExpense = async (
    id: string,
    valorTotal: number,
    first: number,
    second: number,
    tipoDespesa = "OUTROS",
  ) => {
    await db.expense.create({
      data: {
        id,
        tenantId: TENANT,
        projectId: PROJECT,
        tipoDespesa,
        titulo: `synthetic ${id}`,
        valor: valorTotal,
        valorTotal,
        quantidade: 1,
        quantidadeParcela: 2,
        formaPagamento: "PARCELADO",
        status: "PLANEJADO",
        bankLast4: account.last4,
        dataInicioParcela: new Date("2026-09-05T00:00:00Z"),
        documentedSchedule: schedule(id, first, second),
      },
    });
    for (const [index, [valor, date]] of [
      [first, "2026-09-05"],
      [second, "2026-09-20"],
    ].entries())
      await db.cashFlowEntry.create({
        data: {
          id: `${id}-cfe-${index}`,
          tenantId: TENANT,
          projectId: PROJECT,
          expenseId: id,
          valor: valor as number,
          tipo: "DESPESA",
          data: new Date(`${date}T00:00:00Z`),
          categoria: tipoDespesa,
          formaPagamento: "PARCELADO",
          status: "PLANEJADO",
          parcela: `${index + 1}/2`,
        },
      });
  };
  const seedDefault = async () => {
    account = await seedBankAccount(db, {
      tenantId: TENANT,
      projectId: PROJECT,
      last4: "9001",
    });
    // root +1000, occurrences +1200 / -200  => NOT a credit
    await seedExpense("root-positive", 1000, 1200, -200);
    // root -1000, occurrences -1200 / +200  => credit, even for the +200 occurrence
    await seedExpense("root-negative", -1000, -1200, 200);
  };

  const byExpense = <T extends { expenseId?: string | null; id?: string | null }>(
    rows: T[],
    id: string,
  ) => rows.filter((row) => (row.expenseId ?? row.id)?.split("#")[0] === id);

  it("MonthlyEntry: the flag follows Expense.valorTotal for every occurrence, not the CFE value", async () => {
    await seedDefault();
    // A receipt entry and an expense-less entry have no Expense: no invented boolean.
    const receipt = await db.receipt.create({
      data: {
        tenantId: TENANT,
        projectId: PROJECT,
        tipo: "RECEITA_OUTROS",
        valor: 500,
        data: new Date("2026-09-10T00:00:00Z"),
        status: "RECEBIDO",
        descricao: "synthetic receipt",
      } as never,
    });
    await db.cashFlowEntry.create({
      data: {
        id: "receipt-cfe",
        tenantId: TENANT,
        projectId: PROJECT,
        receiptId: receipt.id,
        valor: 500,
        tipo: "RECEBIMENTO",
        data: new Date("2026-09-10T00:00:00Z"),
        categoria: "OUTROS",
        status: "RECEBIDO",
      },
    });
    await db.cashFlowEntry.create({
      data: {
        id: "orphan-cfe",
        tenantId: TENANT,
        projectId: PROJECT,
        valor: -300,
        tipo: "DESPESA",
        data: new Date("2026-09-11T00:00:00Z"),
        categoria: "OUTROS",
        status: "PLANEJADO",
      },
    });
    const before = JSON.stringify({
      e: await db.expense.findMany({ orderBy: { id: "asc" } }),
      c: await db.cashFlowEntry.findMany({ orderBy: { id: "asc" } }),
    });
    const overview = await monthly.getOverview(
      TENANT,
      PROJECT,
      MONTH,
      REQUESTER,
    );
    const rows = overview.entries as Array<Record<string, unknown>>;
    const of = (expenseId: string) =>
      rows.filter((row) => row.expenseId === expenseId);
    expect(of("root-positive").map((row) => row.valor)).toEqual([1200, -200]);
    expect(of("root-positive").map((row) => row.expenseIsCredit)).toEqual([
      false,
      false,
    ]);
    expect(of("root-negative").map((row) => row.valor)).toEqual([-1200, 200]);
    expect(of("root-negative").map((row) => row.expenseIsCredit)).toEqual([
      true,
      true,
    ]);
    for (const id of ["receipt-cfe", "orphan-cfe"]) {
      const row = rows.find((entry) => entry.id === id)!;
      expect(row).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(row, "expenseIsCredit")).toBe(
        false,
      );
    }
    // read-only: nothing economic moved
    expect(
      JSON.stringify({
        e: await db.expense.findMany({ orderBy: { id: "asc" } }),
        c: await db.cashFlowEntry.findMany({ orderBy: { id: "asc" } }),
      }),
    ).toBe(before);
  });

  it("AccountViewSaida: root-negative keeps its positive occurrence and value/category/date are untouched", async () => {
    await seedDefault();
    const view = await monthly.getAccountView(
      TENANT,
      PROJECT,
      MONTH,
      REQUESTER,
    );
    const saidas = view.saidas as Array<Record<string, any>>;
    // the account view lists newest first; compare chronologically
    const chronological = (rows: Array<Record<string, any>>) =>
      [...rows].sort((a, b) => a.data.localeCompare(b.data));
    const positive = chronological(byExpense(saidas, "root-positive"));
    const negative = chronological(byExpense(saidas, "root-negative"));
    expect(
      positive.map((row) => [row.valor, row.data.slice(0, 10), row.tipoDespesa]),
    ).toEqual([
      [1200, "2026-09-05", "OUTROS"],
      [-200, "2026-09-20", "OUTROS"],
    ]);
    expect(positive.map((row) => row.expenseIsCredit)).toEqual([false, false]);
    expect(
      negative.map((row) => [row.valor, row.data.slice(0, 10), row.tipoDespesa]),
    ).toEqual([
      [-1200, "2026-09-05", "OUTROS"],
      [200, "2026-09-20", "OUTROS"],
    ]);
    // the +200 occurrence of a NEGATIVE root is still a credit row
    expect(negative.map((row) => row.expenseIsCredit)).toEqual([true, true]);
    // rows that are not an Expense never carry an invented boolean
    for (const row of saidas.filter((item) => item.isInvoice))
      expect("expenseIsCredit" in row).toBe(false);
  });

  it("adds no per-row database query: the query count does not grow with the number of rows", async () => {
    await seedDefault();
    const counts: string[] = [];
    let recording = false;
    prisma.$use(async (params, next) => {
      if (recording) counts.push(`${params.model}.${params.action}`);
      return next(params);
    });
    const measure = async () => {
      counts.length = 0;
      recording = true;
      await monthly.getOverview(TENANT, PROJECT, MONTH, REQUESTER);
      await monthly.getAccountView(TENANT, PROJECT, MONTH, REQUESTER);
      recording = false;
      return counts.length;
    };
    const small = await measure();
    for (const id of ["a", "b", "c", "d"]) {
      if (id === "a") await seedExpense(`extra-${id}`, -700, -800, 100);
      else await seedExpense(`extra-${id}`, 700, 800, -100);
    }
    expect(await measure()).toBe(small);
  });

  describe("financial queue propagates the account-view flag without inferring it", () => {
    const stubbed = (saidas: Array<Record<string, unknown>>) => {
      const monthlyStub = {
        getAccountView: jest.fn().mockResolvedValue({
          mesSelecionado: MONTH,
          saidas,
          entradas: [],
          cartoes: [],
        }),
      };
      return new PendenciaService(
        prisma,
        monthlyStub as never,
        {
          resolveLearnedExpenseType: jest.fn().mockResolvedValue({
            expenseType: "ALIMENTACAO",
            source: "AI_TENANT",
            confidence: 0.9,
            category: "alimentacao",
            reason: "resolvido",
          }),
        } as never,
        { loadCardsWithEntries: jest.fn().mockResolvedValue([]) } as never,
      );
    };
    const base = {
      kind: "saida",
      isInvoice: false,
      realizado: false,
      cardLast4: null,
      bankLast4: null,
      data: "2026-09-20T00:00:00.000Z",
      descricao: "synthetic",
      tipoDespesa: "OUTROS",
    };

    it("copies true/false for SEM_CONTA, SEM_CATEGORIA and foreign-installment rows and never derives it from value or remainingCents", async () => {
      const queue = await stubbed([
        // negative value, flag false: must NOT become a credit
        { ...base, id: "e-false", valor: -50, expenseIsCredit: false },
        // positive value + positive remainingCents, flag true: must stay a credit
        {
          ...base,
          id: "e-true",
          valor: 50,
          expenseIsCredit: true,
          installmentSettlement: {
            contractedCents: 50,
            paidCents: 0,
            remainingCents: 50,
            settlementStatus: "UNPAID",
          },
          canExecuteAction: true,
          foreignExpenseId: "e-true",
          parcelaIndex: 0,
        },
        // no flag (no Expense): the key stays absent
        { ...base, id: "e-none", valor: -75 },
      ]).findFinancialQueue(TENANT, PROJECT, MONTH, REQUESTER);
      const items = queue.grupos.flatMap((group) => group.itens);
      const pick = (prefix: string, expenseId: string) =>
        items.find(
          (item) => item.id.startsWith(prefix) && item.expenseId === expenseId,
        )!;
      expect(pick("sem-conta-", "e-false").expenseIsCredit).toBe(false);
      expect(pick("sem-conta-", "e-true").expenseIsCredit).toBe(true);
      expect(pick("foreign-", "e-true").expenseIsCredit).toBe(true);
      expect(pick("sem-categoria-", "e-false").expenseIsCredit).toBe(false);
      expect(pick("sem-categoria-", "e-true").expenseIsCredit).toBe(true);
      for (const prefix of ["sem-conta-", "sem-categoria-"])
        expect(
          "expenseIsCredit" in pick(prefix, "e-none"),
        ).toBe(false);
    });
  });
});
