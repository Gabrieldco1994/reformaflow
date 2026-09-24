import { PrismaClient, CashFlowEntry, Expense } from "@prisma/client";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  ExpenseType,
  ExpenseTypeLabels,
  LaborCategory,
  LaborCategoryLabels,
} from "@reformaflow/domain";
import { PrismaService } from "../prisma/prisma.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { CreditCardService } from "../credit-card/credit-card.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { CashFlowService } from "../cash-flow/cash-flow.service";
import { ExpenseService } from "./expense.service";
import { UpdateExpenseDto } from "./dto/update-expense.dto";
import {
  resetTenant,
  pessoalRequester,
  seedPessoal,
  seedCardWithClosingDue,
} from "../bank-account/__tests__/invoice-undo.fixtures";

const TENANT = "Synthetic12345c-695";
const PROJECT = `${TENANT}-pessoal`;
const OTHER_PROJECT = `${TENANT}-other`;
const REQUESTER = {
  ...pessoalRequester(PROJECT),
  id: `${TENANT}-user`,
  allowedProjects: [PROJECT, OTHER_PROJECT],
};
const setup = new PrismaClient();
const prisma = new PrismaService();
const conciliacao = new ConciliacaoService(prisma);
const expenses = new ExpenseService(prisma, conciliacao);
const cards = new CreditCardService(
  prisma,
  conciliacao,
  new MerchantClassifierService(prisma),
);
const cash = new CashFlowService(prisma);

function withoutUpdatedAt({
  updatedAt: _updatedAt,
  ...entry
}: CashFlowEntry): Omit<CashFlowEntry, "updatedAt"> {
  return entry;
}

describe("#695 completed card imports preserve original cash-flow metadata", () => {
  let cardId: string;

  beforeAll(async () => {
    await prisma.$connect();
    await setup.$connect();
  });
  beforeEach(async () => {
    await setup.user.deleteMany({ where: { tenantId: TENANT } });
    await setup.room.deleteMany({ where: { projectId: PROJECT } });
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, {
      tenantId: TENANT,
      projectId: PROJECT,
      name: TENANT,
    });
    await setup.user.create({
      data: {
        id: REQUESTER.id, username: REQUESTER.id, name: "Synthetic ACL fixture",
        tenantId: TENANT, role: REQUESTER.role,
        allowedProjects: JSON.stringify(REQUESTER.allowedProjects),
        allowedModules: JSON.stringify(REQUESTER.allowedModules),
        allowedProjectTypes: JSON.stringify(REQUESTER.allowedProjectTypes),
      },
    });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PROJECT,
      last4: "1234",
      nickname: TENANT,
    }));
  });
  afterAll(async () => {
    await setup.user.deleteMany({ where: { tenantId: TENANT } });
    await setup.room.deleteMany({ where: { projectId: PROJECT } });
    await resetTenant(setup, TENANT);
    await prisma.$disconnect();
    await setup.$disconnect();
  });

  async function importPurchase(current = 2): Promise<Expense> {
    const result = await cards.commitImport(
      TENANT,
      PROJECT,
      cardId,
      Buffer.from(
        `date,title,amount\n2026-06-10,Synthetic12345c ${current}/3,123.45`,
      ),
      "Synthetic12345c.csv",
      "CSV_GENERIC",
      undefined,
      undefined,
      undefined,
      null,
      REQUESTER,
    );
    expect(result.inserted).toBe(1);
    const purchase = await prisma.expense.findFirstOrThrow({
      where: { tenantId: TENANT, importId: result.importId },
    });
    const entries = await rows(purchase.id);
    expect(entries.map((entry) => entry.parcela)).toEqual(
      current === 2 ? ["2/3", "3/3"] : ["3/3"],
    );
    expect(
      entries.every(
        (entry) =>
          entry.valor === 12345 &&
          entry.formaPagamento === "CARTAO_CREDITO" &&
          entry.subcategoria === TENANT,
      ),
    ).toBe(true);
    return purchase;
  }

  async function rows(expenseId: string): Promise<CashFlowEntry[]> {
    // Raw client is inspection only: include soft-deleted rows to detect regeneration.
    return setup.cashFlowEntry.findMany({
      where: { expenseId },
      orderBy: [{ data: "asc" }, { id: "asc" }],
    });
  }

  it.each([2, 3])(
    "category/title preserve every financial column and original labels starting at %i/3",
    async (current) => {
      const purchase = await importPurchase(current);
      const before = await rows(purchase.id);
      await expenses.update(
        TENANT,
        PROJECT,
        purchase.id,
        {
          tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
          titulo: "Synthetic12345c edited",
          fornecedor: "Synthetic12345c supplier",
        },
        REQUESTER,
      );
      expect((await rows(purchase.id)).map(withoutUpdatedAt)).toEqual(
        before.map((entry) => ({
          ...withoutUpdatedAt(entry),
          categoria: ExpenseTypeLabels.MATERIAL_CONSTRUCAO,
        })),
      );
      const visible = (await cash.findAll(TENANT, PROJECT)).filter(
        (entry) => entry.expenseId === purchase.id,
      );
      expect(visible.map((entry) => entry.parcela)).toEqual(
        before.map((entry) => entry.parcela),
      );
      expect(
        visible.every(
          (entry) =>
            entry.titulo === "Synthetic12345c edited" &&
            entry.fornecedor === "Synthetic12345c supplier",
        ),
      ).toBe(true);
    },
  );

  it("labor/room change only their columns; repeated, omitted and explicit clear fields preserve the rest", async () => {
    const purchase = await importPurchase();
    const room = await setup.room.create({
      data: { projectId: PROJECT, name: TENANT },
    });
    const before = await rows(purchase.id);
    const labor = Object.values(LaborCategory)[0];
    const patch = { categoriaMaoDeObra: labor, roomId: room.id };
    await expenses.update(TENANT, PROJECT, purchase.id, patch, REQUESTER);
    const changed = await rows(purchase.id);
    expect(changed.map(withoutUpdatedAt)).toEqual(
      before.map((entry) => ({
        ...withoutUpdatedAt(entry),
        subcategoria: LaborCategoryLabels[labor],
        ambiente: room.name,
      })),
    );
    await expenses.update(TENANT, PROJECT, purchase.id, patch, REQUESTER);
    await expenses.update(TENANT, PROJECT, purchase.id, {}, REQUESTER);
    expect(await rows(purchase.id)).toEqual(changed);
    await expenses.update(
      TENANT,
      PROJECT,
      purchase.id,
      {
        categoriaMaoDeObra: null,
        roomId: null,
      } as unknown as UpdateExpenseDto,
      REQUESTER,
    );
    expect((await rows(purchase.id)).map(withoutUpdatedAt)).toEqual(
      before.map((entry) => ({
        ...withoutUpdatedAt(entry),
        subcategoria: null,
        ambiente: null,
      })),
    );
  });

  it("equivalent full forms preserve stored derived value, paid indices, overrides and all CFEs", async () => {
    const purchase = await importPurchase();
    // Boundary fixture: historical derived state is not an instruction to repair it.
    await setup.expense.update({
      where: { id: purchase.id },
      data: {
        valorTotal: 12345,
        paidParcelas: "[0]",
        installmentDateOverrides: '{"1":"2026-07-12"}',
      },
    });
    const before = await setup.expense.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    const entries = await rows(purchase.id);
    await expenses.update(
      TENANT,
      PROJECT,
      purchase.id,
      {
        valor: purchase.valor / 100 + 0.00001,
        quantidade: purchase.quantidade,
        quantidadeParcela: purchase.quantidadeParcela,
        formaPagamento: purchase.formaPagamento,
        status: purchase.status,
        dataPagamento: "2026-06-10T00:00:00.000Z",
        dataInicioParcela: "2026-06-10T00:00:00+00:00",
        titulo: purchase.titulo,
      } as UpdateExpenseDto,
      REQUESTER,
    );
    expect(await rows(purchase.id)).toEqual(entries);
    expect(
      await setup.expense.findUniqueOrThrow({ where: { id: purchase.id } }),
    ).toMatchObject({
      valorTotal: before.valorTotal,
      paidParcelas: before.paidParcelas,
      installmentDateOverrides: before.installmentDateOverrides,
    });
    await expenses.update(
      TENANT,
      PROJECT,
      purchase.id,
      { valor: 123.45 },
      REQUESTER,
    );
    expect(
      (await setup.expense.findUniqueOrThrow({ where: { id: purchase.id } }))
        .valorTotal,
    ).toBe(12345);
    expect(
      (await rows(purchase.id))
        .filter((entry) => !entry.deletedAt)
        .every((entry) => !entries.some((old) => old.id === entry.id)),
    ).toBe(true);
  });

  it("metadata never invents missing cash rows, including neutral transitions", async () => {
    const purchase = await expenses.create(
      TENANT,
      PROJECT,
      {
        tipoDespesa: ExpenseType.MOVIMENTACAO_INTERNA,
        valor: 123.45,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PAGO",
        titulo: TENANT,
      },
      null,
      undefined,
      REQUESTER,
    );
    expect(await rows(purchase.id)).toEqual([]);
    await expenses.update(
      TENANT,
      PROJECT,
      purchase.id,
      { tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO },
      REQUESTER,
    );
    expect(await rows(purchase.id)).toEqual([]);
    const imported = await importPurchase();
    const before = await rows(imported.id);
    await expenses.update(
      TENANT,
      PROJECT,
      imported.id,
      { tipoDespesa: ExpenseType.MOVIMENTACAO_INTERNA },
      REQUESTER,
    );
    expect((await rows(imported.id)).map(withoutUpdatedAt)).toEqual(
      before.map((entry) => ({
        ...withoutUpdatedAt(entry),
        categoria: ExpenseTypeLabels.MOVIMENTACAO_INTERNA,
      })),
    );
  });

  it("simple pair full-form no-ops preserve counterpart-specific descriptions, paid state and stored totals", async () => {
    const purchase = await importPurchase();
    await setup.project.create({
      data: {
        id: OTHER_PROJECT,
        tenantId: TENANT,
        type: "PESSOAL",
        name: TENANT,
      },
    });
    const counterpart = await expenses.create(
      TENANT,
      OTHER_PROJECT,
      {
        tipoDespesa: ExpenseType.OUTROS,
        valor: 123.45,
        quantidade: 1,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 2,
        dataInicioParcela: "2026-06-10",
        status: "PLANEJADO",
        titulo: "Synthetic12345c independent",
        linkedExpenseId: purchase.id,
      },
      null,
      undefined,
      REQUESTER,
    );
    await setup.expense.update({
      where: { id: counterpart.id },
      data: {
        valorTotal: 12346,
        paidParcelas: "[0]",
        installmentDateOverrides: '{"1":"2026-07-12"}',
      },
    });
    const before = await setup.expense.findUniqueOrThrow({
      where: { id: counterpart.id },
    });
    const entries = await rows(counterpart.id);
    await expenses.update(
      TENANT,
      PROJECT,
      purchase.id,
      {
        titulo: purchase.titulo,
        tipoDespesa: purchase.tipoDespesa,
        valor: purchase.valor / 100,
        quantidade: purchase.quantidade,
        formaPagamento: purchase.formaPagamento,
        quantidadeParcela: purchase.quantidadeParcela,
        status: purchase.status,
        dataInicioParcela: "2026-06-10T00:00:00.000Z",
      } as UpdateExpenseDto,
      REQUESTER,
    );
    expect(
      await setup.expense.findUniqueOrThrow({ where: { id: counterpart.id } }),
    ).toEqual(before);
    expect(await rows(counterpart.id)).toEqual(entries);

    await expenses.update(
      TENANT,
      PROJECT,
      purchase.id,
      {
        titulo: "Synthetic12345c shared",
        tipoDespesa: ExpenseType.MAO_DE_OBRA,
      },
      REQUESTER,
    );
    expect(
      await setup.expense.findUniqueOrThrow({ where: { id: counterpart.id } }),
    ).toMatchObject({
      titulo: "Synthetic12345c shared",
      tipoDespesa: ExpenseType.MAO_DE_OBRA,
      valorTotal: before.valorTotal,
      paidParcelas: before.paidParcelas,
      installmentDateOverrides: before.installmentDateOverrides,
    });
    expect((await rows(counterpart.id)).map(withoutUpdatedAt)).toEqual(
      entries.map((entry) => ({
        ...withoutUpdatedAt(entry),
        categoria: ExpenseTypeLabels.MAO_DE_OBRA,
      })),
    );
  });

  it("metadata touches only active rows of the expense, never historical or unrelated rows", async () => {
    const purchase = await importPurchase();
    const entries = await rows(purchase.id);
    await setup.cashFlowEntry.update({
      where: { id: entries[0].id },
      data: { deletedAt: new Date("2026-06-11") },
    });
    const historical = await setup.cashFlowEntry.findUniqueOrThrow({
      where: { id: entries[0].id },
    });
    const unrelated = await expenses.create(TENANT, PROJECT, {
      tipoDespesa: ExpenseType.OUTROS,
      valor: 123.45,
      quantidade: 1,
      formaPagamento: "A_VISTA",
      status: "PLANEJADO",
      titulo: TENANT,
    });
    const otherRows = await rows(unrelated.id);
    await expenses.update(
      TENANT,
      PROJECT,
      purchase.id,
      { tipoDespesa: ExpenseType.MAO_DE_OBRA },
      REQUESTER,
    );
    expect(
      await setup.cashFlowEntry.findUniqueOrThrow({
        where: { id: historical.id },
      }),
    ).toEqual(historical);
    expect(await rows(unrelated.id)).toEqual(otherRows);
    expect((await rows(purchase.id)).map(withoutUpdatedAt)).toEqual([
      withoutUpdatedAt(historical),
      {
        ...withoutUpdatedAt(entries[1]),
        categoria: ExpenseTypeLabels.MAO_DE_OBRA,
      },
    ]);
  });

  it.each<UpdateExpenseDto>([
    { valor: 123.45 },
    { quantidade: 2 },
    { dataInicioParcela: "2026-06-12" },
    { status: "PAGO" },
  ])("real financial changes retain regeneration: %j", async (patch) => {
    const purchase = await importPurchase();
    const before = await rows(purchase.id);
    await expenses.update(TENANT, PROJECT, purchase.id, patch, REQUESTER);
    const after = await rows(purchase.id);
    expect(
      after
        .filter((entry) => before.some((old) => old.id === entry.id))
        .every((entry) => entry.deletedAt !== null),
    ).toBe(true);
    expect(after.filter((entry) => !entry.deletedAt)).toHaveLength(2);
  });

  it.each(["rateio", "settlement"] as const)(
    "%s metadata preserves real amounts and independent target descriptions",
    async (kind) => {
      const source = await importPurchase(3);
      await setup.project.create({
        data: {
          id: OTHER_PROJECT,
          tenantId: TENANT,
          type: "REFORMA",
          name: TENANT,
        },
      });
      const requester = {
        ...REQUESTER,
        allowedProjectTypes: ["PESSOAL", "REFORMA"],
      };
      const target = await expenses.create(TENANT, OTHER_PROJECT, {
        tipoDespesa: ExpenseType.MAO_DE_OBRA,
        valor: 123.46,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
        dataPagamento: "2026-06-10",
        titulo: "Synthetic12345c target",
      });
      if (kind === "rateio") {
        await expenses.ratear(
          TENANT,
          PROJECT,
          source.id,
          [{ targetExpenseId: target.id, allocation: 12345 }],
          requester,
        );
      } else {
        await expenses.conciliarParcela(
          TENANT,
          PROJECT,
          source.id,
          { targetExpenseId: target.id, realValor: 12345 },
          requester,
        );
      }
      const before = await setup.expense.findUniqueOrThrow({
        where: { id: target.id },
      });
      const entries = await rows(target.id);
      const live = entries.filter((entry) => !entry.deletedAt);
      expect(live.reduce((sum, entry) => sum + entry.valor, 0)).toBe(12345);
      const allocations = await setup.rateioAllocation.findMany({
        where: { tenantId: TENANT },
      });
      const settlements = await setup.crossProjectSettlement.findMany({
        where: { tenantId: TENANT },
      });
      await expenses.update(
        TENANT,
        PROJECT,
        source.id,
        {
          titulo: "Synthetic12345c source only",
          tipoDespesa: ExpenseType.ALIMENTACAO,
        },
        requester,
      );
      expect(
        await setup.expense.findUniqueOrThrow({ where: { id: target.id } }),
      ).toEqual(before);
      expect(await rows(target.id)).toEqual(entries);
      await expenses.update(
        TENANT,
        OTHER_PROJECT,
        target.id,
        { tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO },
        requester,
      );
      expect(
        await setup.expense.findUniqueOrThrow({ where: { id: target.id } }),
      ).toMatchObject({
        valor: before.valor,
        quantidade: before.quantidade,
        valorTotal: before.valorTotal,
        paidParcelas: before.paidParcelas,
        installmentDateOverrides: before.installmentDateOverrides,
      });
      expect((await rows(target.id)).map(withoutUpdatedAt)).toEqual(
        entries.map((entry) => ({
          ...withoutUpdatedAt(entry),
          ...(entry.deletedAt
            ? {}
            : { categoria: ExpenseTypeLabels.MATERIAL_CONSTRUCAO }),
        })),
      );
      expect(
        await setup.rateioAllocation.findMany({ where: { tenantId: TENANT } }),
      ).toEqual(allocations);
      expect(
        await setup.crossProjectSettlement.findMany({
          where: { tenantId: TENANT },
        }),
      ).toEqual(settlements);
      const snapshot = await setup.expense.findMany({
        where: { tenantId: TENANT },
        orderBy: { id: "asc" },
      });
      for (const patch of [
        { quantidade: 2 },
        { tipoDespesa: ExpenseType.MOVIMENTACAO_INTERNA },
      ]) {
        await expect(
          expenses.update(TENANT, PROJECT, source.id, patch, requester),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          expenses.update(TENANT, OTHER_PROJECT, target.id, patch, requester),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(
        await setup.expense.findMany({
          where: { tenantId: TENANT },
          orderBy: { id: "asc" },
        }),
      ).toEqual(snapshot);
    },
  );

  it("hidden counterpart and wrong tenant reject atomically before metadata writes", async () => {
    const source = await importPurchase();
    await setup.project.create({
      data: {
        id: OTHER_PROJECT,
        tenantId: TENANT,
        type: "PESSOAL",
        name: TENANT,
      },
    });
    await expenses.create(
      TENANT,
      OTHER_PROJECT,
      {
        tipoDespesa: ExpenseType.OUTROS,
        valor: 123.45,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
        titulo: TENANT,
        linkedExpenseId: source.id,
      },
      null,
      undefined,
      REQUESTER,
    );
    const before = await setup.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    });
    const entries = await rows(source.id);
    const patch = { tipoDespesa: ExpenseType.MAO_DE_OBRA };
    await expect(
      expenses.update(
        TENANT,
        PROJECT,
        source.id,
        patch,
        pessoalRequester(PROJECT),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      expenses.update(`${TENANT}-wrong`, PROJECT, source.id, patch, REQUESTER),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      await setup.expense.findMany({
        where: { tenantId: TENANT },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
    expect(await rows(source.id)).toEqual(entries);
  });
});
