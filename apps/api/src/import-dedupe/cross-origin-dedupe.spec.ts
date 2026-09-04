// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

/**
 * #659 — RED spec (integração, Prisma REAL + test-db-env.cjs).
 *
 * Bug: os 3 canais de importação (Carteira/receipt, extrato/bank, fatura/card)
 * derivam `external_id` com um `seed` diferente por canal, então o mesmo arquivo
 * importado por 2 canais cria a transação 2× → dinheiro dobra no Caixa
 * consolidado. Ver docs/659-cross-origin-dedupe-design.md.
 *
 * Contra o baseline 19633f12 estes testes FALHAM em asserção (não em import):
 *   - o 2º import cross-origin NÃO reporta `duplicated`
 *   - `Σ (Expense.valorTotal ∪ Receipt.valor)` e a contagem de linhas DOBRAM
 *   - o preview não anexa `possibleDuplicate` nas linhas Tier B
 *
 * GREEN quando o implementer entregar Tier A (auto-skip: FITID / hash de bytes)
 * + Tier B (superfície `possibleDuplicate` + `decisions[].action='import'`).
 *
 * Rodar com TZ=UTC (regra de ouro #22):
 *   cd apps/api && TZ=UTC npx jest import-dedupe/cross-origin-dedupe
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptService } from '../receipt/receipt.service';
import { BankAccountService } from '../bank-account/bank-account.service';
import { CreditCardService } from '../credit-card/credit-card.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import type { RateioRequester } from '../expense/rateio.types';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'dedupe-659-tenant';
const OTHER_TENANT = 'dedupe-659-other-tenant';
const PROJ_A = 'dedupe-659-proj-a';
const PROJ_B = 'dedupe-659-proj-b';
const ACCOUNT_A = 'dedupe-659-account-a';
const CARD_A = 'dedupe-659-card-a';
const ACCOUNT_B = 'dedupe-659-account-b';

const REQ: RateioRequester = {
  role: 'USER',
  allowedProjects: [PROJ_A, PROJ_B],
  allowedProjectTypes: ['PESSOAL'],
  allowedModules: ['expenses', 'receipts', 'creditCards', 'bankAccounts'],
};

// OFX com FITID (Tier A1). Datas fixas — sem dependência de `now`.
const OFX_TWO_TXNS = [
  '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>',
  '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260415120000<TRNAMT>-42.90<FITID>FIT-659-0001<MEMO>PADARIA CENTRAL</STMTTRN>',
  '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260416120000<TRNAMT>-1200.00<FITID>FIT-659-0002<MEMO>SUPERMERCADO XYZ</STMTTRN>',
  '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
].join('\n');

// CSV sem FITID — Tier A2 depende do hash de bytes do arquivo.
const CSV_CARD_FILE_1 =
  'date,title,amount\n2026-04-10,Cafeteria Bourbon,12.00\n2026-04-01,Posto Shell,50.00\n';
// mesmo café, bytes DIFERENTES (2ª linha distinta) → NÃO é Tier A2, cai em Tier B.
const CSV_CARD_FILE_2 =
  'date,title,amount\n2026-04-10,Cafeteria Bourbon,12.00\n2026-04-02,Mercado Bom,30.00\n';

function buildServices() {
  const classifier = new MerchantClassifierService(prisma);
  const conciliacao = new ConciliacaoService(prisma);
  const settlement = new CardInvoiceSettlementService(prisma);
  return {
    receipt: new ReceiptService(prisma, classifier),
    bank: new BankAccountService(prisma, classifier, conciliacao, settlement),
    card: new CreditCardService(prisma, conciliacao, classifier),
  };
}

async function moneySnapshot(projectId: string) {
  const [expenses, receipts, cash] = await Promise.all([
    setupPrisma.expense.findMany({
      where: { projectId, deletedAt: null },
      select: { id: true, valorTotal: true, linkedExpenseId: true, accountId: true, importId: true },
    }),
    setupPrisma.receipt.findMany({
      where: { projectId, deletedAt: null },
      select: { id: true, valor: true, linkedReceiptId: true, accountId: true, importId: true },
    }),
    setupPrisma.cashFlowEntry.findMany({
      where: { projectId, deletedAt: null },
      select: { valor: true },
    }),
  ]);
  const expenseSum = expenses.reduce((s, e) => s + e.valorTotal, 0);
  const receiptSum = receipts.reduce((s, r) => s + r.valor, 0);
  const cashSum = cash.reduce((s, c) => s + c.valor, 0);
  return {
    rowCount: expenses.length + receipts.length,
    consolidatedTotal: expenseSum + receiptSum,
    cashSum,
    expenses,
    receipts,
  };
}

async function cleanup() {
  for (const t of [TENANT, OTHER_TENANT]) {
    await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: t } });
    await setupPrisma.expense.deleteMany({ where: { tenantId: t } });
    await setupPrisma.receipt.deleteMany({ where: { tenantId: t } });
    await setupPrisma.creditCardStatementImport.deleteMany({ where: { tenantId: t } });
    await setupPrisma.bankStatementImport.deleteMany({ where: { tenantId: t } });
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: t } });
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: t } });
    await setupPrisma.project.deleteMany({ where: { tenantId: t } });
    await setupPrisma.tenant.deleteMany({ where: { id: t } });
  }
}

let svc: ReturnType<typeof buildServices>;

beforeAll(async () => {
  await setupPrisma.$connect();
  await prisma.onModuleInit();
  await cleanup();
  await setupPrisma.tenant.createMany({
    data: [
      { id: TENANT, name: 'Dedupe 659' },
      { id: OTHER_TENANT, name: 'Dedupe 659 other' },
    ],
  });
  await setupPrisma.project.createMany({
    data: [
      { id: PROJ_A, tenantId: TENANT, type: 'PESSOAL', name: 'Proj A' },
      { id: PROJ_B, tenantId: TENANT, type: 'PESSOAL', name: 'Proj B' },
    ],
  });
  await setupPrisma.bankAccount.createMany({
    data: [
      { id: ACCOUNT_A, tenantId: TENANT, projectId: PROJ_A, institution: 'ITAU', nickname: 'Conta A', last4: '1111' },
      { id: ACCOUNT_B, tenantId: TENANT, projectId: PROJ_B, institution: 'ITAU', nickname: 'Conta B', last4: '2222' },
    ],
  });
  await setupPrisma.creditCard.create({
    data: { id: CARD_A, tenantId: TENANT, projectId: PROJ_A, institution: 'ITAU', nickname: 'Card A', last4: '3333', brand: 'VISA', closingDay: 3, dueDay: 10 },
  });
  svc = buildServices();
});

afterAll(async () => {
  await cleanup();
  await prisma.onModuleDestroy();
  await setupPrisma.$disconnect();
});

afterEach(async () => {
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: { in: [TENANT, OTHER_TENANT] } } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: { in: [TENANT, OTHER_TENANT] } } });
  await setupPrisma.receipt.deleteMany({ where: { tenantId: { in: [TENANT, OTHER_TENANT] } } });
  await setupPrisma.creditCardStatementImport.deleteMany({ where: { tenantId: { in: [TENANT, OTHER_TENANT] } } });
  await setupPrisma.bankStatementImport.deleteMany({ where: { tenantId: { in: [TENANT, OTHER_TENANT] } } });
});

const buf = (s: string) => Buffer.from(s, 'utf-8');

describe('#659 Tier A — auto-skip cross-origin do MESMO arquivo (FITID)', () => {
  it('contrato #1: Carteira (receipt/bank) primeiro, extrato depois → nenhum dinheiro novo', async () => {
    const r1 = (await svc.receipt.commitImport(
      TENANT, PROJ_A, [buf(OFX_TWO_TXNS)], 'bank', 'OFX', undefined, undefined, undefined, null, 'extrato.ofx',
    )) as any;
    expect(r1.error).toBeUndefined();

    const before = await moneySnapshot(PROJ_A);
    expect(before.rowCount).toBe(2);

    const r2 = (await svc.bank.commitImport(
      TENANT, PROJ_A, ACCOUNT_A, [buf(OFX_TWO_TXNS)], 'extrato.ofx', 'OFX', undefined, undefined, undefined, null, REQ,
    )) as any;

    // baseline: seed diferente → external_id não casa → duplicated = 0
    expect(r2.duplicated).toBe(2);

    const after = await moneySnapshot(PROJ_A);
    expect(after.rowCount).toBe(before.rowCount);
    expect(after.consolidatedTotal).toBe(before.consolidatedTotal);
    expect(after.cashSum).toBe(before.cashSum);
  });

  it('contrato #1 inverso: extrato primeiro, Carteira depois → nenhum dinheiro novo', async () => {
    const r1 = (await svc.bank.commitImport(
      TENANT, PROJ_A, ACCOUNT_A, [buf(OFX_TWO_TXNS)], 'extrato.ofx', 'OFX', undefined, undefined, undefined, null, REQ,
    )) as any;
    expect(r1.error).toBeUndefined();

    const before = await moneySnapshot(PROJ_A);
    expect(before.rowCount).toBe(2);

    const r2 = (await svc.receipt.commitImport(
      TENANT, PROJ_A, [buf(OFX_TWO_TXNS)], 'bank', 'OFX', undefined, undefined, undefined, null, 'extrato.ofx',
    )) as any;
    expect(r2.duplicated).toBe(2);

    const after = await moneySnapshot(PROJ_A);
    expect(after.rowCount).toBe(before.rowCount);
    expect(after.consolidatedTotal).toBe(before.consolidatedTotal);
    expect(after.cashSum).toBe(before.cashSum);
  });

  it('contrato #3: o 2º import não move/vincula/soft-deleta nenhuma linha existente', async () => {
    await svc.receipt.commitImport(
      TENANT, PROJ_A, [buf(OFX_TWO_TXNS)], 'bank', 'OFX', undefined, undefined, undefined, null, 'extrato.ofx',
    );
    const before = await moneySnapshot(PROJ_A);

    await svc.bank.commitImport(
      TENANT, PROJ_A, ACCOUNT_A, [buf(OFX_TWO_TXNS)], 'extrato.ofx', 'OFX', undefined, undefined, undefined, null, REQ,
    );
    const after = await moneySnapshot(PROJ_A);

    const key = (rows: any[]) =>
      rows.map((r) => `${r.id}|${r.linkedExpenseId ?? r.linkedReceiptId ?? ''}|${r.accountId ?? ''}|${r.importId ?? ''}`).sort();
    expect(key(after.expenses)).toEqual(key(before.expenses));
    expect(key(after.receipts)).toEqual(key(before.receipts));

    const settlements = await setupPrisma.crossProjectSettlement.count({ where: { tenantId: TENANT } });
    const rateio = await setupPrisma.rateioAllocation.count({ where: { tenantId: TENANT } });
    expect(settlements).toBe(0);
    expect(rateio).toBe(0);
  });
});

describe('#659 Tier A2 — auto-skip por hash de bytes (CSV sem FITID)', () => {
  it('contrato #1/#8: receipt(card) primeiro, fatura depois, MESMOS bytes → duplicated', async () => {
    const r1 = (await svc.receipt.commitImport(
      TENANT, PROJ_A, [buf(CSV_CARD_FILE_1)], 'card', 'CSV_NUBANK', undefined, undefined, undefined, null, 'fatura.csv',
    )) as any;
    expect(r1.error).toBeUndefined();
    const before = await moneySnapshot(PROJ_A);
    expect(before.rowCount).toBe(2);

    const r2 = (await svc.card.commitImport(
      TENANT, PROJ_A, CARD_A, [buf(CSV_CARD_FILE_1)], 'fatura.csv', 'CSV_NUBANK', undefined, undefined, undefined, null, REQ,
    )) as any;
    expect(r2.duplicated).toBe(2);

    const after = await moneySnapshot(PROJ_A);
    expect(after.rowCount).toBe(before.rowCount);
    expect(after.consolidatedTotal).toBe(before.consolidatedTotal);
  });
});

describe('#659 Tier B — natural-key entre arquivos DIFERENTES é superfície, não auto-skip', () => {
  it('contrato #2/#4: preview anexa possibleDuplicate + willImport=false; commit sem decision não cria', async () => {
    // arquivo 1 via fatura
    await svc.card.commitImport(
      TENANT, PROJ_A, CARD_A, [buf(CSV_CARD_FILE_1)], 'fatura1.csv', 'CSV_NUBANK', undefined, undefined, undefined, null, REQ,
    );
    const before = await moneySnapshot(PROJ_A);

    // arquivo 2 (bytes diferentes, mesmo café R$12/2026-04-10) via Carteira
    const preview = (await svc.receipt.previewImport(
      TENANT, PROJ_A, [buf(CSV_CARD_FILE_2)], 'card', 'CSV_NUBANK', undefined, undefined, 'fatura2.csv',
    )) as any;
    const coffeeRow = preview.preview.find((p: any) => /Cafeteria Bourbon/i.test(p.description));
    expect(coffeeRow).toBeDefined();
    expect(coffeeRow.possibleDuplicate).toBeDefined();
    expect(coffeeRow.possibleDuplicate.existingId).toEqual(expect.any(String));
    expect(coffeeRow.possibleDuplicate.reason).toEqual(expect.any(String));
    expect(coffeeRow.willImport).toBe(false);
    // não conta como duplicata-forte
    expect(coffeeRow.duplicate).toBe(false);

    // commit sem decision → café fica de fora (skipped), "Mercado Bom" entra
    const commit = (await svc.receipt.commitImport(
      TENANT, PROJ_A, [buf(CSV_CARD_FILE_2)], 'card', 'CSV_NUBANK', undefined, undefined, undefined, null, 'fatura2.csv',
    )) as any;
    expect(Array.isArray(commit.possibleDuplicates)).toBe(true);
    expect(commit.possibleDuplicates.map((p: any) => p.externalId)).toContain(coffeeRow.externalId);

    const mid = await moneySnapshot(PROJ_A);
    // só +1 linha (Mercado Bom 3000), café NÃO recriado
    expect(mid.rowCount).toBe(before.rowCount + 1);
    expect(mid.consolidatedTotal).toBe(before.consolidatedTotal + 3000);
  });

  it('contrato #2: usuário FORÇA import da linha Tier B via decisions[].action=import', async () => {
    await svc.card.commitImport(
      TENANT, PROJ_A, CARD_A, [buf(CSV_CARD_FILE_1)], 'fatura1.csv', 'CSV_NUBANK', undefined, undefined, undefined, null, REQ,
    );
    const preview = (await svc.receipt.previewImport(
      TENANT, PROJ_A, [buf(CSV_CARD_FILE_2)], 'card', 'CSV_NUBANK', undefined, undefined, 'fatura2.csv',
    )) as any;
    const coffeeRow = preview.preview.find((p: any) => /Cafeteria Bourbon/i.test(p.description));
    const before = await moneySnapshot(PROJ_A);

    const commit = (await svc.receipt.commitImport(
      TENANT, PROJ_A, [buf(CSV_CARD_FILE_2)], 'card', 'CSV_NUBANK', undefined, undefined,
      [{ externalId: coffeeRow.externalId, action: 'import' } as any], null, 'fatura2.csv',
    )) as any;
    expect(commit.error).toBeUndefined();

    const after = await moneySnapshot(PROJ_A);
    // café (1200) + Mercado Bom (3000) entram → +2 linhas, +4200
    expect(after.rowCount).toBe(before.rowCount + 2);
    expect(after.consolidatedTotal).toBe(before.consolidatedTotal + 4200);
  });
});

describe('#659 contrato #5 — dedupe é project-scoped', () => {
  it('mesmo arquivo importado em OUTRO projeto não deduplica', async () => {
    await svc.receipt.commitImport(
      TENANT, PROJ_A, [buf(OFX_TWO_TXNS)], 'bank', 'OFX', undefined, undefined, undefined, null, 'extrato.ofx',
    );
    const beforeB = await moneySnapshot(PROJ_B);
    expect(beforeB.rowCount).toBe(0);

    const rB = (await svc.bank.commitImport(
      TENANT, PROJ_B, ACCOUNT_B, [buf(OFX_TWO_TXNS)], 'extrato.ofx', 'OFX', undefined, undefined, undefined, null, REQ,
    )) as any;
    expect(rB.duplicated).toBe(0);

    const afterB = await moneySnapshot(PROJ_B);
    expect(afterB.rowCount).toBe(2);
  });
});

describe('#659 contrato #7 — re-import do MESMO canal continua idempotente', () => {
  it('bank → bank do mesmo arquivo não recria', async () => {
    await svc.bank.commitImport(
      TENANT, PROJ_A, ACCOUNT_A, [buf(OFX_TWO_TXNS)], 'extrato.ofx', 'OFX', undefined, undefined, undefined, null, REQ,
    );
    const before = await moneySnapshot(PROJ_A);
    const r2 = (await svc.bank.commitImport(
      TENANT, PROJ_A, ACCOUNT_A, [buf(OFX_TWO_TXNS)], 'extrato.ofx', 'OFX', undefined, undefined, undefined, null, REQ,
    )) as any;
    expect(r2.duplicated).toBe(2);
    const after = await moneySnapshot(PROJ_A);
    expect(after.rowCount).toBe(before.rowCount);
    expect(after.consolidatedTotal).toBe(before.consolidatedTotal);
  });
});
