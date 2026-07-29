import { Test, TestingModule } from '@nestjs/testing';
import { MonthlyOverviewService } from './monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';

/**
 * Fixture: prisma "vivo" o suficiente para exercitar o round-trip real
 * payInvoice -> settleInvoice -> undoInvoicePayment -> unsettleInvoice, sem
 * tocar banco (testes deste repo mockam o Prisma — ver
 * monthly-overview.account-view.spec.ts / conciliacao.service.spec.ts).
 */
function buildPrisma(seed: {
  tenantId: string;
  projectId: string;
  card: { id: string; last4: string; nickname: string; closingDay: number | null; dueDay: number | null };
  account: { last4: string };
  expenses: any[];
  entries: any[];
}) {
  const { tenantId, projectId, card, account, expenses, entries } = seed;
  let nextId = 1;

  function matchField(value: any, condition: any): boolean {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('not' in condition) return value !== condition.not;
      if ('notIn' in condition) return !condition.notIn.includes(value);
      if ('in' in condition) return condition.in.includes(value);
    }
    return value === condition;
  }

  function matchWhere(record: any, where: any): boolean {
    for (const key of Object.keys(where)) {
      if (key === 'expense') {
        const expense = expenses.find((e) => e.id === record.expenseId);
        if (!expense || !matchWhere(expense, where.expense)) return false;
        continue;
      }
      if (!matchField(record[key], where[key])) return false;
    }
    return true;
  }

  function withExpense(entry: any) {
    return { ...entry, expense: expenses.find((e) => e.id === entry.expenseId) ?? null };
  }

  const prisma: any = {
    project: {
      findFirst: jest.fn().mockResolvedValue({ id: projectId, tenantId, type: 'PESSOAL', deletedAt: null }),
    },
    creditCard: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where.last4 === card.last4 && where.tenantId === tenantId && where.projectId === projectId) {
          return Promise.resolve({ ...card });
        }
        return Promise.resolve(null);
      }),
    },
    bankAccount: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where.last4 === account.last4) return Promise.resolve({ ...account });
        return Promise.resolve(null);
      }),
    },
    expense: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        const found = expenses.find((e) => matchWhere(e, where));
        return Promise.resolve(found ?? null);
      }),
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        return Promise.resolve(expenses.filter((e) => matchWhere(e, where)));
      }),
      create: jest.fn().mockImplementation(({ data }: any) => {
        const created = { id: `payment-${nextId++}`, deletedAt: null, settlesInvoiceKey: null, ...data };
        expenses.push(created);
        return Promise.resolve(created);
      }),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const found = expenses.find((e) => e.id === where.id);
        if (found) Object.assign(found, data);
        return Promise.resolve(found);
      }),
    },
    cashFlowEntry: {
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        return Promise.resolve(entries.filter((en) => matchWhere(en, where)).map(withExpense));
      }),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const found = entries.find((en) => en.id === where.id);
        if (found) Object.assign(found, data);
        return Promise.resolve(found);
      }),
    },
    $transaction: jest.fn().mockImplementation((cb: any) => cb(prisma)),
  };

  return prisma;
}

function d(iso: string) {
  return new Date(`${iso}T00:00:00.000Z`);
}

describe('MonthlyOverviewService.undoInvoicePayment', () => {
  const tenantId = 'tenant-1';
  const projectId = 'pessoal-1';
  const card = { id: 'card-1', last4: '1234', nickname: 'Nubank', closingDay: 10, dueDay: 20 };
  const account = { last4: '9999' };

  async function buildService(prisma: any) {
    const settlement = new CardInvoiceSettlementService(prisma);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonthlyOverviewService,
        { provide: PrismaService, useValue: prisma },
        { provide: CardInvoiceSettlementService, useValue: settlement },
      ],
    }).compile();
    return module.get<MonthlyOverviewService>(MonthlyOverviewService);
  }

  function baseExpenses(): any[] {
    return [
      {
        id: 'exp-a',
        tenantId,
        projectId,
        tipoDespesa: 'ALIMENTACAO',
        cardLast4: '1234',
        bankLast4: null,
        formaPagamento: 'PARCELADO',
        quantidadeParcela: 2,
        status: 'PLANEJADO',
        paidParcelas: null,
        settlesInvoiceKey: null,
        deletedAt: null,
      },
      {
        id: 'exp-b',
        tenantId,
        projectId,
        tipoDespesa: 'LAZER',
        cardLast4: '1234',
        bankLast4: null,
        formaPagamento: 'A_VISTA',
        quantidadeParcela: null,
        status: 'PLANEJADO',
        paidParcelas: null,
        settlesInvoiceKey: null,
        deletedAt: null,
      },
    ];
  }

  function baseEntries() {
    return [
      // dueMonth 2026-05 (dia < closingDay=10 do mesmo mês)
      { id: 'a1', expenseId: 'exp-a', tenantId, tipo: 'DESPESA', status: 'PLANEJADO', parcela: '1/2', data: d('2026-05-05'), valor: 5_000, deletedAt: null },
      // dueMonth 2026-06
      { id: 'a2', expenseId: 'exp-a', tenantId, tipo: 'DESPESA', status: 'PLANEJADO', parcela: '2/2', data: d('2026-06-05'), valor: 5_000, deletedAt: null },
      // dueMonth 2026-05
      { id: 'b1', expenseId: 'exp-b', tenantId, tipo: 'DESPESA', status: 'PLANEJADO', parcela: null, data: d('2026-05-08'), valor: 3_000, deletedAt: null },
    ];
  }

  function snapshot(expenses: any[], entries: any[]) {
    return {
      expenses: expenses.map((e) => ({ id: e.id, status: e.status, paidParcelas: e.paidParcelas })),
      entries: entries.map((en) => ({ id: en.id, status: en.status })),
    };
  }

  it('round-trip: undoInvoicePayment reverte exatamente o que payInvoice+settleInvoice fizeram', async () => {
    const expenses = baseExpenses();
    const entries = baseEntries();
    const prisma = buildPrisma({ tenantId, projectId, card, account, expenses, entries });
    const service = await buildService(prisma);

    const before = snapshot(
      expenses.filter((e) => e.id !== 'payment-fixture'),
      entries,
    );

    const pay = await service.payInvoice(
      tenantId,
      projectId,
      {
        cardLast4: '1234',
        month: '2026-05',
        amountCents: 8_000, // a1 (5000) + b1 (3000)
        bankLast4: '9999',
        paymentDate: '2026-05-25T00:00:00.000Z',
      },
      'user-1',
    );
    expect(pay.ok).toBe(true);
    expect(pay.settledExpenses).toBe(2);
    expect(pay.settledParcelas).toBe(2);

    // Estado intermediário: a1/b1 pagos, exp-a parcialmente pago, exp-b pago.
    expect(entries.find((e) => e.id === 'a1')?.status).toBe('PAGO');
    expect(entries.find((e) => e.id === 'a2')?.status).toBe('PLANEJADO');
    expect(entries.find((e) => e.id === 'b1')?.status).toBe('PAGO');
    expect(expenses.find((e) => e.id === 'exp-a')?.status).toBe('PLANEJADO');
    expect(expenses.find((e) => e.id === 'exp-a')?.paidParcelas).toBe('[0]');
    expect(expenses.find((e) => e.id === 'exp-b')?.status).toBe('PAGO');

    const paymentExpenseId = pay.paymentExpenseId;

    const undo = await service.undoInvoicePayment(tenantId, projectId, {
      cardLast4: '1234',
      dueMonth: '2026-05',
    });

    expect(undo).toMatchObject({
      ok: true,
      undonePaymentExpenseId: paymentExpenseId,
      cardLast4: '1234',
      dueMonth: '2026-05',
      revertedExpenses: 2,
      revertedParcelas: 2,
    });

    // Estado volta EXATAMENTE ao anterior (comparação profunda).
    const after = snapshot(
      expenses.filter((e) => e.id !== paymentExpenseId),
      entries,
    );
    expect(after).toEqual(before);

    // A despesa de pagamento foi soft-deletada, não hard-deletada.
    const paymentRow = expenses.find((e) => e.id === paymentExpenseId);
    expect(paymentRow).toBeDefined();
    expect(paymentRow?.deletedAt).not.toBeNull();
  });

  it('recusa com 400 quando há mais de um pagamento casado com a mesma fatura, sem mutar nada', async () => {
    const expenses = baseExpenses();
    expenses.push(
      {
        id: 'pay-1',
        tenantId,
        projectId,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        cardLast4: '1234',
        bankLast4: '9999',
        formaPagamento: 'A_VISTA',
        quantidadeParcela: null,
        status: 'PAGO',
        paidParcelas: null,
        settlesInvoiceKey: null,
        valorTotal: 5_000,
        dataPagamento: d('2026-05-20'),
        createdAt: d('2026-05-20'),
        deletedAt: null,
      },
      {
        id: 'pay-2',
        tenantId,
        projectId,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        cardLast4: '1234',
        bankLast4: '9999',
        formaPagamento: 'A_VISTA',
        quantidadeParcela: null,
        status: 'PAGO',
        paidParcelas: null,
        settlesInvoiceKey: null,
        valorTotal: 3_000,
        dataPagamento: d('2026-05-22'),
        createdAt: d('2026-05-22'),
        deletedAt: null,
      },
    );
    const entries = baseEntries();
    entries.find((e) => e.id === 'a1')!.status = 'PAGO';
    entries.find((e) => e.id === 'b1')!.status = 'PAGO';
    const prisma = buildPrisma({ tenantId, projectId, card, account, expenses, entries });
    const service = await buildService(prisma);

    const before = JSON.parse(JSON.stringify({ expenses, entries }));

    await expect(
      service.undoInvoicePayment(tenantId, projectId, { cardLast4: '1234', dueMonth: '2026-05' }),
    ).rejects.toThrow('Há mais de um pagamento');

    expect(JSON.parse(JSON.stringify({ expenses, entries }))).toEqual(before);
  });

  it('recusa com 404 quando não há pagamento casado com a fatura', async () => {
    const expenses = baseExpenses();
    const entries = baseEntries();
    const prisma = buildPrisma({ tenantId, projectId, card, account, expenses, entries });
    const service = await buildService(prisma);

    await expect(
      service.undoInvoicePayment(tenantId, projectId, { cardLast4: '1234', dueMonth: '2026-05' }),
    ).rejects.toThrow('Nenhum pagamento encontrado');
  });
});
