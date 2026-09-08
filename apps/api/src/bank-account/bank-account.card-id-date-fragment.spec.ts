// A trava de banco precisa rodar antes de importar PrismaClient.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

/**
 * #573 M8 — REPRODUÇÃO (RED). `detectCardPayment` extrai o PRIMEIRO grupo de 4
 * dígitos como `last4`. Numa linha de extrato com competência ("PAGAMENTO
 * CARTAO CRED 08/2026") isso produz `last4 = "2026"`. Efeitos comprovados
 * abaixo, não presumidos:
 *   - unidade: texto de competência → last4 = "2026" (deveria ser null)
 *   - integração (Prisma real + banco descartável):
 *       texto recebido → last4 extraído → cartão escolhido → fatura liquidada
 *
 * Estes testes asseveram o CONTRATO desejado, portanto FALHAM contra o código
 * atual. Rodar com TZ=UTC (regra de ouro #22).
 */
import { PrismaClient } from '@prisma/client';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';
import { BankAccountService, detectCardPayment } from './bank-account.service';
import type { RateioRequester } from '../expense/rateio.types';

// ─────────────────────────────────────────────────────────────────────────────
// PARTE 1 — unidade: a extração de last4
// ─────────────────────────────────────────────────────────────────────────────
describe('#573 M8 · detectCardPayment.last4 — competência não identifica cartão', () => {
  it.each([
    // [texto, isCardPayment esperado, last4 esperado (contrato)]
    ['PAGAMENTO CARTAO CRED 08/2026', true, null],   // competência MM/AAAA
    ['PAGTO CARTAO 15/08/2026', true, null],         // data DD/MM/AAAA
    ['PAGTO CART CRED 2026-08', true, null],         // competência AAAA-MM
    ['PAGTO CART CRED 1234', true, '1234'],          // final explícito, mantém
    ['DEB AUT CART **** 5599', true, '5599'],        // final mascarado, mantém
    ['PAGTO CART CRED 2026', true, '2026'],          // final explícito 2026 (sem data), mantém
    ['PAGAMENTO CARTAO CRED 08.2026', true, null],   // competência MM.AAAA
  ])('detectCardPayment(%j) → {isCardPayment:%s, last4:%j}', (texto, isCP, last4) => {
    const r = detectCardPayment(texto as string);
    expect(r.isCardPayment).toBe(isCP);
    expect(r.last4).toBe(last4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PARTE 2 — integração: efeito persistido no caixa/fatura
// ─────────────────────────────────────────────────────────────────────────────
const setup = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'm8-tenant';
const PESSOAL = 'm8-pessoal';
const ACCOUNT_ID = 'm8-account';
const BANK_LAST4 = '1881';
const CARD_2026_ID = 'm8-card-2026';
const CARD_PAID_ID = 'm8-card-paid';
const CARD_PAID_LAST4 = '4242';
const CREATED_BY = 'm8-user';

// Relógio fixo — a janela de faturas candidatas depende do mês de pagamento.
const PURCHASE_DATE = new Date('2026-08-05T12:00:00.000Z');
const PAYMENT_DATE = new Date('2026-09-12T00:00:00.000Z');

const REQUESTER: RateioRequester = {
  role: 'USER',
  allowedProjects: [PESSOAL],
  allowedProjectTypes: ['PESSOAL'],
  allowedModules: ['expenses', 'creditCards'],
};

function ofxTransaction(dateYyyymmdd: string, amountCents: number, memo: string, fitId: string): string {
  const ofxAmount = (-amountCents / 100).toFixed(2); // débito de saída = negativo no OFX
  return [
    '<STMTTRN>',
    '<TRNTYPE>DEBIT</TRNTYPE>',
    `<DTPOSTED>${dateYyyymmdd}</DTPOSTED>`,
    `<TRNAMT>${ofxAmount}</TRNAMT>`,
    `<FITID>${fitId}</FITID>`,
    `<MEMO>${memo}</MEMO>`,
    '</STMTTRN>',
  ].join('');
}
function bankOfx(...txs: string[]): Buffer {
  return Buffer.from([
    'OFXHEADER:100', 'DATA:OFXSGML',
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>',
    `<BANKACCTFROM><ACCTID>${BANK_LAST4}</ACCTID></BANKACCTFROM>`,
    '<BANKTRANLIST>', ...txs, '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
  ].join('\n'));
}

async function createCard(id: string, last4: string, nickname: string) {
  return setup.creditCard.create({
    data: { id, last4, nickname, tenantId: TENANT, projectId: PESSOAL, institution: 'ITAU', brand: 'Visa', closingDay: 3, dueDay: 10 },
  });
}
async function createPurchaseOnCard(id: string, cardLast4: string, amountCents: number) {
  await setup.expense.create({
    data: {
      id, tenantId: TENANT, projectId: PESSOAL, tipoDespesa: 'OUTROS', titulo: id,
      valor: amountCents, quantidade: 1, valorTotal: amountCents, formaPagamento: 'A_VISTA',
      dataPagamento: PURCHASE_DATE, status: 'PLANEJADO', cardLast4,
      createdAt: PURCHASE_DATE, updatedAt: PURCHASE_DATE,
    },
  });
  await setup.cashFlowEntry.create({
    data: {
      id: `${id}-e`, tenantId: TENANT, projectId: PESSOAL, expenseId: id, valor: amountCents,
      tipo: 'DESPESA', data: PURCHASE_DATE, categoria: 'OUTROS', formaPagamento: 'CARTAO_CREDITO',
      status: 'PLANEJADO', createdAt: PURCHASE_DATE, updatedAt: PURCHASE_DATE,
    },
  });
}

async function cleanup() {
  for (const t of [TENANT]) {
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: t } });
    await setup.expense.deleteMany({ where: { tenantId: t } });
    await setup.receipt.deleteMany({ where: { tenantId: t } });
    await setup.bankStatementImport.deleteMany({ where: { tenantId: t } });
    await setup.creditCardStatementImport.deleteMany({ where: { tenantId: t } });
    await setup.creditCard.deleteMany({ where: { tenantId: t } });
    await setup.bankAccount.deleteMany({ where: { tenantId: t } });
    await setup.project.deleteMany({ where: { tenantId: t } });
    await setup.tenant.deleteMany({ where: { id: t } });
  }
}

let service: BankAccountService;

beforeAll(async () => {
  await setup.$connect();
  await prisma.onModuleInit();
  await cleanup();
  await setup.tenant.create({ data: { id: TENANT, name: 'M8' } });
  await setup.project.create({ data: { id: PESSOAL, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal' } });
  await setup.bankAccount.create({ data: { id: ACCOUNT_ID, tenantId: TENANT, projectId: PESSOAL, institution: 'ITAU', nickname: 'Conta', last4: BANK_LAST4 } });
  service = new BankAccountService(
    prisma,
    new MerchantClassifierService(prisma),
    new ConciliacaoService(prisma),
    new CardInvoiceSettlementService(prisma),
  );
});
afterAll(async () => {
  await cleanup();
  await prisma.onModuleDestroy();
  await setup.$disconnect();
});
afterEach(async () => {
  await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setup.expense.deleteMany({ where: { tenantId: TENANT } });
  await setup.receipt.deleteMany({ where: { tenantId: TENANT } });
  await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  await setup.creditCardStatementImport.deleteMany({ where: { tenantId: TENANT } });
  await setup.creditCard.deleteMany({ where: { tenantId: TENANT } });
});

async function commitStatement(ofx: Buffer) {
  return service.commitImport(
    TENANT, PESSOAL, ACCOUNT_ID, ofx, 'm8.ofx', 'OFX', '2026-09', undefined, undefined, CREATED_BY, REQUESTER,
  );
}
async function paymentExpense(importId: string) {
  return setup.expense.findFirst({
    where: { tenantId: TENANT, importId, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO' },
    select: { cardLast4: true, settlesInvoiceKey: true, titulo: true, valorTotal: true },
  });
}

describe('#573 M8 · extrato → identificação de cartão pela competência', () => {
  it('CENÁRIO A/prévia — "PAGAMENTO CARTAO CRED 08/2026" R$500: sugere o 4242 (match por valor), não o cartão final 2026', async () => {
    await createCard(CARD_PAID_ID, CARD_PAID_LAST4, 'Cartão Pago');
    await createPurchaseOnCard('m8-buy-4242', CARD_PAID_LAST4, 50_000);
    await createCard(CARD_2026_ID, '2026', 'Cartão Ano');
    await createPurchaseOnCard('m8-buy-2026', '2026', 30_000);

    const ofx = bankOfx(ofxTransaction('20260912', 50_000, 'PAGAMENTO CARTAO CRED 08/2026', 'M8A1'));
    const preview = await service.previewImport(TENANT, PESSOAL, ACCOUNT_ID, ofx, 'm8.ofx', 'OFX', undefined, REQUESTER);
    const row = preview.preview.find((p) => p.isCardPayment);

    expect(row?.suggestedCardLast4).toBe(CARD_PAID_LAST4);
  });

  it('CENÁRIO A/commit — mesmo lançamento: liquida a fatura do 4242 e NÃO a do cartão final 2026', async () => {
    await createCard(CARD_PAID_ID, CARD_PAID_LAST4, 'Cartão Pago');
    await createPurchaseOnCard('m8-buy-4242', CARD_PAID_LAST4, 50_000);
    await createCard(CARD_2026_ID, '2026', 'Cartão Ano');
    await createPurchaseOnCard('m8-buy-2026', '2026', 30_000);

    const ofx = bankOfx(ofxTransaction('20260912', 50_000, 'PAGAMENTO CARTAO CRED 08/2026', 'M8A2'));
    const commit = await commitStatement(ofx);

    const payment = await paymentExpense(commit.importId);
    expect(payment?.cardLast4).toBe(CARD_PAID_LAST4);

    // Compra do cartão "2026" continua planejada — a fatura errada não foi tocada.
    const buy2026 = await setup.expense.findUnique({ where: { id: 'm8-buy-2026' }, select: { status: true, settledByExpenseId: true } });
    expect(buy2026?.status).toBe('PLANEJADO');
    expect(buy2026?.settledByExpenseId).toBeNull();
  });

  it('CENÁRIO B — só existe o cartão 4242, pagamento R$123,45 (não casa nenhuma fatura): NÃO associa nem liquida', async () => {
    await createCard(CARD_PAID_ID, CARD_PAID_LAST4, 'Cartão Pago');
    await createPurchaseOnCard('m8-buy-4242', CARD_PAID_LAST4, 50_000);

    const ofx = bankOfx(ofxTransaction('20260912', 12_345, 'PAGAMENTO CARTAO CRED 08/2026', 'M8B1'));
    const commit = await commitStatement(ofx);

    const payment = await paymentExpense(commit.importId);
    // CONTRATO: sem identificação confiável → cardLast4 null, nada liquidado.
    // (fallback "cards.length === 1" removido; competência não identifica.)
    expect(payment?.cardLast4).toBeNull();
    expect(payment?.settlesInvoiceKey).toBeNull();
    expect(commit).toEqual(expect.objectContaining({ cardPayments: 0, unlinkedCardPayments: 1 }));
  });

  it('CENÁRIO C — "PAGTO CART CRED 2026" (final explícito, sem data): identifica o cartão final 2026', async () => {
    await createCard(CARD_2026_ID, '2026', 'Cartão Ano');
    await createPurchaseOnCard('m8-buy-2026', '2026', 30_000);

    const ofx = bankOfx(ofxTransaction('20260912', 30_000, 'PAGTO CART CRED 2026', 'M8C1'));
    const commit = await commitStatement(ofx);

    const payment = await paymentExpense(commit.importId);
    expect(payment?.cardLast4).toBe('2026');
  });

  it('CENÁRIO D — zero cartões cadastrados: cria pagamento sem cartão, sem crash', async () => {
    const ofx = bankOfx(ofxTransaction('20260912', 40_000, 'PAGAMENTO CARTAO CRED 08/2026', 'M8D1'));
    const commit = await commitStatement(ofx);

    const payment = await paymentExpense(commit.importId);
    expect(payment).not.toBeNull();
    expect(payment?.cardLast4).toBeNull();
    expect(payment?.settlesInvoiceKey).toBeNull();
    expect(commit).toEqual(expect.objectContaining({ cardPayments: 0, unlinkedCardPayments: 1 }));
  });

  it('CENÁRIO E — escolha explícita do usuário (decisions.overrides.cardLast4) continua prioritária', async () => {
    await createCard(CARD_PAID_ID, CARD_PAID_LAST4, 'Cartão Pago');
    await createPurchaseOnCard('m8-buy-4242', CARD_PAID_LAST4, 50_000);
    await createCard(CARD_2026_ID, '2026', 'Cartão Ano');

    const ofx = bankOfx(ofxTransaction('20260912', 50_000, 'PAGAMENTO CARTAO CRED 08/2026', 'M8E1'));
    const preview = await service.previewImport(TENANT, PESSOAL, ACCOUNT_ID, ofx, 'm8.ofx', 'OFX', undefined, REQUESTER);
    const externalId = preview.preview.find((p) => p.isCardPayment)!.externalId;
    const commit = await service.commitImport(
      TENANT, PESSOAL, ACCOUNT_ID, ofx, 'm8.ofx', 'OFX', '2026-09',
      undefined,
      [{ externalId, action: 'create', overrides: { category: 'PAGAMENTO_FATURA_CARTAO', cardLast4: '2026' } }],
      CREATED_BY, REQUESTER,
    );
    const payment = await paymentExpense(commit.importId);
    expect(payment?.cardLast4).toBe('2026');
  });
});
