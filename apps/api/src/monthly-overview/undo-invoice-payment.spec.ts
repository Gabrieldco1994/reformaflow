import { Test, TestingModule } from '@nestjs/testing';
import { MonthlyOverviewService } from './monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';

/**
 * Fixture: prisma "vivo" o suficiente para exercitar o round-trip real
 * payInvoice -> settleInvoice -> undoInvoicePayment -> unsettleInvoice, sem
 * tocar banco (testes deste repo mockam o Prisma — ver
 * monthly-overview.account-view.spec.ts / conciliacao.service.spec.ts).
 *
 * Também cobre TODAS as queries de `getAccountView` (bankAccount/expense/
 * receipt/cashFlowEntry/creditCard/crossProjectSettlement/rateioAllocation/
 * invoiceAdjustment/bankStatementImport), para que o round-trip possa ser
 * comparado nos AGREGADOS derivados, não só no estado persistido.
 */

/** Modelos com `deletedAt` — o middleware `$use` real injeta `deletedAt: null`
 *  quando a query não o define. `CrossProjectSettlement`/`RateioAllocation`
 *  ficam de fora (ver `modelsWithoutSoftDelete` em prisma.service.ts). */
const SOFT_DELETE_MODELS = new Set([
  'project',
  'bankAccount',
  'creditCard',
  'expense',
  'receipt',
  'cashFlowEntry',
  'invoiceAdjustment',
  'bankStatementImport',
]);

function buildPrisma(seed: {
  tenantId: string;
  projectId: string;
  card: { id: string; last4: string; nickname: string; closingDay: number | null; dueDay: number | null };
  account: { last4: string };
  expenses: any[];
  entries: any[];
  receipts?: any[];
  cards?: any[];
  accounts?: any[];
}) {
  const { tenantId, projectId, card, account, expenses, entries } = seed;
  const receipts = seed.receipts ?? [];
  const cards = seed.cards ?? [card];
  const accounts = seed.accounts ?? [account];
  let nextId = 1;

  function matchField(value: any, condition: any): boolean {
    if (condition === null) return value === null || value === undefined;
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('not' in condition) return !matchField(value, condition.not);
      if ('notIn' in condition) return !condition.notIn.includes(value);
      if ('in' in condition) return condition.in.includes(value);
      if ('gte' in condition) return value != null && value >= condition.gte;
      if ('lt' in condition) return value != null && value < condition.lt;
    }
    if (value instanceof Date && condition instanceof Date) {
      return value.getTime() === condition.getTime();
    }
    return value === condition;
  }

  function matchWhere(record: any, where: any): boolean {
    for (const key of Object.keys(where)) {
      const condition = where[key];
      if (key === 'AND') {
        const clauses = Array.isArray(condition) ? condition : [condition];
        if (!clauses.every((clause: any) => matchWhere(record, clause))) return false;
        continue;
      }
      if (key === 'OR') {
        const clauses = Array.isArray(condition) ? condition : [condition];
        if (!clauses.some((clause: any) => matchWhere(record, clause))) return false;
        continue;
      }
      if (key === 'NOT') {
        if (matchWhere(record, condition)) return false;
        continue;
      }
      if (key === 'expense' || key === 'receipt') {
        const pool = key === 'expense' ? expenses : receipts;
        const fk = key === 'expense' ? record.expenseId : record.receiptId;
        const related = fk == null ? null : pool.find((row: any) => row.id === fk) ?? null;
        if (condition === null) {
          if (related) return false;
          continue;
        }
        if (!related || !matchWhere(related, condition)) return false;
        continue;
      }
      if (!matchField(record[key], condition)) return false;
    }
    return true;
  }

  function applyOrderBy(rows: any[], orderBy: any): any[] {
    if (!orderBy) return rows;
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((clause: any) =>
      Object.entries(clause),
    ) as Array<[string, string]>;
    return [...rows].sort((a, b) => {
      for (const [field, dir] of specs) {
        const av = a[field];
        const bv = b[field];
        let cmp = 0;
        if (av == null && bv == null) cmp = 0;
        else if (av == null) cmp = -1;
        else if (bv == null) cmp = 1;
        else if (av instanceof Date && bv instanceof Date) cmp = av.getTime() - bv.getTime();
        else cmp = av < bv ? -1 : av > bv ? 1 : 0;
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }

  /** Espelha o middleware `$use`: sem `deletedAt` explícito, filtra soft-deleted. */
  function effectiveWhere(model: string, where: any) {
    const base = where ?? {};
    if (!SOFT_DELETE_MODELS.has(model)) return base;
    return base.deletedAt === undefined ? { ...base, deletedAt: null } : base;
  }

  function collection(model: string, rows: any[], hydrate: (row: any) => any = (row) => row) {
    return {
      findMany: jest.fn().mockImplementation((args: any = {}) => {
        const filtered = rows.filter((row) => matchWhere(row, effectiveWhere(model, args.where)));
        return Promise.resolve(applyOrderBy(filtered, args.orderBy).map(hydrate));
      }),
      findFirst: jest.fn().mockImplementation((args: any = {}) => {
        const filtered = rows.filter((row) => matchWhere(row, effectiveWhere(model, args.where)));
        const ordered = applyOrderBy(filtered, args.orderBy);
        return Promise.resolve(ordered.length > 0 ? hydrate(ordered[0]) : null);
      }),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const found = rows.find((row) => row.id === where.id);
        if (found) Object.assign(found, data);
        return Promise.resolve(found ?? null);
      }),
      // B1b (#448): o soft-delete do pagamento virou `updateMany` CONDICIONAL
      // (id + tenant + projeto + tipo + `deletedAt: null`) para fechar o TOCTOU
      // entre ler a despesa e apagá-la; `count` é o que o service checa.
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        const matched = rows.filter((row) => matchWhere(row, effectiveWhere(model, where)));
        for (const row of matched) Object.assign(row, data);
        return Promise.resolve({ count: matched.length });
      }),
    };
  }

  function withRelations(entry: any) {
    return {
      ...entry,
      expense: expenses.find((e) => e.id === entry.expenseId) ?? null,
      receipt: receipts.find((r: any) => r.id === entry.receiptId) ?? null,
    };
  }

  const withProject = (row: any) => ({
    ...row,
    project: {
      id: row.projectId,
      tenantId,
      type: 'PESSOAL',
      deletedAt: null,
    },
  });
  const expenseCollection = collection('expense', expenses, withProject);

  const prisma: any = {
    project: {
      findFirst: jest.fn().mockResolvedValue({ id: projectId, tenantId, type: 'PESSOAL', deletedAt: null }),
      findMany: jest.fn().mockResolvedValue([{ id: projectId, name: 'Pessoal', type: 'PESSOAL' }]),
    },
    creditCard: collection('creditCard', cards, withProject),
    bankAccount: collection('bankAccount', accounts),
    expense: {
      ...expenseCollection,
      create: jest.fn().mockImplementation(({ data }: any) => {
        const created = { id: `payment-${nextId++}`, deletedAt: null, settlesInvoiceKey: null, ...data };
        expenses.push(created);
        return Promise.resolve(created);
      }),
    },
    receipt: collection('receipt', receipts),
    cashFlowEntry: collection('cashFlowEntry', entries, withRelations),
    crossProjectSettlement: { findMany: jest.fn().mockResolvedValue([]) },
    rateioAllocation: { findMany: jest.fn().mockResolvedValue([]) },
    invoiceAdjustment: {
      ...collection('invoiceAdjustment', []),
      create: jest.fn(),
      delete: jest.fn(),
    },
    bankStatementImport: collection('bankStatementImport', []),
    $transaction: jest.fn().mockImplementation((cb: any) => cb(prisma)),
  };

  return prisma;
}

function d(iso: string) {
  return new Date(`${iso}T00:00:00.000Z`);
}

describe('MonthlyOverviewService.undoInvoicePayment', () => {
  // #447: as mutações de fatura exigem requester identificado (argumento
  // obrigatório); acesso total é DECLARADO pelo papel, nunca por omissão.
  const requester = { id: 'user-1', role: 'ADMIN' };
  const tenantId = 'tenant-1';
  const projectId = 'pessoal-1';
  const card = {
    id: 'card-1',
    tenantId,
    projectId,
    last4: '1234',
    nickname: 'Nubank',
    closingDay: 10,
    dueDay: 20,
    limitTotalCents: 200_000,
    limitAvailableCents: 187_000,
    createdAt: d('2025-01-01'),
    deletedAt: null,
  };
  const account = {
    id: 'acc-1',
    tenantId,
    projectId,
    last4: '9999',
    nickname: 'Conta Corrente',
    institution: 'Banco Teste',
    openingBalanceCents: 100_000,
    openingBalanceDate: d('2025-12-31'),
    deletedAt: null,
  };
  const project = { id: projectId, name: 'Pessoal', type: 'PESSOAL' };

  // Isolamento: o teste de agregados fixa o relógio; nenhum outro teste do
  // arquivo pode herdar fake timers.
  afterEach(() => {
    jest.useRealTimers();
  });

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
        project,
        tipoDespesa: 'ALIMENTACAO',
        titulo: 'Mercado parcelado',
        fornecedor: 'Mercado',
        valor: 5_000,
        valorTotal: 10_000,
        cardLast4: '1234',
        bankLast4: null,
        formaPagamento: 'PARCELADO',
        quantidadeParcela: 2,
        dataPagamento: null,
        dataInicioParcela: d('2026-05-05'),
        createdAt: d('2026-05-05'),
        importId: null,
        linkedExpenseId: null,
        settledByExpenseId: null,
        status: 'PLANEJADO',
        paidParcelas: null,
        settlesInvoiceKey: null,
        deletedAt: null,
      },
      {
        id: 'exp-b',
        tenantId,
        projectId,
        project,
        tipoDespesa: 'LAZER',
        titulo: 'Cinema',
        fornecedor: 'Cinemark',
        valor: 3_000,
        valorTotal: 3_000,
        cardLast4: '1234',
        bankLast4: null,
        formaPagamento: 'A_VISTA',
        quantidadeParcela: null,
        dataPagamento: null,
        dataInicioParcela: null,
        createdAt: d('2026-05-08'),
        importId: null,
        linkedExpenseId: null,
        settledByExpenseId: null,
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
      { id: 'a1', expenseId: 'exp-a', receiptId: null, tenantId, projectId, tipo: 'DESPESA', status: 'PLANEJADO', categoria: 'ALIMENTACAO', subcategoria: null, formaPagamento: 'CARTAO_CREDITO', parcela: '1/2', data: d('2026-05-05'), createdAt: d('2026-05-05'), valor: 5_000, deletedAt: null },
      // dueMonth 2026-06
      { id: 'a2', expenseId: 'exp-a', receiptId: null, tenantId, projectId, tipo: 'DESPESA', status: 'PLANEJADO', categoria: 'ALIMENTACAO', subcategoria: null, formaPagamento: 'CARTAO_CREDITO', parcela: '2/2', data: d('2026-06-05'), createdAt: d('2026-05-05'), valor: 5_000, deletedAt: null },
      // dueMonth 2026-05
      { id: 'b1', expenseId: 'exp-b', receiptId: null, tenantId, projectId, tipo: 'DESPESA', status: 'PLANEJADO', categoria: 'LAZER', subcategoria: null, formaPagamento: 'CARTAO_CREDITO', parcela: null, data: d('2026-05-08'), createdAt: d('2026-05-08'), valor: 3_000, deletedAt: null },
    ];
  }

  function baseReceipts(): any[] {
    return [
      {
        id: 'rec-salario',
        tenantId,
        projectId,
        valor: 20_000,
        data: d('2026-05-02'),
        tipo: 'SALARIO',
        descricao: 'Salario',
        status: 'EM_CAIXA',
        bankLast4: '9999',
        importId: null,
        deletedAt: null,
      },
      {
        id: 'rec-previsto',
        tenantId,
        projectId,
        valor: 4_000,
        data: d('2026-05-28'),
        tipo: 'REEMBOLSO',
        descricao: 'Reembolso',
        status: 'PREVISTO',
        bankLast4: '9999',
        importId: null,
        deletedAt: null,
      },
    ];
  }

  /**
   * Snapshot do estado PERSISTIDO. Inclui TODOS os campos que pay/settle/undo
   * podem tocar — não só `status`/`paidParcelas` — para que um efeito colateral
   * fora desses dois campos (ex.: `dataPagamento` deixado para trás) não passe
   * despercebido.
   */
  function snapshot(expenses: any[], entries: any[]) {
    return {
      expenses: expenses.map((e) => ({
        id: e.id,
        status: e.status,
        paidParcelas: e.paidParcelas,
        dataPagamento: e.dataPagamento ?? null,
        settlesInvoiceKey: e.settlesInvoiceKey ?? null,
        settledByExpenseId: e.settledByExpenseId ?? null,
        valorTotal: e.valorTotal,
        deletedAt: e.deletedAt,
      })),
      entries: entries.map((en) => ({
        id: en.id,
        status: en.status,
        valor: en.valor,
        data: en.data,
        deletedAt: en.deletedAt,
      })),
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
      requester,
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

    const undo = await service.undoInvoicePayment(
      tenantId,
      projectId,
      { cardLast4: '1234', dueMonth: '2026-05' },
      requester,
    );

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

  it('desfaz com sucesso o pagamento do MÊS SEGUINTE quando o cartão tem pagamentos em dois meses consecutivos', async () => {
    // Reproduz o bug de produção: `undoInvoicePayment` montava a lista de
    // faturas com UM elemento só (a fatura-alvo). Sem a fatura de maio como
    // concorrente, `assignImplicitPayments` empurrava o pagamento de maio
    // (janela [05, 06]) para a única fatura da lista (06), inflando a
    // contagem de casamentos para 2 e disparando o 400 de ambiguidade — no
    // fluxo NORMAL de duas faturas seguidas pagas, não no excepcional.
    const expenses = baseExpenses();
    const entries = baseEntries();
    const prisma = buildPrisma({ tenantId, projectId, card, account, expenses, entries });
    const service = await buildService(prisma);

    const payMay = await service.payInvoice(
      tenantId,
      projectId,
      {
        cardLast4: '1234',
        month: '2026-05',
        amountCents: 8_000, // a1 (5000) + b1 (3000)
        bankLast4: '9999',
        paymentDate: '2026-05-25T00:00:00.000Z',
      },
      requester,
    );
    expect(payMay.ok).toBe(true);

    const payJune = await service.payInvoice(
      tenantId,
      projectId,
      {
        cardLast4: '1234',
        month: '2026-06',
        amountCents: 5_000, // a2
        bankLast4: '9999',
        paymentDate: '2026-06-20T00:00:00.000Z',
      },
      requester,
    );
    expect(payJune.ok).toBe(true);
    expect(entries.find((e) => e.id === 'a2')?.status).toBe('PAGO');

    const undo = await service.undoInvoicePayment(
      tenantId,
      projectId,
      { cardLast4: '1234', dueMonth: '2026-06' },
      requester,
    );

    expect(undo).toMatchObject({
      ok: true,
      undonePaymentExpenseId: payJune.paymentExpenseId,
      cardLast4: '1234',
      dueMonth: '2026-06',
      revertedExpenses: 1,
      revertedParcelas: 1,
    });

    // Só a fatura de junho foi desfeita — maio continua liquidado.
    expect(entries.find((e) => e.id === 'a2')?.status).toBe('PLANEJADO');
    expect(entries.find((e) => e.id === 'a1')?.status).toBe('PAGO');
    expect(entries.find((e) => e.id === 'b1')?.status).toBe('PAGO');
    const mayPaymentRow = expenses.find((e) => e.id === payMay.paymentExpenseId);
    expect(mayPaymentRow?.deletedAt).toBeNull();
    const junePaymentRow = expenses.find((e) => e.id === payJune.paymentExpenseId);
    expect(junePaymentRow?.deletedAt).not.toBeNull();
  });

  it('recusa com 400 quando há mais de um pagamento casado com a mesma fatura, sem mutar nada', async () => {
    // Fatura ISOLADA de propósito (cartão sem nenhuma compra em outro mês): a
    // ambiguidade real é "2 pagamentos pra 1 fatura", não um efeito colateral
    // de uma fatura concorrente absorvendo um deles.
    const expenses = [
      {
        id: 'exp-a',
        tenantId,
        projectId,
        project,
        tipoDespesa: 'ALIMENTACAO',
        titulo: 'Mercado',
        fornecedor: 'Mercado',
        valor: 5_000,
        valorTotal: 5_000,
        cardLast4: '1234',
        bankLast4: null,
        formaPagamento: 'A_VISTA',
        quantidadeParcela: null,
        dataPagamento: null,
        dataInicioParcela: null,
        createdAt: d('2026-05-05'),
        importId: null,
        linkedExpenseId: null,
        settledByExpenseId: null,
        status: 'PAGO',
        paidParcelas: null,
        settlesInvoiceKey: null,
        deletedAt: null,
      },
      {
        id: 'exp-b',
        tenantId,
        projectId,
        project,
        tipoDespesa: 'LAZER',
        titulo: 'Cinema',
        fornecedor: 'Cinemark',
        valor: 3_000,
        valorTotal: 3_000,
        cardLast4: '1234',
        bankLast4: null,
        formaPagamento: 'A_VISTA',
        quantidadeParcela: null,
        dataPagamento: null,
        dataInicioParcela: null,
        createdAt: d('2026-05-08'),
        importId: null,
        linkedExpenseId: null,
        settledByExpenseId: null,
        status: 'PAGO',
        paidParcelas: null,
        settlesInvoiceKey: null,
        deletedAt: null,
      },
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
    ];
    const entries = [
      { id: 'a1', expenseId: 'exp-a', receiptId: null, tenantId, projectId, tipo: 'DESPESA', status: 'PAGO', categoria: 'ALIMENTACAO', subcategoria: null, formaPagamento: 'CARTAO_CREDITO', parcela: null, data: d('2026-05-05'), createdAt: d('2026-05-05'), valor: 5_000, deletedAt: null },
      { id: 'b1', expenseId: 'exp-b', receiptId: null, tenantId, projectId, tipo: 'DESPESA', status: 'PAGO', categoria: 'LAZER', subcategoria: null, formaPagamento: 'CARTAO_CREDITO', parcela: null, data: d('2026-05-08'), createdAt: d('2026-05-08'), valor: 3_000, deletedAt: null },
    ];
    const prisma = buildPrisma({ tenantId, projectId, card, account, expenses, entries });
    const service = await buildService(prisma);

    const before = JSON.parse(JSON.stringify({ expenses, entries }));

    const rejection = await service
      .undoInvoicePayment(tenantId, projectId, { cardLast4: '1234', dueMonth: '2026-05' }, requester)
      .then(() => null, (err) => err);
    expect(rejection).not.toBeNull();
    expect(rejection.message).toContain('Há mais de um pagamento');
    // Melhoria pedida no hotfix: o 400 devolve QUAIS pagamentos foram casados
    // (id, valor, data) — sem isso a UI não tem como o usuário reconhecer
    // "cliquei duas vezes" / "veio do import" e agir manualmente.
    const responsePayments = rejection.getResponse().payments;
    expect(responsePayments).toHaveLength(2);
    expect(responsePayments.map((p: any) => p.id).sort()).toEqual(['pay-1', 'pay-2']);
    expect(responsePayments.find((p: any) => p.id === 'pay-1')).toMatchObject({
      amountCents: 5_000,
      data: '2026-05-20T00:00:00.000Z',
    });

    expect(JSON.parse(JSON.stringify({ expenses, entries }))).toEqual(before);
  });

  it('#569: pagamento de fatura IMPORTADO não é desfazível pelo cockpit — 404 e o verbo undo não aparece', async () => {
    const expenses = [
      {
        id: 'exp-a',
        tenantId,
        projectId,
        project,
        tipoDespesa: 'ALIMENTACAO',
        titulo: 'Mercado',
        fornecedor: 'Mercado',
        valor: 5_000,
        valorTotal: 5_000,
        cardLast4: '1234',
        bankLast4: null,
        formaPagamento: 'A_VISTA',
        quantidadeParcela: null,
        dataPagamento: null,
        dataInicioParcela: null,
        createdAt: d('2026-05-05'),
        importId: 'imp-extrato-1',
        linkedExpenseId: null,
        settledByExpenseId: null,
        status: 'PAGO',
        paidParcelas: null,
        settlesInvoiceKey: null,
        deletedAt: null,
      },
      {
        id: 'pay-import',
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
        // criado pela importação de extrato — só `BankAccountService.undoImport` remove.
        importId: 'imp-extrato-1',
        valorTotal: 5_000,
        dataPagamento: d('2026-05-20'),
        createdAt: d('2026-05-20'),
        deletedAt: null,
      },
    ];
    const entries = [
      { id: 'a1', expenseId: 'exp-a', receiptId: null, tenantId, projectId, tipo: 'DESPESA', status: 'PAGO', categoria: 'ALIMENTACAO', subcategoria: null, formaPagamento: 'CARTAO_CREDITO', parcela: null, data: d('2026-05-05'), createdAt: d('2026-05-05'), valor: 5_000, deletedAt: null },
    ];
    const prisma = buildPrisma({ tenantId, projectId, card, account, expenses, entries });
    const service = await buildService(prisma);

    await expect(
      service.undoInvoicePayment(tenantId, projectId, { cardLast4: '1234', dueMonth: '2026-05' }, requester),
    ).rejects.toThrow('Nenhum pagamento encontrado');

    // A fatura continua contando como PAGA — o pagamento importado abate.
    const view: any = await service.getAccountView(tenantId, projectId, '2026-05');
    const cartao = view.cartoes.find((c: any) => c.last4 === '1234');
    expect(cartao.status).toBe('paga');
    expect(cartao.actions ?? []).not.toContain('undo');

    // Nada foi mutado.
    expect(expenses.find((e) => e.id === 'pay-import')?.deletedAt).toBeNull();
  });

  it('recusa com 404 quando não há pagamento casado com a fatura', async () => {
    const expenses = baseExpenses();
    const entries = baseEntries();
    const prisma = buildPrisma({ tenantId, projectId, card, account, expenses, entries });
    const service = await buildService(prisma);

    await expect(
      service.undoInvoicePayment(tenantId, projectId, { cardLast4: '1234', dueMonth: '2026-05' }, requester),
    ).rejects.toThrow('Nenhum pagamento encontrado');
  });

  /**
   * Requisito CENTRAL do PO: pagar → desfazer tem que deixar a Visão Conta
   * IDÊNTICA, não "parecida". O round-trip acima prova só o estado PERSISTIDO
   * (expenses + cashFlowEntry); aqui provamos os AGREGADOS DERIVADOS —
   * caixaHoje, carteiraHoje, saiuMes, faltaPagarMes, sobraPrevista,
   * devoCartaoTotal, cartoes[] (fatura/status) e as listas
   * saidas/comprasCartao/entradas — via deep-equal do payload inteiro.
   */
  it('round-trip: pagar+desfazer preserva TODOS os agregados de getAccountView (deep-equal)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T12:00:00.000Z'));

    const expenses = baseExpenses();
    const entries = baseEntries();
    const receipts = baseReceipts();
    const prisma = buildPrisma({ tenantId, projectId, card, account, expenses, entries, receipts });
    const service = await buildService(prisma);

    // (1) Snapshot A — antes de qualquer pagamento.
    const antes: any = await service.getAccountView(tenantId, projectId, '2026-05');

    // Guarda-de-vacuidade: o snapshot precisa ter substância, senão o
    // deep-equal final passaria comparando dois objetos vazios.
    expect(antes.mesSelecionado).toBe('2026-05');
    expect(antes.caixaHoje).toBe(120_000); // 100.000 abertura + 20.000 salário EM_CAIXA
    expect(antes.devoCartaoTotal).toBe(13_000); // fatura 05 (8.000) + fatura 06 (5.000)
    expect(antes.cartoes).toHaveLength(1);
    expect(antes.cartoes[0]).toMatchObject({
      last4: '1234',
      faturaAtual: 8_000,
      faturaPendente: 8_000,
      faturaPaga: 0,
      status: 'a pagar',
    });
    expect(antes.entradas.map((e: any) => e.id)).toEqual(['rec-previsto', 'rec-salario']);
    expect(antes.comprasCartao.length).toBeGreaterThan(0);

    // (2) payInvoice — mesma fixture/payload do round-trip persistido acima.
    const pay = await service.payInvoice(
      tenantId,
      projectId,
      {
        cardLast4: '1234',
        month: '2026-05',
        amountCents: 8_000,
        bankLast4: '9999',
        paymentDate: '2026-05-25T00:00:00.000Z',
      },
      requester,
    );
    expect(pay.ok).toBe(true);
    expect(pay.settledParcelas).toBe(2);

    // Estado INTERMEDIÁRIO precisa de fato divergir — sem isto o deep-equal
    // final seria vacuously true (o pagamento poderia não ter mexido em nada).
    const durante: any = await service.getAccountView(tenantId, projectId, '2026-05');
    expect(durante).not.toEqual(antes);
    expect(durante.caixaHoje).toBe(antes.caixaHoje - 8_000);
    expect(durante.devoCartaoTotal).toBe(antes.devoCartaoTotal - 8_000);
    expect(durante.cartoes[0]).toMatchObject({
      faturaPendente: 0,
      faturaPaga: 8_000,
      status: 'paga',
    });

    // (3) undoInvoicePayment.
    const undo = await service.undoInvoicePayment(
      tenantId,
      projectId,
      { cardLast4: '1234', dueMonth: '2026-05' },
      requester,
    );
    expect(undo).toMatchObject({ ok: true, undonePaymentExpenseId: pay.paymentExpenseId });

    // (4) Snapshot B.
    const depois: any = await service.getAccountView(tenantId, projectId, '2026-05');

    // (5) Igualdade PROFUNDA do payload inteiro. Campos abaixo são asserções
    // redundantes de propósito: se o deep-equal quebrar, elas apontam ONDE.
    expect(depois.caixaHoje).toBe(antes.caixaHoje);
    expect(depois.carteiraHoje).toBe(antes.carteiraHoje);
    expect(depois.entrouMes).toBe(antes.entrouMes);
    expect(depois.saiuMes).toBe(antes.saiuMes);
    expect(depois.faltaPagarMes).toBe(antes.faltaPagarMes);
    expect(depois.recebimentosPrevistosMes).toBe(antes.recebimentosPrevistosMes);
    expect(depois.sobraPrevista).toBe(antes.sobraPrevista);
    expect(depois.devoCartaoTotal).toBe(antes.devoCartaoTotal);
    expect(depois.cartoes).toEqual(antes.cartoes);
    expect(depois.contas).toEqual(antes.contas);
    expect(depois.saidas).toEqual(antes.saidas);
    expect(depois.comprasCartao).toEqual(antes.comprasCartao);
    expect(depois.entradas).toEqual(antes.entradas);
    expect(depois.ticketMedio).toEqual(antes.ticketMedio);
    expect(depois).toEqual(antes);
  });
});
