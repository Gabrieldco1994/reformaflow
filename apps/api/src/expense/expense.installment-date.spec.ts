import { TEST_OWNER_REQUESTER } from '../test-utils/acl-requester-test-helper';
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ExpenseService } from "./expense.service";

const baseExpense = {
  id: "expense-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  tipoDespesa: "MATERIAL_CONSTRUCAO",
  categoriaMaoDeObra: null,
  roomId: null,
  valor: 1000,
  quantidade: 1,
  valorTotal: 3000,
  formaPagamento: "PARCELADO",
  quantidadeParcela: 3,
  dataInicioParcela: new Date("2026-08-10T00:00:00.000Z"),
  dataPagamento: null,
  status: "PLANEJADO",
  paidParcelas: "[1]",
  installmentDateOverrides: null,
  cardLast4: null,
  bankLast4: null,
  settlesInvoiceKey: null,
  settledByExpenseId: null,
  linkedExpenseId: null,
  room: null,
} as {
  id: string;
  tenantId: string;
  projectId: string;
  tipoDespesa: string;
  categoriaMaoDeObra: null;
  roomId: null;
  valor: number;
  quantidade: number;
  valorTotal: number;
  formaPagamento: string;
  quantidadeParcela: number;
  dataInicioParcela: Date;
  dataPagamento: null;
  status: string;
  paidParcelas: string | null;
  installmentDateOverrides: string | null;
  cardLast4: string | null;
  bankLast4: string | null;
  settlesInvoiceKey: string | null;
  settledByExpenseId: null;
  linkedExpenseId: string | null;
  room: null;
};

type ExpenseFixture = typeof baseExpense;

function makeHarness(expense: ExpenseFixture = baseExpense) {
  let currentExpense = expense;
  const tx = {
    project: {
      findFirst: jest.fn().mockResolvedValue({ id: expense.projectId }),
    },
    expense: {
      findFirst: jest.fn().mockResolvedValue(expense),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest
        .fn()
        .mockImplementation(() => Promise.resolve(currentExpense)),
      update: jest.fn().mockImplementation(({ data }) => {
        currentExpense = { ...currentExpense, ...data };
        return Promise.resolve(currentExpense);
      }),
    },
    rateioAllocation: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    crossProjectSettlement: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    cashFlowEntry: {
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      createMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn().mockImplementation(async (fn) => fn(tx)),
  };
  const conciliacao = {
    regenerateTargetCashflow: jest.fn(),
    regenerateRateioTargetCashflow: jest.fn(),
  };
  return {
    service: new ExpenseService(prisma as never, conciliacao as never),
    prisma,
    tx,
    conciliacao,
  };
}

describe("ExpenseService.updateInstallmentDate", () => {
  it("altera somente a data do índice e preserva pagamento, valores e identidade", async () => {
    const { service, tx } = makeHarness();

    const result = await service.updateInstallmentDate(
      "tenant-1",
      "project-1",
      "expense-1",
      1,
      "2026-09-20",
    );

    expect(tx.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "expense-1" },
        data: { installmentDateOverrides: '{"1":"2026-09-20"}' },
      }),
    );
    expect(result).toEqual({
      id: "expense-1",
      parcela: 1,
      data: "2026-09-20",
      isOverride: true,
      affectedProjectIds: ["project-1"],
    });
  });

  it("recria as parcelas de neutro no cartão na data efetiva e preserva o vínculo da fatura", async () => {
    const expense = {
      ...baseExpense,
      tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
      valorTotal: 2000,
      quantidadeParcela: 2,
      cardLast4: "1111",
      settlesInvoiceKey: "1111:2026-09",
    };
    const { service, tx } = makeHarness(expense);

    await service.updateInstallmentDate(
      "tenant-1",
      "project-1",
      "expense-1",
      1,
      "2026-10-05",
    );

    expect(tx.cashFlowEntry.createMany).toHaveBeenCalledTimes(1);
    const entries = tx.cashFlowEntry.createMany.mock.calls[0][0].data as Array<{
      expenseId: string;
      data: Date;
      valor: number;
      status: string;
      parcela: string | null;
    }>;
    expect(
      entries.map(({ expenseId, data, valor, status, parcela }) => ({
        expenseId,
        data,
        valor,
        status,
        parcela,
      })),
    ).toEqual([
      {
        expenseId: "expense-1",
        data: new Date("2026-08-10T00:00:00.000Z"),
        valor: 1000,
        status: "PLANEJADO",
        parcela: "1/2",
      },
      {
        expenseId: "expense-1",
        data: new Date("2026-10-05T00:00:00.000Z"),
        valor: 1000,
        status: "PAGO",
        parcela: "2/2",
      },
    ]);
    expect(tx.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { installmentDateOverrides: '{"1":"2026-10-05"}' },
      }),
    );
    expect(expense.settlesInvoiceKey).toBe("1111:2026-09");
  });

  it("não transforma neutro movimentado por conta em cobrança de cartão", async () => {
    const expense = {
      ...baseExpense,
      tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
      cardLast4: "1111",
      bankLast4: "4242",
    };
    const { service, tx } = makeHarness(expense);

    await service.updateInstallmentDate(
      "tenant-1",
      "project-1",
      "expense-1",
      0,
      "2026-08-15",
    );

    expect(tx.cashFlowEntry.createMany).not.toHaveBeenCalled();
  });

  it("remove o override quando a data volta à data base e é idempotente", async () => {
    const expense = {
      ...baseExpense,
      installmentDateOverrides: '{"1":"2026-09-20"}',
    };
    const unchanged = makeHarness(expense);
    await unchanged.service.updateInstallmentDate(
      "tenant-1",
      "project-1",
      "expense-1",
      1,
      "2026-09-20",
    );
    expect(unchanged.tx.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { installmentDateOverrides: '{"1":"2026-09-20"}' },
      }),
    );

    const restored = makeHarness(expense);
    const result = await restored.service.updateInstallmentDate(
      "tenant-1",
      "project-1",
      "expense-1",
      1,
      "2026-09-10",
    );

    expect(restored.tx.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { installmentDateOverrides: null } }),
    );
    expect(result).toEqual({
      id: "expense-1",
      parcela: 1,
      data: "2026-09-10",
      isOverride: false,
      affectedProjectIds: ["project-1"],
    });
  });

  it("preserva uma despesa integralmente paga", async () => {
    const paid = makeHarness({
      ...baseExpense,
      status: "PAGO",
      paidParcelas: null,
    });

    const result = await paid.service.updateInstallmentDate(
      "tenant-1",
      "project-1",
      "expense-1",
      1,
      "2026-09-20",
    );

    expect(result).toEqual({
      id: "expense-1",
      parcela: 1,
      data: "2026-09-20",
      isOverride: true,
      affectedProjectIds: ["project-1"],
    });
  });

  it("respeita tenant/projeto, forma e range", async () => {
    const missing = makeHarness();
    missing.tx.expense.findFirst.mockResolvedValueOnce(null);
    await expect(
      missing.service.updateInstallmentDate(
        "tenant-1",
        "project-x",
        "expense-1",
        1,
        "2026-09-20",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    const single = makeHarness({ ...baseExpense, formaPagamento: "A_VISTA" });
    await expect(
      single.service.updateInstallmentDate(
        "tenant-1",
        "project-1",
        "expense-1",
        0,
        "2026-09-20",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const ranged = makeHarness();
    await expect(
      ranged.service.updateInstallmentDate(
        "tenant-1",
        "project-1",
        "expense-1",
        3,
        "2026-09-20",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("bloqueia alvo de rateio com orientação acionável", async () => {
    const { service, tx } = makeHarness();
    tx.rateioAllocation.findFirst.mockResolvedValueOnce({
      sourceExpenseId: "source-1",
      targetExpenseId: "expense-1",
    });

    await expect(
      service.updateInstallmentDate(
        "tenant-1",
        "project-1",
        "expense-1",
        1,
        "2026-09-20",
      ),
    ).rejects.toThrow(/fonte.*rateio/i);
  });

  it("sincroniza par simples na mesma transação e não altera fonte de conciliação", async () => {
    const mirror = {
      ...baseExpense,
      id: "mirror-1",
      projectId: "project-2",
      linkedExpenseId: "expense-1",
    };
    const pair = makeHarness(mirror);
    pair.tx.expense.findFirst
      .mockResolvedValueOnce(mirror)
      .mockResolvedValueOnce(baseExpense);
    pair.tx.expense.findMany.mockResolvedValueOnce([{ id: "expense-1" }]);

    const pairResult = await pair.service.updateInstallmentDate(
      "tenant-1",
      "project-2",
      "mirror-1",
      1,
      "2026-09-20",
    );
    expect(pair.tx.expense.update).toHaveBeenCalledTimes(2);
    expect(pair.tx.expense.update).toHaveBeenLastCalledWith({
      where: { id: "expense-1" },
      data: { installmentDateOverrides: '{"1":"2026-09-20"}' },
    });
    expect(pairResult).toEqual({
      id: "mirror-1",
      parcela: 1,
      data: "2026-09-20",
      isOverride: true,
      affectedProjectIds: ["project-1", "project-2"],
    });

    const settlement = makeHarness(baseExpense);
    settlement.tx.crossProjectSettlement.findMany.mockResolvedValueOnce([
      {
        sourceExpenseId: "real-source",
        targetExpenseId: "expense-1",
      },
    ]);
    const settlementResult = await settlement.service.updateInstallmentDate(
      "tenant-1",
      "project-1",
      "expense-1",
      1,
      "2026-09-20",
    );
    expect(settlement.tx.expense.update).toHaveBeenCalledTimes(1);
    expect(
      settlement.conciliacao.regenerateTargetCashflow,
    ).toHaveBeenCalledWith(settlement.tx, "expense-1");
    expect(settlementResult).toEqual({
      id: "expense-1",
      parcela: 1,
      data: "2026-09-20",
      isOverride: true,
      affectedProjectIds: ["project-1"],
    });
  });

  it("propaga cronograma da fonte de rateio para todos os alvos", async () => {
    const { service, tx, conciliacao } = makeHarness();
    tx.rateioAllocation.findMany.mockResolvedValueOnce([
      {
        sourceExpenseId: "expense-1",
        targetExpenseId: "target-1",
        target: {
          id: "target-1",
          projectId: "project-3",
          tenantId: "tenant-1",
          deletedAt: null,
        },
      },
      {
        sourceExpenseId: "expense-1",
        targetExpenseId: "target-2",
        target: {
          id: "target-2",
          projectId: "project-2",
          tenantId: "tenant-1",
          deletedAt: null,
        },
      },
    ]);

    const result = await service.updateInstallmentDate(
      "tenant-1",
      "project-1",
      "expense-1",
      1,
      "2026-09-20",
    );

    expect(conciliacao.regenerateRateioTargetCashflow).toHaveBeenCalledTimes(2);
    expect(tx.expense.update).toHaveBeenCalledWith({
      where: { id: "target-1" },
      data: { installmentDateOverrides: '{"1":"2026-09-20"}' },
    });
    expect(result).toEqual({
      id: "expense-1",
      parcela: 1,
      data: "2026-09-20",
      isOverride: true,
      affectedProjectIds: ["project-1", "project-2", "project-3"],
    });
  });

  it("faz rollback do par simples quando a atualização do espelho falha", async () => {
    const expense = { ...baseExpense, linkedExpenseId: "mirror-1" };
    const { service, tx } = makeHarness(expense);
    tx.expense.findFirst.mockResolvedValueOnce(expense).mockResolvedValueOnce({
      ...baseExpense,
      id: "mirror-1",
      projectId: "project-2",
    });
    tx.expense.update
      .mockResolvedValueOnce({
        ...expense,
        installmentDateOverrides: '{"1":"2026-09-20"}',
      })
      .mockRejectedValueOnce(new Error("falha no espelho"));

    await expect(
      service.updateInstallmentDate(
        "tenant-1",
        "project-1",
        "expense-1",
        1,
        "2026-09-20",
      ),
    ).rejects.toThrow("falha no espelho");
    expect(tx.expense.update).toHaveBeenCalledTimes(2);
  });

  it("bloqueia alteração da fonte real de uma conciliação", async () => {
    const { service, tx } = makeHarness();
    tx.crossProjectSettlement.findMany.mockResolvedValueOnce([
      {
        sourceExpenseId: "expense-1",
        targetExpenseId: "planned-1",
      },
    ]);

    await expect(
      service.updateInstallmentDate(
        "tenant-1",
        "project-1",
        "expense-1",
        1,
        "2026-09-20",
      ),
    ).rejects.toThrow(/fonte real/i);
    expect(tx.expense.update).not.toHaveBeenCalled();
  });

  it("PATCH comum normaliza overrides ao reduzir parcelas ou mudar para forma única", async () => {
    const expense = {
      ...baseExpense,
      installmentDateOverrides:
        '{"0":"2026-08-11","1":"2026-09-20","2":"2026-10-20"}',
    };
    const reduced = makeHarness(expense);
    await reduced.service.update("tenant-1", "project-1", "expense-1", {
      quantidadeParcela: 2,
    } as never, TEST_OWNER_REQUESTER);
    expect(reduced.tx.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          installmentDateOverrides: '{"0":"2026-08-11","1":"2026-09-20"}',
        }),
      }),
    );

    const single = makeHarness(expense);
    await single.service.update("tenant-1", "project-1", "expense-1", {
      formaPagamento: "A_VISTA",
    } as never, TEST_OWNER_REQUESTER);
    expect(single.tx.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ installmentDateOverrides: null }),
      }),
    );
  });

  it("PATCH alheio ao cronograma não regrava o snapshot de overrides", async () => {
    const expense = {
      ...baseExpense,
      installmentDateOverrides: '{"1":"2026-09-20"}',
      linkedExpenseId: "mirror-1",
    };
    const { service, tx } = makeHarness(expense);
    const linkedRows = [
      {
        ...expense,
        project: { id: expense.projectId, tenantId: expense.tenantId, type: "REFORMA" },
      },
      {
        ...expense,
        id: "mirror-1",
        linkedExpenseId: null,
        project: { id: expense.projectId, tenantId: expense.tenantId, type: "REFORMA" },
      },
    ];
    tx.expense.findFirst
      .mockResolvedValueOnce(expense)
      .mockResolvedValueOnce(expense)
      .mockResolvedValueOnce({ id: "mirror-1" });
    tx.expense.findMany
      .mockResolvedValueOnce(linkedRows)
      .mockResolvedValueOnce(linkedRows)
      .mockResolvedValue([]);

    await service.update("tenant-1", "project-1", "expense-1", {
      tipoDespesa: "MAO_DE_OBRA",
      titulo: "Título atualizado",
    } as never, TEST_OWNER_REQUESTER);

    expect(tx.expense.update).toHaveBeenCalledTimes(2);
    for (const [{ data }] of tx.expense.update.mock.calls) {
      expect(data).not.toHaveProperty("installmentDateOverrides");
    }
  });
});
