import { CardInvoiceSettlementService } from './card-invoice-settlement.service';

/**
 * Mock mínimo de Prisma para o settlement. Guarda expenses e cashFlowEntries
 * em memória e implementa só os métodos usados pelo serviço.
 */
function makePrisma(seed: {
  expenses: any[];
  entries: any[];
  imports?: any[];
}) {
  const expenses = seed.expenses;
  const entries = seed.entries;
  const imports = seed.imports ?? [];

  const matchWhere = (row: any, where: any): boolean => {
    for (const [k, v] of Object.entries(where ?? {})) {
      if (k === 'deletedAt') {
        if ((row.deletedAt ?? null) !== (v ?? null)) return false;
      } else if (v && typeof v === 'object' && 'notIn' in v) {
        if ((v.notIn as any[]).includes(row[k])) return false;
      } else if (v && typeof v === 'object' && 'not' in v) {
        if (row[k] === (v as any).not) return false;
      } else if (v && typeof v === 'object' && ('gte' in v || 'lte' in v)) {
        if ('gte' in v && row[k] < (v as any).gte) return false;
        if ('lte' in v && row[k] > (v as any).lte) return false;
      } else {
        if (row[k] !== v) return false;
      }
    }
    return true;
  };

  return {
    _expenses: expenses,
    _entries: entries,
    expense: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(expenses.filter((e) => matchWhere(e, where))),
      ),
      update: jest.fn(({ where, data }: any) => {
        const e = expenses.find((x) => x.id === where.id);
        Object.assign(e, data);
        return Promise.resolve(e);
      }),
    },
    cashFlowEntry: {
      findMany: jest.fn(({ where, orderBy }: any) => {
        let rows = entries.filter((en) => matchWhere(en, where));
        if (orderBy?.data === 'asc') rows = [...rows].sort((a, b) => a.data - b.data);
        return Promise.resolve(rows);
      }),
      update: jest.fn(({ where, data }: any) => {
        const en = entries.find((x) => x.id === where.id);
        Object.assign(en, data);
        return Promise.resolve(en);
      }),
    },
    creditCardStatementImport: {
      findFirst: jest.fn(({ where }: any) => {
        const rows = imports.filter((i) => matchWhere(i, where));
        return Promise.resolve(rows[0] ?? null);
      }),
    },
  } as any;
}

const CARD = { id: 'card1', last4: '5868', closingDay: 3, dueDay: 10 };
const d = (iso: string) => new Date(iso + 'T00:00:00.000Z');

describe('CardInvoiceSettlementService', () => {
  it('due-month: liquida a parcela cuja fatura vence no mês do pagamento', async () => {
    // Compra parcelada 3x em 10/jun (closing 3, due 10 → parcela 1 vence jul).
    const expense = {
      id: 'e1', tenantId: 't1', cardLast4: '5868', tipoDespesa: 'OUTROS',
      formaPagamento: 'PARCELADO', quantidadeParcela: 3, status: 'PLANEJADO',
      paidParcelas: null, deletedAt: null, importId: 'imp1',
    };
    const entries = [
      { id: 'c0', expenseId: 'e1', status: 'PLANEJADO', parcela: '1/3', data: d('2026-06-10'), deletedAt: null },
      { id: 'c1', expenseId: 'e1', status: 'PLANEJADO', parcela: '2/3', data: d('2026-07-10'), deletedAt: null },
      { id: 'c2', expenseId: 'e1', status: 'PLANEJADO', parcela: '3/3', data: d('2026-08-10'), deletedAt: null },
    ];
    const prisma = makePrisma({ expenses: [expense], entries });
    const svc = new CardInvoiceSettlementService(prisma);

    // Pagamento da fatura que vence em julho/2026.
    const res = await svc.settleInvoice({
      tenantId: 't1', card: CARD, amountCents: 10000, paymentDate: d('2026-07-10'),
    });

    expect(res.settledParcelas).toBe(1);
    // Parcela 1 (10/jun) vence jul → vira PAGO. Demais permanecem.
    expect(entries.find((e) => e.id === 'c0')!.status).toBe('PAGO');
    expect(entries.find((e) => e.id === 'c1')!.status).toBe('PLANEJADO');
    // paidParcelas registra índice 0; despesa segue PLANEJADO (não tudo pago).
    expect(expense.paidParcelas).toBe(JSON.stringify([0]));
    expect(expense.status).toBe('PLANEJADO');
  });

  it('due-month: à vista no cartão vira PAGO quando a fatura vence no mês', async () => {
    const expense = {
      id: 'e2', tenantId: 't1', cardLast4: '5868', tipoDespesa: 'ALIMENTACAO',
      formaPagamento: 'A_VISTA', quantidadeParcela: null, status: 'PLANEJADO',
      paidParcelas: null, deletedAt: null, importId: 'imp1',
    };
    const entries = [
      { id: 'a0', expenseId: 'e2', status: 'PLANEJADO', parcela: null, data: d('2026-06-15'), deletedAt: null },
    ];
    const prisma = makePrisma({ expenses: [expense], entries });
    const svc = new CardInvoiceSettlementService(prisma);

    const res = await svc.settleInvoice({
      tenantId: 't1', card: CARD, amountCents: 5000, paymentDate: d('2026-07-10'),
    });

    expect(res.settledParcelas).toBe(1);
    expect(entries[0].status).toBe('PAGO');
    expect(expense.status).toBe('PAGO');
  });

  it('marca despesa inteira PAGO quando todas as parcelas são liquidadas', async () => {
    const expense = {
      id: 'e3', tenantId: 't1', cardLast4: '5868', tipoDespesa: 'OUTROS',
      formaPagamento: 'PARCELADO', quantidadeParcela: 2, status: 'PLANEJADO',
      paidParcelas: JSON.stringify([0]), deletedAt: null, importId: 'imp1',
    };
    const entries = [
      { id: 'p0', expenseId: 'e3', status: 'PAGO', parcela: '1/2', data: d('2026-06-10'), deletedAt: null },
      { id: 'p1', expenseId: 'e3', status: 'PLANEJADO', parcela: '2/2', data: d('2026-07-10'), deletedAt: null },
    ];
    const prisma = makePrisma({ expenses: [expense], entries });
    const svc = new CardInvoiceSettlementService(prisma);

    const res = await svc.settleInvoice({
      tenantId: 't1', card: CARD, amountCents: 8000, paymentDate: d('2026-08-10'),
    });

    expect(res.settledParcelas).toBe(1);
    expect(entries.find((e) => e.id === 'p1')!.status).toBe('PAGO');
    expect(expense.status).toBe('PAGO');
    expect(expense.paidParcelas).toBeNull();
  });

  it('fallback import-total: sem closing/due, casa pela fatura importada', async () => {
    const card = { id: 'card1', last4: '5868', closingDay: null, dueDay: null };
    const expense = {
      id: 'e4', tenantId: 't1', cardLast4: '5868', tipoDespesa: 'OUTROS',
      formaPagamento: 'PARCELADO', quantidadeParcela: 3, status: 'PLANEJADO',
      paidParcelas: null, deletedAt: null, importId: 'imp9',
    };
    const entries = [
      { id: 'f0', expenseId: 'e4', status: 'PLANEJADO', parcela: '1/3', data: d('2026-06-10'), deletedAt: null },
      { id: 'f1', expenseId: 'e4', status: 'PLANEJADO', parcela: '2/3', data: d('2026-07-10'), deletedAt: null },
    ];
    const imports = [
      { id: 'imp9', cardId: 'card1', tenantId: 't1', totalAmountCents: 48489, deletedAt: null, createdAt: d('2026-06-12') },
    ];
    const prisma = makePrisma({ expenses: [expense], entries, imports });
    const svc = new CardInvoiceSettlementService(prisma);

    const res = await svc.settleInvoice({
      tenantId: 't1', card, amountCents: 48489, paymentDate: d('2026-07-10'),
    });

    // Sem due-day: cai no import-total e liquida a parcela mais antiga em aberto.
    expect(res.settledParcelas).toBe(1);
    expect(entries.find((e) => e.id === 'f0')!.status).toBe('PAGO');
    expect(expense.paidParcelas).toBe(JSON.stringify([0]));
  });

  it('não liquida nada quando nenhuma fatura vence no mês e não há import casado', async () => {
    const expense = {
      id: 'e5', tenantId: 't1', cardLast4: '5868', tipoDespesa: 'OUTROS',
      formaPagamento: 'PARCELADO', quantidadeParcela: 3, status: 'PLANEJADO',
      paidParcelas: null, deletedAt: null, importId: 'imp1',
    };
    const entries = [
      { id: 'n0', expenseId: 'e5', status: 'PLANEJADO', parcela: '1/3', data: d('2026-06-10'), deletedAt: null },
    ];
    const prisma = makePrisma({ expenses: [expense], entries, imports: [] });
    const svc = new CardInvoiceSettlementService(prisma);

    const res = await svc.settleInvoice({
      tenantId: 't1', card: CARD, amountCents: 99999, paymentDate: d('2026-12-10'),
    });

    expect(res.settledParcelas).toBe(0);
    expect(entries[0].status).toBe('PLANEJADO');
  });
});
