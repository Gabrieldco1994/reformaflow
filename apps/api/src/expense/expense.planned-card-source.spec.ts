require("../../../../scripts/test-db-env.cjs");

import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  ExpenseType,
  type ImportSessionPlannedCreateV1,
} from "@reformaflow/domain";
import {
  seedBankAccount,
  seedCardWithClosingDue,
  seedPessoal,
  seedProject,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { INCLUDE_SOFT_DELETED, PrismaService } from "../prisma/prisma.service";
import { createRateioTargets } from "./create-rateio-targets";
import { parseStoredExpenseSchedule } from "./documented-schedule";
import type { ScheduleEvidenceInput } from "./documented-schedule.types";
import { CreateExpenseDto } from "./dto/create-expense.dto";
import { ExpenseService } from "./expense.service";
import type { RateioRequester } from "./rateio.types";

// M1 native seam only, not the batch adapter/coordinator or an HTTP proof.
// GREEN mutation plan: move documentedSchedule after CFE generation. The first
// INSERT and CFE journal assertions must fail; never implement that mutant here.
type PlannedInput = Pick<
  ImportSessionPlannedCreateV1,
  | "titulo"
  | "fornecedor"
  | "tipoDespesa"
  | "categoriaMaoDeObra"
  | "dataCompra"
  | "totalCents"
  | "schedule"
> & {
  cardId: string;
  evidence: ScheduleEvidenceInput;
  reason: string;
};
type PlannedEntry = (
  tx: Prisma.TransactionClient,
  tenantId: string,
  ownerProjectId: string,
  input: PlannedInput,
  createdByUserId: string,
  requester: RateioRequester,
) => ReturnType<ExpenseService["create"]>;

const NOW = "2026-10-06T12:00:00.000Z";
const ARTIFACT = Buffer.from(
  "Synthetic QA purchase: 69840 cents; ten occurrences.",
);
const EVIDENCE: ScheduleEvidenceInput = {
  documentSha256: createHash("sha256").update(ARTIFACT).digest("hex"),
  reference: "Synthetic QA artifact, purchase 1, confirmed schedule",
};
const REASON = "Synthetic documented purchase without a legacy import";
const OCCURRENCES = [
  {
    index: 0,
    parcela: "1/10",
    valor: 6984,
    data: "2026-11-10",
    invoiceDueMonth: "2026-11",
  },
  {
    index: 1,
    parcela: "2/10",
    valor: 6984,
    data: "2026-12-10",
    invoiceDueMonth: "2026-12",
  },
  {
    index: 2,
    parcela: "3/10",
    valor: 6984,
    data: "2027-01-10",
    invoiceDueMonth: "2027-01",
  },
  {
    index: 3,
    parcela: "4/10",
    valor: 6984,
    data: "2027-02-10",
    invoiceDueMonth: "2027-02",
  },
  {
    index: 4,
    parcela: "5/10",
    valor: 6984,
    data: "2027-03-10",
    invoiceDueMonth: "2027-03",
  },
  {
    index: 5,
    parcela: "6/10",
    valor: 6984,
    data: "2027-04-10",
    invoiceDueMonth: "2027-04",
  },
  {
    index: 6,
    parcela: "7/10",
    valor: 6984,
    data: "2027-05-10",
    invoiceDueMonth: "2027-05",
  },
  {
    index: 7,
    parcela: "8/10",
    valor: 6984,
    data: "2027-06-10",
    invoiceDueMonth: "2027-06",
  },
  {
    index: 8,
    parcela: "9/10",
    valor: 6984,
    data: "2027-07-10",
    invoiceDueMonth: "2027-07",
  },
  {
    index: 9,
    parcela: "10/10",
    valor: 6984,
    data: "2027-08-10",
    invoiceDueMonth: "2027-08",
  },
];
const SIDE_TABLES = [
  "credit_card_imports",
  "bank_statement_imports",
  "receipts",
  "cross_project_settlements",
  "imported_invoice_liquidations",
  "invoice_adjustments",
  "invoice_reconciliation_sources",
  "invoice_replay_operations",
  "invoice_funding_allocations",
  "budget_allocations",
  "bank_accounts",
  "credit_cards",
] as const;

type WriteEvent = {
  model: string;
  action: string;
  args: unknown;
  inTransaction: boolean;
  outcome: "pending" | "fulfilled" | "rejected";
  result?: unknown;
};
type JournalRow = {
  seq: number | bigint;
  tbl: string;
  op: string;
  row_id: string;
  expense_id: string;
  schedule: string | null;
};

describe("M1 native planned card source (RED contract, real SQLite)", () => {
  const prisma = new PrismaService();
  const conciliacao = new ConciliacaoService(prisma);
  const expenses = new ExpenseService(prisma, conciliacao);
  const writes: WriteEvent[] = [];
  let sequence = 0;
  let tenantId: string;
  let projectId: string;
  let targetProjectId: string;
  let cardId: string;
  let requester: RateioRequester & { id: string };

  prisma.$use(async (params, next) => {
    if (
      !["Expense", "CashFlowEntry"].includes(params.model ?? "") ||
      ![
        "create",
        "createMany",
        "update",
        "updateMany",
        "delete",
        "deleteMany",
        "upsert",
      ].includes(params.action)
    )
      return next(params);
    const event: WriteEvent = {
      model: params.model ?? "",
      action: params.action,
      args: structuredClone(params.args),
      inTransaction: params.runInTransaction,
      outcome: "pending",
    };
    writes.push(event);
    try {
      const result: unknown = await next(params);
      event.outcome = "fulfilled";
      event.result = structuredClone(result);
      return result;
    } catch (error) {
      event.outcome = "rejected";
      throw error;
    }
  });

  function assertEntry(candidate: unknown): asserts candidate is PlannedEntry {
    expect({
      entry: "ExpenseService.createPlannedCardPurchaseInTx",
      type: typeof candidate,
    }).toEqual({
      entry: "ExpenseService.createPlannedCardPurchaseInTx",
      type: "function",
    });
  }

  function plannedEntry(): PlannedEntry {
    const candidate: unknown = Reflect.get(
      expenses,
      "createPlannedCardPurchaseInTx",
    );
    assertEntry(candidate);
    return candidate.bind(expenses);
  }

  function input(): PlannedInput {
    return {
      titulo: "Synthetic planned purchase",
      fornecedor: "Synthetic supplier",
      tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
      categoriaMaoDeObra: null,
      dataCompra: "2026-10-05",
      totalCents: 69840,
      schedule: { version: 1, occurrences: structuredClone(OCCURRENCES) },
      cardId,
      evidence: { ...EVIDENCE },
      reason: REASON,
    };
  }

  function nativeDto(): CreateExpenseDto {
    return {
      titulo: "Synthetic native control",
      tipoDespesa: "MATERIAL_CONSTRUCAO",
      valor: 698.4,
      quantidade: 1,
      formaPagamento: "PARCELADO",
      quantidadeParcela: 10,
      dataCompra: "2026-10-05",
      dataInicioParcela: "2026-11-10",
      creditCardId: cardId,
      status: "PLANEJADO",
    };
  }

  async function inTx<T>(
    run: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      const fk = await tx.$queryRaw<
        Array<{ foreign_keys: bigint | number }>
      >`PRAGMA foreign_keys`;
      expect(fk.map((row) => Number(row.foreign_keys))).toEqual([1]);
      return run(tx);
    });
  }

  async function journal(): Promise<JournalRow[]> {
    return prisma.$queryRaw`SELECT * FROM qa_planned_source_writes ORDER BY seq`;
  }

  async function physical() {
    const sideRows: Record<string, unknown[]> = {};
    for (const table of SIDE_TABLES) {
      sideRows[table] = await prisma.$queryRawUnsafe(
        `SELECT * FROM "${table}" WHERE tenant_id = ? ORDER BY id`,
        tenantId,
      );
    }
    return {
      expenses: await prisma.expense.findMany({
        where: { tenantId, deletedAt: INCLUDE_SOFT_DELETED },
        orderBy: { id: "asc" },
      }),
      cash: await prisma.cashFlowEntry.findMany({
        where: { tenantId, deletedAt: INCLUDE_SOFT_DELETED },
        orderBy: { id: "asc" },
      }),
      allocations: await prisma.rateioAllocation.findMany({
        where: { tenantId },
        orderBy: { id: "asc" },
      }),
      sideRows,
    };
  }

  async function clearObservation() {
    await prisma.$executeRaw`DELETE FROM qa_planned_source_writes`;
    writes.length = 0;
  }

  function assertV2(raw: string | null, id: string) {
    const schedule = parseStoredExpenseSchedule(raw);
    expect(schedule).toMatchObject({
      version: 2,
      kind: "source",
      tenantId,
      sourceExpenseId: id,
      sourceProjectId: projectId,
      cardId,
      recordedByUserId: requester.id,
      recordedAt: NOW,
      provenance: {
        kind: "assisted-card",
        basis: "no-import-reference",
        originalImportId: null,
        originalExternalId: null,
        referenceCheck: "NO_REFERENCE",
        reason: REASON,
        evidence: { ...EVIDENCE, actorUserId: requester.id, recordedAt: NOW },
      },
    });
    expect(
      schedule?.occurrences.map(
        ({ index, parcela, valor, data, invoiceDueMonth }) => ({
          index,
          parcela,
          valor,
          data,
          invoiceDueMonth,
        }),
      ),
    ).toEqual(OCCURRENCES);
    return schedule;
  }

  async function assertCash(expenseId: string, ownerProjectId: string) {
    const cash = await prisma.cashFlowEntry.findMany({
      where: { tenantId, expenseId, deletedAt: INCLUDE_SOFT_DELETED },
      orderBy: { data: "asc" },
    });
    expect(
      cash.map((row) => ({
        projectId: row.projectId,
        tenantId: row.tenantId,
        expenseId: row.expenseId,
        valor: row.valor,
        data: row.data.toISOString(),
        parcela: row.parcela,
        invoiceDueMonth: row.invoiceDueMonth,
        status: row.status,
        tipo: row.tipo,
        formaPagamento: row.formaPagamento,
        deletedAt: row.deletedAt,
        receiptId: row.receiptId,
        budgetAllocationId: row.budgetAllocationId,
      })),
    ).toEqual(
      OCCURRENCES.map((row) => ({
        projectId: ownerProjectId,
        tenantId,
        expenseId,
        valor: row.valor,
        data: `${row.data}T00:00:00.000Z`,
        parcela: row.parcela,
        invoiceDueMonth: row.invoiceDueMonth,
        status: "PLANEJADO",
        tipo: "DESPESA",
        formaPagamento: "PARCELADO",
        deletedAt: null,
        receiptId: null,
        budgetAllocationId: null,
      })),
    );
    const events = (await journal()).filter(
      (row) => row.tbl === "cash_flow_entries" && row.expense_id === expenseId,
    );
    expect(events).toHaveLength(10);
    expect(events.map((row) => row.op)).toEqual(Array(10).fill("INSERT"));
    expect(events.map((row) => row.row_id).sort()).toEqual(
      cash.map((row) => row.id).sort(),
    );
    expect(new Set(events.map((row) => row.row_id)).size).toBe(10);
    return cash;
  }

  async function createTarget(
    tx: Prisma.TransactionClient,
    source: { id: string; status: string },
  ) {
    return createRateioTargets(
      tx,
      conciliacao,
      tenantId,
      source,
      {
        existing: [],
        newTargets: [
          {
            targetProjectId,
            tipoDespesa: "MATERIAL_CONSTRUCAO",
            titulo: "Synthetic full destination",
            valor: 698.4,
            quantidade: 1,
            allocation: 69840,
            status: "PLANEJADO",
          },
        ],
      },
      requester.id,
      requester,
    );
  }

  async function failLastCfe(project: "source" | "target") {
    const failedProject = project === "source" ? projectId : targetProjectId;
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER qa_planned_source_fail_last BEFORE INSERT ON cash_flow_entries
      WHEN NEW.tenant_id = '${tenantId}' AND NEW.project_id = '${failedProject}'
        AND NEW.parcela = '10/10'
        AND (SELECT COUNT(*) FROM cash_flow_entries WHERE expense_id = NEW.expense_id) = 9
      BEGIN SELECT RAISE(ABORT, 'qa-native-last-cfe'); END
    `);
  }

  async function seedHistory() {
    for (const deleted of [false, true]) {
      await inTx(async (tx) => {
        const old = await expenses.create(
          tenantId,
          projectId,
          {
            tipoDespesa: "OUTROS",
            titulo: deleted ? "Deleted control" : "Live control",
            valor: 1.23,
            quantidade: 1,
            formaPagamento: "A_VISTA",
            dataPagamento: "2026-09-01",
            status: "PLANEJADO",
          },
          requester.id,
          tx,
          requester,
        );
        if (deleted) {
          await tx.cashFlowEntry.deleteMany({ where: { expenseId: old.id } });
          await tx.expense.delete({ where: { id: old.id } });
        }
      });
    }
    const before = await physical();
    expect(before.expenses).toHaveLength(2);
    expect(before.cash).toHaveLength(2);
    expect(
      before.expenses.filter((row) => row.deletedAt !== null),
    ).toHaveLength(1);
    expect(before.cash.filter((row) => row.deletedAt !== null)).toHaveLength(1);
    expect(
      await prisma.expense.count({ where: { tenantId, deletedAt: null } }),
    ).toBe(1);
    expect(await prisma.expense.findMany({ where: { tenantId } })).toHaveLength(
      1,
    );
    await clearObservation();
    return before;
  }

  beforeAll(async () => {
    expect(process.env.TZ).toBe("UTC");
    await prisma.$connect();
    await prisma.$executeRaw`PRAGMA foreign_keys = ON`;
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    await prisma.$executeRaw`
      CREATE TABLE qa_planned_source_writes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, op TEXT NOT NULL,
        row_id TEXT NOT NULL, expense_id TEXT NOT NULL, schedule TEXT
      )
    `;
    for (const table of ["expenses", "cash_flow_entries"]) {
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        const row = action === "DELETE" ? "OLD" : "NEW";
        const expenseId =
          table === "expenses" ? `${row}.id` : `${row}.expense_id`;
        const schedule =
          table === "expenses"
            ? `${row}.documented_schedule`
            : `(SELECT documented_schedule FROM expenses WHERE id = ${row}.expense_id)`;
        await prisma.$executeRawUnsafe(`
          CREATE TRIGGER qa_planned_source_${table}_${action} AFTER ${action} ON ${table}
          WHEN ${row}.tenant_id LIKE 'qa-native-source-%'
          BEGIN INSERT INTO qa_planned_source_writes (tbl, op, row_id, expense_id, schedule)
            VALUES ('${table}', '${action}', ${row}.id, ${expenseId}, ${schedule}); END
        `);
      }
    }
  });

  beforeEach(async () => {
    jest.useFakeTimers({
      now: new Date(NOW),
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    tenantId = `qa-native-source-${++sequence}`;
    projectId = `${tenantId}-pessoal`;
    targetProjectId = `${tenantId}-reforma`;
    requester = {
      id: `${tenantId}-actor`,
      role: "USER",
      allowedProjects: [projectId, targetProjectId],
      allowedProjectTypes: ["PESSOAL", "REFORMA"],
      allowedModules: [
        "expenses",
        "creditCards",
        "bankAccounts",
        "monthlyOverview",
      ],
    };
    const fk = await prisma.$queryRaw<
      Array<{ foreign_keys: bigint | number }>
    >`PRAGMA foreign_keys`;
    expect(fk.map((row) => Number(row.foreign_keys))).toEqual([1]);
    await seedPessoal(prisma, { tenantId, projectId });
    await seedProject(prisma, {
      tenantId,
      projectId: targetProjectId,
      type: "REFORMA",
      name: "QA destination",
    });
    await prisma.user.create({
      data: {
        id: requester.id,
        tenantId,
        username: requester.id,
        name: "QA operator",
        role: "USER",
        allowedProjects: JSON.stringify(requester.allowedProjects),
        allowedModules: JSON.stringify(requester.allowedModules),
        allowedProjectTypes: JSON.stringify(requester.allowedProjectTypes),
      },
    });
    cardId = (
      await seedCardWithClosingDue(prisma, {
        tenantId,
        projectId,
        last4: "0714",
        closingDay: 20,
        dueDay: 10,
      })
    ).id;
    await seedBankAccount(prisma, { tenantId, projectId, last4: "0715" });
    await clearObservation();
  });

  afterEach(async () => {
    await prisma.$executeRaw`DROP TRIGGER IF EXISTS qa_planned_source_fail_last`;
    jest.useRealTimers();
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("RED 1/2: first real INSERT has bound V2; ten definitive CFEs, no replacement or tombstone", async () => {
    const create = plannedEntry();
    const source = await inTx((tx) =>
      create(tx, tenantId, projectId, input(), requester.id, requester),
    );
    expect(source.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(source).toMatchObject({
      tenantId,
      projectId,
      createdByUserId: requester.id,
      room: null,
      titulo: "Synthetic planned purchase",
      fornecedor: "Synthetic supplier",
      tipoDespesa: "MATERIAL_CONSTRUCAO",
      categoriaMaoDeObra: null,
      valor: 69840,
      valorTotal: 69840,
      quantidade: 1,
      quantidadeParcela: 10,
      formaPagamento: "PARCELADO",
      status: "PLANEJADO",
      dataCompra: new Date("2026-10-05T00:00:00.000Z"),
      dataInicioParcela: new Date("2026-11-10T00:00:00.000Z"),
    });
    const rows = await journal();
    const inserts = rows.filter(
      (row) => row.tbl === "expenses" && row.op === "INSERT",
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row_id).toBe(source.id);
    const firstSchedule = assertV2(inserts[0].schedule, source.id);
    expect(firstSchedule).toMatchObject({
      projections: [],
      lastOperation: null,
    });
    expect(source.documentedSchedule).toBe(inserts[0].schedule);
    expect(writes[0]).toMatchObject({
      model: "Expense",
      action: "create",
      inTransaction: true,
      outcome: "fulfilled",
      args: {
        data: { id: source.id, documentedSchedule: inserts[0].schedule },
      },
    });
    for (const row of rows.filter(
      (event) => event.tbl === "cash_flow_entries",
    )) {
      expect(row.schedule).toBe(inserts[0].schedule);
      expect(Number(row.seq)).toBeGreaterThan(Number(inserts[0].seq));
    }
    const cash = await assertCash(source.id, projectId);
    expect(cash.reduce((sum, row) => sum + row.valor, 0)).toBe(69840);
    const generations = writes.filter(
      (row) =>
        row.model === "CashFlowEntry" &&
        ["create", "createMany"].includes(row.action),
    );
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({
      action: "createMany",
      inTransaction: true,
      outcome: "fulfilled",
      result: { count: 10 },
    });
    expect((await physical()).allocations).toEqual([]);
  });

  it("RED 3: native full target projection precedes ten target CFEs; source IDs survive", async () => {
    const create = plannedEntry();
    const ratear = jest.spyOn(conciliacao, "ratearSource");
    const regenerateTarget = jest.spyOn(
      conciliacao,
      "regenerateRateioTargetCashflow",
    );
    try {
      const result = await inTx(async (tx) => {
        const source = await create(
          tx,
          tenantId,
          projectId,
          input(),
          requester.id,
          requester,
        );
        const originalIds = await tx.cashFlowEntry.findMany({
          where: { expenseId: source.id },
          select: { id: true },
          orderBy: { id: "asc" },
        });
        const targets = await createTarget(tx, source);
        return { source, originalIds, targets };
      });
      expect(result.targets.createdTargetIds).toHaveLength(1);
      const targetId = result.targets.createdTargetIds[0];
      expect(result.targets.targets).toEqual([targetId]);
      expect(ratear).toHaveBeenCalledTimes(1);
      expect(regenerateTarget).toHaveBeenCalledTimes(1);
      expect(regenerateTarget.mock.calls[0][1]).toBe(targetId);
      expect(regenerateTarget.mock.calls[0][0]).toBe(ratear.mock.calls[0][0]);
      const sourceCash = await assertCash(result.source.id, projectId);
      await assertCash(targetId, targetProjectId);
      expect(
        sourceCash
          .map(({ id }) => ({ id }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ).toEqual(result.originalIds);
      const after = await physical();
      expect(after.expenses).toHaveLength(2);
      expect(after.cash).toHaveLength(20);
      expect(after.cash.filter((row) => row.deletedAt === null)).toHaveLength(
        20,
      );
      expect(after.allocations).toHaveLength(1);
      expect(after.allocations[0]).toMatchObject({
        tenantId,
        sourceExpenseId: result.source.id,
        targetExpenseId: targetId,
        allocation: 69840,
        plannedValorTotal: 69840,
        isRefundCredit: false,
      });
      const rows = await journal();
      const targetInsert = rows.find(
        (row) =>
          row.tbl === "expenses" &&
          row.op === "INSERT" &&
          row.row_id === targetId,
      );
      expect(targetInsert?.schedule).toBeNull();
      const projectionWrite = rows.find(
        (row) =>
          row.tbl === "expenses" &&
          row.op === "UPDATE" &&
          row.row_id === targetId &&
          row.schedule !== null,
      );
      expect(projectionWrite).toBeDefined();
      const projection = parseStoredExpenseSchedule(projectionWrite?.schedule);
      expect(projection).toMatchObject({
        version: 1,
        kind: "projection",
        via: "rateio",
        tenantId,
        cardId,
        sourceExpenseId: result.source.id,
        sourceProjectId: projectId,
        targetExpenseId: targetId,
        targetProjectId,
        allocationId: after.allocations[0].id,
        occurrences: OCCURRENCES.map((row) => ({
          ...row,
          sourceIndex: row.index,
        })),
      });
      for (const row of rows.filter(
        (event) =>
          event.tbl === "cash_flow_entries" && event.expense_id === targetId,
      )) {
        expect(row.schedule).toBe(projectionWrite?.schedule);
        expect(Number(row.seq)).toBeGreaterThan(Number(projectionWrite?.seq));
      }
      const source = after.expenses.find((row) => row.id === result.source.id)!;
      expect(source.linkedExpenseId).toBe(targetId);
      expect(assertV2(source.documentedSchedule, source.id)).toMatchObject({
        projections: [
          {
            kind: "rateio",
            allocationId: after.allocations[0].id,
            targetExpenseId: targetId,
            occurrenceMap: OCCURRENCES.map(({ index }) => ({
              sourceIndex: index,
              targetIndex: index,
            })),
          },
        ],
      });
    } finally {
      ratear.mockRestore();
      regenerateTarget.mockRestore();
    }
  });

  it.each(["empty", "invalid-date", "invalid-cycle", "sum-mismatch"] as const)(
    "RED 4: invalid schedule (%s) rejects before any Expense/CFE INSERT",
    async (kind) => {
      const create = plannedEntry();
      const invalid = input();
      if (kind === "empty") invalid.schedule.occurrences = [];
      if (kind === "invalid-date")
        invalid.schedule.occurrences[0].data = "2026-02-30";
      if (kind === "invalid-cycle")
        invalid.schedule.occurrences[0].invoiceDueMonth = "2026-13";
      if (kind === "sum-mismatch") invalid.schedule.occurrences[9].valor = 6983;
      const before = await physical();
      await expect(
        inTx((tx) =>
          create(tx, tenantId, projectId, invalid, requester.id, requester),
        ),
      ).rejects.toThrow();
      expect(await physical()).toEqual(before);
      expect(before.expenses).toEqual([]);
      expect(before.cash).toEqual([]);
      expect(writes).toEqual([]);
      expect(await journal()).toEqual([]);
    },
  );

  it.each(["source", "target"] as const)(
    "RED 4: SQL failure at last %s CFE rolls back every new row, preserving live/deleted history",
    async (failedProject) => {
      const create = plannedEntry();
      const before = await seedHistory();
      await failLastCfe(failedProject);
      await expect(
        inTx(async (tx) => {
          const source = await create(
            tx,
            tenantId,
            projectId,
            input(),
            requester.id,
            requester,
          );
          if (failedProject === "target") await createTarget(tx, source);
        }),
      ).rejects.toMatchObject({ code: "P2003" });
      const batches = writes.filter(
        (row) => row.model === "CashFlowEntry" && row.action === "createMany",
      );
      expect(batches.map((row) => row.outcome)).toEqual(
        failedProject === "source" ? ["rejected"] : ["fulfilled", "rejected"],
      );
      const last = batches[batches.length - 1];
      expect(last).toMatchObject({
        inTransaction: true,
        args: {
          data: expect.arrayContaining([
            expect.objectContaining({
              parcela: "10/10",
              valor: 6984,
              invoiceDueMonth: "2027-08",
              projectId:
                failedProject === "source" ? projectId : targetProjectId,
            }),
          ]),
        },
      });
      expect(await physical()).toEqual(before);
      expect(await journal()).toEqual([]);
    },
  );

  it("RED 5: no fabricated imports, receipts, payment/settlement ledger or bank debit", async () => {
    const create = plannedEntry();
    const before = await physical();
    const source = await inTx((tx) =>
      create(tx, tenantId, projectId, input(), requester.id, requester),
    );
    const after = await physical();
    expect(after.sideRows).toEqual(before.sideRows);
    expect(after.expenses).toHaveLength(1);
    expect(after.allocations).toEqual([]);
    expect(source).toMatchObject({
      importId: null,
      externalId: null,
      accountId: null,
      bankLast4: null,
      cardLast4: "0714",
      origin: "import",
      status: "PLANEJADO",
      dataPagamento: null,
      paidParcelas: null,
      settledByExpenseId: null,
      settlesInvoiceKey: null,
      linkedExpenseId: null,
    });
    assertV2(source.documentedSchedule, source.id);
    await assertCash(source.id, projectId);
    expect(after.cash.filter((row) => row.status !== "PLANEJADO")).toEqual([]);
  });

  it("NATIVE 6: public six-argument create preserves conventional installments and ignores private DTO extras", async () => {
    const dto = Object.assign(nativeDto(), {
      documentedSchedule: "private agenda must not enter public create",
    });
    const before = await physical();
    const source = await inTx((tx) =>
      expenses.create(tenantId, projectId, dto, requester.id, tx, requester),
    );
    expect(source).toMatchObject({
      valor: 69840,
      valorTotal: 69840,
      quantidade: 1,
      quantidadeParcela: 10,
      room: null,
      documentedSchedule: null,
      cardLast4: "0714",
      origin: "import",
      createdByUserId: requester.id,
      status: "PLANEJADO",
      dataCompra: new Date("2026-10-05T00:00:00.000Z"),
    });
    const after = await physical();
    expect(after.sideRows).toEqual(before.sideRows);
    expect(
      after.cash
        .sort((a, b) => a.data.getTime() - b.data.getTime())
        .map((row) => ({
          valor: row.valor,
          data: row.data.toISOString(),
          parcela: row.parcela,
          invoiceDueMonth: row.invoiceDueMonth,
          status: row.status,
          deletedAt: row.deletedAt,
        })),
    ).toEqual(
      OCCURRENCES.map((row) => ({
        valor: row.valor,
        data: `${row.data}T00:00:00.000Z`,
        parcela: row.parcela,
        invoiceDueMonth: null,
        status: "PLANEJADO",
        deletedAt: null,
      })),
    );
    const rows = await journal();
    expect(
      rows.filter((row) => row.tbl === "expenses" && row.op === "INSERT"),
    ).toHaveLength(1);
    expect(rows.filter((row) => row.tbl === "cash_flow_entries")).toHaveLength(
      10,
    );
    expect(
      rows.every((row) => row.op === "INSERT" && row.schedule === null),
    ).toBe(true);
    expect(writes.every((row) => row.inTransaction)).toBe(true);
  });

  it("NATIVE 6: actual DTO metadata rejects private schedule fields (no HTTP claim)", async () => {
    const before = await physical();
    expect(
      await validate(plainToInstance(CreateExpenseDto, nativeDto()), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).toEqual([]);
    const errors = await validate(
      plainToInstance(CreateExpenseDto, {
        ...nativeDto(),
        documentedSchedule: "{}",
        schedule: input().schedule,
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(
      errors
        .map((error) => ({
          property: error.property,
          constraints: Object.keys(error.constraints ?? {}),
        }))
        .sort((a, b) => a.property.localeCompare(b.property)),
    ).toEqual([
      { property: "documentedSchedule", constraints: ["whitelistValidation"] },
      { property: "schedule", constraints: ["whitelistValidation"] },
    ]);
    expect(await physical()).toEqual(before);
    expect(writes).toEqual([]);
  });

  it("INSTRUMENT: native create reaches last-CFE SQL trigger; tx rollback includes physical history", async () => {
    const before = await seedHistory();
    await failLastCfe("source");
    await expect(
      inTx((tx) =>
        expenses.create(
          tenantId,
          projectId,
          nativeDto(),
          requester.id,
          tx,
          requester,
        ),
      ),
    ).rejects.toMatchObject({ code: "P2003" });
    expect(
      writes.filter(
        (row) => row.model === "CashFlowEntry" && row.action === "createMany",
      ),
    ).toMatchObject([{ outcome: "rejected", inTransaction: true }]);
    expect(await physical()).toEqual(before);
    expect(await journal()).toEqual([]);
    // SQLite RAISE(ABORT) is surfaced as P2003 by Prisma, without the trigger text.
    // The identical native write must succeed after removing only that trigger.
    await prisma.$executeRaw`DROP TRIGGER qa_planned_source_fail_last`;
    await clearObservation();
    const source = await inTx((tx) =>
      expenses.create(
        tenantId,
        projectId,
        nativeDto(),
        requester.id,
        tx,
        requester,
      ),
    );
    const cash = await prisma.cashFlowEntry.findMany({
      where: { expenseId: source.id, deletedAt: INCLUDE_SOFT_DELETED },
      orderBy: { data: "asc" },
    });
    expect(cash).toHaveLength(10);
    expect(cash[9]).toMatchObject({
      parcela: "10/10",
      valor: 6984,
      deletedAt: null,
      data: new Date("2027-08-10T00:00:00.000Z"),
    });
    const inserts = (await journal()).filter(
      (row) => row.tbl === "cash_flow_entries",
    );
    expect(inserts.map((row) => row.row_id).sort()).toEqual(
      cash.map((row) => row.id).sort(),
    );
  });

  it("NATIVE 6: invalid native card still rejects with no writes", async () => {
    const before = await physical();
    await expect(
      inTx((tx) =>
        expenses.create(
          tenantId,
          projectId,
          { ...nativeDto(), creditCardId: "absent-card" },
          requester.id,
          tx,
          requester,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await physical()).toEqual(before);
    expect(writes).toEqual([]);
  });
});
