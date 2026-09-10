// The test DB guard must load before PrismaService imports PrismaClient.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  makeBankAccountService,
  makeMonthlyOverviewService,
  pessoalRequester,
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedInstallmentPurchase,
  seedPessoal,
  seedStatementImport,
  commitStatement,
  readExpenseRaw,
} from '../bank-account/__tests__/invoice-undo.fixtures';

/**
 * #569 — REGRESSÃO do modelo de leitura no EMPATE manual (design
 * `569-invoice-read-model-design.json`). Setembro e Outubro abertos, MESMO
 * valor, SEM importação: o pagamento manual de Outubro (mês selecionado) liquida
 * corretamente a parcela de Outubro no CFE, mas o `payInvoice` não persistia
 * NENHUMA identidade — a atribuição implícita (mais antiga / menor diff) do
 * leitor/undo escolhia Setembro. Leitor e undo divergiam da liquidação real.
 *
 * Corpo REAL: `PrismaService` (middleware `$use` ativo) + `getAccountView` +
 * `payInvoice` + `undoInvoicePayment` reais. Cada `it` estoura hoje (RED) e passa
 * após carimbar a identidade REALMENTE resolvida em `Expense.settlesInvoiceKey`.
 */

const TENANT = 'mii-569-tenant';
const PESSOAL = 'mii-569-pessoal';
const BANK_LAST4 = '9090';
const REQ = { ...pessoalRequester(PESSOAL), id: 'mii-569-user' } as never;

const setup = new PrismaClient();
const prisma = new PrismaService();

function invoiceRow(view: any, cardLast4: string, dueMonth: string) {
  return (view.saidas as any[]).find(
    (row) => row.isInvoice && row.cardLast4 === cardLast4 && row.dueMonth === dueMonth,
  );
}

describe('#569 — identidade REAL do pagamento manual de fatura (empate Set/Out)', () => {
  let bank: ReturnType<typeof makeBankAccountService>;
  let overview: ReturnType<typeof makeMonthlyOverviewService>;
  let accountId: string;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    bank = makeBankAccountService(prisma);
    overview = makeMonthlyOverviewService(prisma);
  });

  beforeEach(async () => {
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PESSOAL });
    ({ id: accountId } = await seedBankAccount(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: BANK_LAST4,
    }));
  });

  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.$disconnect?.();
    await setup.$disconnect();
  });

  // Empate Set/Out, ambos abertos, MESMO valor, cartão NOVO, sem import.
  async function seedTie(last4: string) {
    const card = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4,
      closingDay: 25,
      dueDay: 10,
      nickname: `QA ${last4}`,
    });
    // 2 parcelas de R$100: parcela 1 (05/08) → fatura 2026-09; parcela 2 (05/09) → 2026-10.
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: last4,
      parcelas: 2,
      valorCents: 10000,
      primeiraData: new Date('2026-08-05T00:00:00.000Z'),
    });
    return { card, purchase };
  }

  it('T1: paga Outubro no empate → só Outubro PAGO, identidade carimbada, Setembro segue pendente', async () => {
    const { card } = await seedTie('5555');

    const sepBefore = await overview.getAccountView(TENANT, PESSOAL, '2026-09', REQ);
    expect(invoiceRow(sepBefore, '5555', '2026-09')?.status).toBe('PLANEJADO');
    expect(sepBefore.caixaHoje).toBe(0);

    const pay = await overview.payInvoice(
      TENANT,
      PESSOAL,
      {
        cardId: card.id,
        cardLast4: '5555',
        month: '2026-10',
        amountCents: 10000,
        accountId,
        bankLast4: BANK_LAST4,
        paymentDate: '2026-09-05',
      },
      REQ,
    );
    expect(pay).toMatchObject({ ok: true, month: '2026-10', settledParcelas: 1 });

    // Identidade REALMENTE resolvida persistida no namespace reservado `m1`
    // (com o cardId ESTÁVEL), não `dto.month` cego nem chave legada de 2 partes.
    const payment = await readExpenseRaw(setup, pay.paymentExpenseId);
    expect(payment?.settlesInvoiceKey).toBe(`m1:${card.id}:5555:2026-10`);

    // Setembro: NÃO liquidado, ainda pagável.
    const sep = await overview.getAccountView(TENANT, PESSOAL, '2026-09', REQ);
    const sepInvoice = invoiceRow(sep, '5555', '2026-09');
    expect(sepInvoice?.status).toBe('PLANEJADO');
    expect(sepInvoice?.realizado).toBe(false);
    expect(sepInvoice?.actions).toContain('pay');
    expect(sepInvoice?.actions).not.toContain('undo');

    // Outubro: liquidado, com undo apontando para o pagamento manual carimbado.
    const oct = await overview.getAccountView(TENANT, PESSOAL, '2026-10', REQ);
    const octInvoice = invoiceRow(oct, '5555', '2026-10');
    expect(octInvoice?.status).toBe('PAGO');
    expect(octInvoice?.realizado).toBe(true);
    expect(octInvoice?.actions).toContain('undo');
    expect(octInvoice?.id).toBe(pay.paymentExpenseId);

    // Caixa: um único débito de R$100.
    expect(oct.caixaHoje).toBe(-10000);
  });

  it('T2: desfaz Outubro → só Outubro reabre, pagamento soft-deletado, Setembro intacto, caixa volta; 2º undo 404', async () => {
    const { card } = await seedTie('5555');
    const pay = await overview.payInvoice(
      TENANT,
      PESSOAL,
      {
        cardId: card.id,
        cardLast4: '5555',
        month: '2026-10',
        amountCents: 10000,
        accountId,
        bankLast4: BANK_LAST4,
        paymentDate: '2026-09-05',
      },
      REQ,
    );

    const undo = await overview.undoInvoicePayment(
      TENANT,
      PESSOAL,
      { cardId: card.id, cardLast4: '5555', dueMonth: '2026-10' },
      REQ,
    );
    expect(undo).toMatchObject({ ok: true, undonePaymentExpenseId: pay.paymentExpenseId, revertedParcelas: 1 });

    const payment = await readExpenseRaw(setup, pay.paymentExpenseId);
    expect(payment?.deletedAt).not.toBeNull();

    const oct = await overview.getAccountView(TENANT, PESSOAL, '2026-10', REQ);
    const octInvoice = invoiceRow(oct, '5555', '2026-10');
    expect(octInvoice?.status).toBe('PLANEJADO');
    expect(octInvoice?.actions).toContain('pay');
    expect(octInvoice?.actions).not.toContain('undo');
    expect(oct.caixaHoje).toBe(0);

    const sep = await overview.getAccountView(TENANT, PESSOAL, '2026-09', REQ);
    expect(invoiceRow(sep, '5555', '2026-09')?.status).toBe('PLANEJADO');

    // 2º undo do MESMO mês → 404 (UPDATE condicional na contagem do pagamento).
    await expect(
      overview.undoInvoicePayment(TENANT, PESSOAL, { cardId: card.id, cardLast4: '5555', dueMonth: '2026-10' }, REQ),
    ).rejects.toThrow(/Nenhum pagamento encontrado/);

    // Setembro nunca foi pago → undo de Setembro também 404, sem efeitos.
    await expect(
      overview.undoInvoicePayment(TENANT, PESSOAL, { cardId: card.id, cardLast4: '5555', dueMonth: '2026-09' }, REQ),
    ).rejects.toThrow(/Nenhum pagamento encontrado/);
  });

  it('T3: import Setembro + adiantamento manual Outubro → ambos pagos; manual Out undo OK, import Set undo bloqueado, ledger de Set idêntico', async () => {
    const { card: card6666, purchase } = await seedTie('6666');
    await seedStatementImport(setup, { tenantId: TENANT, accountId, id: 'mii-imp-sep' });

    // Import de extrato liquida Setembro (empate → mais antigo, sem mês selecionado).
    await commitStatement(bank, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: '6666',
      debitCents: 10000,
      date: '20260905',
      period: '2026-09',
      requester: REQ,
    });

    const sepParcelaId = purchase.entryIds[0];
    const sepLedgerBefore = await setup.cashFlowEntry.findUnique({ where: { id: sepParcelaId } });
    const importedPayment = (await setup.expense.findFirst({
      where: { tenantId: TENANT, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', importId: { not: null } },
    })) as any;
    expect(importedPayment).toBeTruthy();

    // Setembro já pago pelo import.
    const sepAfterImport = await overview.getAccountView(TENANT, PESSOAL, '2026-09', REQ);
    expect(invoiceRow(sepAfterImport, '6666', '2026-09')?.status).toBe('PAGO');

    // Adiantamento manual de Outubro.
    const pay = await overview.payInvoice(
      TENANT,
      PESSOAL,
      {
        cardLast4: '6666',
        month: '2026-10',
        amountCents: 10000,
        accountId,
        bankLast4: BANK_LAST4,
        paymentDate: '2026-09-20',
      },
      REQ,
    );
    expect(pay).toMatchObject({ ok: true, settledParcelas: 1 });
    const octPayment = await readExpenseRaw(setup, pay.paymentExpenseId);
    expect(octPayment?.settlesInvoiceKey).toBe(`m1:${card6666.id}:6666:2026-10`);
    // Pagamento MANUAL nunca carimba a trilha de importação.
    expect(octPayment?.invoiceUndoState ?? null).toBeNull();
    expect(octPayment?.importId ?? null).toBeNull();

    // Ambas as faturas pagas.
    const oct = await overview.getAccountView(TENANT, PESSOAL, '2026-10', REQ);
    expect(invoiceRow(oct, '6666', '2026-10')?.status).toBe('PAGO');
    const sep2 = await overview.getAccountView(TENANT, PESSOAL, '2026-09', REQ);
    expect(invoiceRow(sep2, '6666', '2026-09')?.status).toBe('PAGO');

    // Import de Setembro NÃO é desfazível pelo cockpit (só `undoImport`).
    await expect(
      overview.undoInvoicePayment(TENANT, PESSOAL, { cardLast4: '6666', dueMonth: '2026-09' }, REQ),
    ).rejects.toMatchObject({ status: expect.anything() });

    // Ledger de Setembro byte-idêntico (nem a compra manual nem o undo o tocaram).
    const sepLedgerAfter = await setup.cashFlowEntry.findUnique({ where: { id: sepParcelaId } });
    expect(sepLedgerAfter).toEqual(sepLedgerBefore);
    const importedAfter = await readExpenseRaw(setup, importedPayment.id);
    expect(importedAfter?.deletedAt).toBeNull();

    // Manual de Outubro É desfazível.
    const undo = await overview.undoInvoicePayment(
      TENANT,
      PESSOAL,
      { cardLast4: '6666', dueMonth: '2026-10' },
      REQ,
    );
    expect(undo).toMatchObject({ ok: true, undonePaymentExpenseId: pay.paymentExpenseId });

    // Setembro segue pago e intocado após o undo de Outubro.
    const sepFinal = await setup.cashFlowEntry.findUnique({ where: { id: sepParcelaId } });
    expect(sepFinal).toEqual(sepLedgerBefore);
  });

  it('T4: cartão-paga-cartão (settlesInvoiceKey mas sem conta) NÃO é desfazível pela rota manual', async () => {
    // Cobrança MOVIMENTACAO_INTERNA no cartão 7777 que quita a fatura de OUTRO cartão:
    // tem settlesInvoiceKey mas NÃO tem bankLast4 → fora do discriminador manual.
    await seedTie('7777');
    await setup.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: 'MOVIMENTACAO_INTERNA',
        titulo: 'Cartão paga cartão',
        valor: 10000,
        quantidade: 1,
        valorTotal: 10000,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
        cardLast4: '8888',
        bankLast4: null,
        settlesInvoiceKey: '7777:2026-10',
      },
    });

    await expect(
      overview.undoInvoicePayment(TENANT, PESSOAL, { cardLast4: '7777', dueMonth: '2026-10' }, REQ),
    ).rejects.toThrow(/Nenhum pagamento encontrado/);
  });

  it('T5: um pagamento manual carimbado + um implícito legado na MESMA fatura → 2 = ambíguo, sem CTA nem undo', async () => {
    const { card } = await seedTie('4444');
    // Pagamento manual REAL (carimba a identidade de Outubro).
    await overview.payInvoice(
      TENANT,
      PESSOAL,
      {
        cardId: card.id,
        cardLast4: '4444',
        month: '2026-10',
        amountCents: 10000,
        accountId,
        bankLast4: BANK_LAST4,
        paymentDate: '2026-09-05',
      },
      REQ,
    );
    // Pagamento implícito LEGADO (sem chave) na mesma fatura de Outubro.
    await setup.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        titulo: 'Pagamento legado',
        valor: 10000,
        quantidade: 1,
        valorTotal: 10000,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
        cardLast4: '4444',
        bankLast4: BANK_LAST4,
        dataPagamento: new Date('2026-10-05T00:00:00.000Z'),
        settlesInvoiceKey: null,
      },
    });

    const oct = await overview.getAccountView(TENANT, PESSOAL, '2026-10', REQ);
    const octInvoice = invoiceRow(oct, '4444', '2026-10');
    expect(octInvoice?.actions ?? []).not.toContain('undo');
    expect(octInvoice?.id ?? null).toBeNull();

    await expect(
      overview.undoInvoicePayment(TENANT, PESSOAL, { cardId: card.id, cardLast4: '4444', dueMonth: '2026-10' }, REQ),
    ).rejects.toThrow(/mais de um pagamento/);
  });

  it('T6: caso REVERSO — paga Setembro no empate → só Setembro PAGO, Outubro segue pendente, sem vazamento', async () => {
    const { card } = await seedTie('2020');
    const pay = await overview.payInvoice(
      TENANT,
      PESSOAL,
      {
        cardId: card.id,
        cardLast4: '2020',
        month: '2026-09',
        amountCents: 10000,
        accountId,
        bankLast4: BANK_LAST4,
        paymentDate: '2026-09-05',
      },
      REQ,
    );
    const payment = await readExpenseRaw(setup, pay.paymentExpenseId);
    expect(payment?.settlesInvoiceKey).toBe(`m1:${card.id}:2020:2026-09`);

    const sep = await overview.getAccountView(TENANT, PESSOAL, '2026-09', REQ);
    const sepInvoice = invoiceRow(sep, '2020', '2026-09');
    expect(sepInvoice?.status).toBe('PAGO');
    expect(sepInvoice?.actions).toContain('undo');
    expect(sepInvoice?.id).toBe(pay.paymentExpenseId);

    const oct = await overview.getAccountView(TENANT, PESSOAL, '2026-10', REQ);
    const octInvoice = invoiceRow(oct, '2020', '2026-10');
    expect(octInvoice?.status).toBe('PLANEJADO');
    expect(octInvoice?.actions).toContain('pay');
    expect(octInvoice?.actions).not.toContain('undo');
  });

  it('T7: colisão de last4 — undo com cardId A NÃO consome o pagamento do cartão B (chave m1 é card-bound)', async () => {
    // Dois cartões ATIVOS de MESMO last4 (dado legado): compra 5555 é compartilhada.
    const cardA = await setup.creditCard.create({
      data: { tenantId: TENANT, projectId: PESSOAL, institution: 'ITAU', brand: 'Visa', nickname: 'A', last4: '1212', closingDay: 25, dueDay: 10 },
    });
    const cardB = await setup.creditCard.create({
      data: { tenantId: TENANT, projectId: PESSOAL, institution: 'NUBANK', brand: 'MC', nickname: 'B', last4: '1212', closingDay: 25, dueDay: 10 },
    });
    await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: '1212', parcelas: 1, valorCents: 10000,
      primeiraData: new Date('2026-09-05T00:00:00.000Z'),
    });

    // Paga via cardId B → chave m1 com o id de B.
    const pay = await overview.payInvoice(
      TENANT, PESSOAL,
      { cardId: cardB.id, month: '2026-10', amountCents: 10000, accountId, bankLast4: BANK_LAST4, paymentDate: '2026-09-06' },
      REQ,
    );
    expect((await readExpenseRaw(setup, pay.paymentExpenseId))?.settlesInvoiceKey).toBe(`m1:${cardB.id}:1212:2026-10`);

    // Undo com cardId A (cartão ERRADO): NÃO casa a chave de B → 404, ZERO efeito.
    await expect(
      overview.undoInvoicePayment(TENANT, PESSOAL, { cardId: cardA.id, dueMonth: '2026-10' }, REQ),
    ).rejects.toThrow(/Nenhum pagamento encontrado/);
    expect((await readExpenseRaw(setup, pay.paymentExpenseId))?.deletedAt ?? null).toBeNull();

    // Undo com o cartão CORRETO (B) desfaz normalmente.
    const undo = await overview.undoInvoicePayment(TENANT, PESSOAL, { cardId: cardB.id, dueMonth: '2026-10' }, REQ);
    expect(undo).toMatchObject({ ok: true, undonePaymentExpenseId: pay.paymentExpenseId });
    expect((await readExpenseRaw(setup, pay.paymentExpenseId))?.deletedAt).not.toBeNull();
  });

  it('T8: pagamento que NÃO fecha uma fatura única → NENHUMA identidade forjada (chave nula)', async () => {
    const card = await seedCardWithClosingDue(setup, {
      tenantId: TENANT, projectId: PESSOAL, last4: '3030', closingDay: 25, dueDay: 10, nickname: 'multi',
    });
    // 2 parcelas (Set + Out) R$100 cada. Pagar R$200 não fecha NENHUMA das duas
    // faturas de R$100 (fora da tolerância) ⇒ nada é liquidado ⇒ sem identidade.
    await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: '3030', parcelas: 2, valorCents: 10000,
      primeiraData: new Date('2026-08-05T00:00:00.000Z'),
    });
    const pay = await overview.payInvoice(
      TENANT, PESSOAL,
      { cardId: card.id, month: '2026-10', amountCents: 20000, accountId, bankLast4: BANK_LAST4, paymentDate: '2026-09-05' },
      REQ,
    );
    expect(pay.settledParcelas).toBe(0);
    const payment = await readExpenseRaw(setup, pay.paymentExpenseId);
    expect(payment?.settlesInvoiceKey ?? null).toBeNull();
  });
});
