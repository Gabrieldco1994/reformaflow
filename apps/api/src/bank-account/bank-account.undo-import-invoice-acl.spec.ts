// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { BankAccountService } from './bank-account.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RateioRequester } from '../expense/rateio.types';

/**
 * issue #569 — ACL do undo de importação AGORA é dirigida pelo LEDGER
 * (`ImportedCardInvoiceSettlement`), não pela reconstrução do ciclo da fatura
 * pelo `cardLast4` + dias atuais do cartão.
 *
 * Consequência (mudança de contrato deliberada, decisão do PO):
 *  - o undo autoriza `cardProjectId` do ledger + todo projeto dono de uma
 *    parcela registrada, ANTES da primeira escrita; sem acesso → 404 e zero
 *    write;
 *  - um pagamento SEM ledger (legado) não dispara mais 404 por cartão
 *    oculto/ausente: ele sai com o lote e NENHUMA compra de cartão é tocada
 *    (só `warn` + `notRevertibleInvoiceLiquidations`).
 */
const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'bank-invoice-undo-acl-tenant';
const PESSOAL = 'bank-invoice-undo-acl-pessoal';
const ALLOWED = 'bank-invoice-undo-acl-allowed';
const HIDDEN = 'bank-invoice-undo-acl-hidden';
const REMOVED_PROJECT = 'bank-invoice-undo-acl-removed';
const LAST4 = '4488';
const PAYMENT_DATE = new Date('2026-08-10T12:00:00.000Z');
const PURCHASE_DATE = new Date('2026-07-15T12:00:00.000Z');
const DELETED_AT = new Date('2026-08-19T12:00:00.000Z');

const MANAGED: RateioRequester = {
  role: 'USER',
  allowedProjects: [PESSOAL, ALLOWED],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses', 'creditCards'],
};
const OWNER: RateioRequester = { role: 'OWNER' };

describe('BankAccountService.undoImport — ACL do ledger de liquidação (#569)', () => {
  let service: BankAccountService;
  let accountId: string;
  let cardId: string;

  async function cleanupTransient(): Promise<void> {
    await setupPrisma.importedCardInvoiceSettlementEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.importedCardInvoiceSettlement.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.receipt.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  }

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupTransient();
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });

    await setupPrisma.tenant.create({ data: { id: TENANT, name: 'Bank invoice undo ACL' } });
    await setupPrisma.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal' },
        { id: ALLOWED, tenantId: TENANT, type: 'REFORMA', name: 'Permitido' },
        { id: HIDDEN, tenantId: TENANT, type: 'REFORMA', name: 'Oculto' },
        { id: REMOVED_PROJECT, tenantId: TENANT, type: 'REFORMA', name: 'Removido', deletedAt: DELETED_AT },
      ],
    });
    const account = await setupPrisma.bankAccount.create({
      data: { tenantId: TENANT, projectId: PESSOAL, institution: 'ITAU', nickname: 'Conta ACL', last4: '1881' },
    });
    accountId = account.id;
    const card = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: 'ITAU',
        brand: 'Visa',
        nickname: 'Cartão ACL',
        last4: LAST4,
        closingDay: 20,
        dueDay: 10,
      },
    });
    cardId = card.id;
    service = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      new CardInvoiceSettlementService(prisma),
    );
  });

  afterEach(cleanupTransient);

  afterAll(async () => {
    await cleanupTransient();
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  async function createImportWithPayment(): Promise<{ importId: string; paymentId: string }> {
    const imported = await setupPrisma.bankStatementImport.create({
      data: { tenantId: TENANT, accountId, periodLabel: '2026-08', source: 'OFX', inserted: 1, totalAmountCents: 10_000 },
    });
    const payment = await setupPrisma.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        titulo: 'Pagamento da fatura',
        valor: 10_000,
        quantidade: 1,
        valorTotal: 10_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: PAYMENT_DATE,
        status: 'PAGO',
        cardLast4: LAST4,
        importId: imported.id,
        accountId,
        bankLast4: '1881',
        origin: 'import',
      },
    });
    return { importId: imported.id, paymentId: payment.id };
  }

  /** Cria uma compra de cartão PAGO num projeto + o ledger que a "liquidou" neste import. */
  async function ledgerFor(params: {
    importId: string;
    paymentId: string;
    purchaseProjectId: string;
    cardProjectId?: string;
  }): Promise<{ purchaseId: string; entryId: string }> {
    const purchase = await setupPrisma.expense.create({
      data: {
        tenantId: TENANT,
        projectId: params.purchaseProjectId,
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        titulo: 'Compra de cartão',
        valor: 10_000,
        quantidade: 1,
        valorTotal: 10_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: PURCHASE_DATE,
        status: 'PAGO',
        cardLast4: LAST4,
      },
    });
    const entry = await setupPrisma.cashFlowEntry.create({
      data: {
        tenantId: TENANT,
        projectId: params.purchaseProjectId,
        expenseId: purchase.id,
        valor: 10_000,
        tipo: 'DESPESA',
        data: PURCHASE_DATE,
        categoria: 'MATERIAL_CONSTRUCAO',
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
      },
    });
    const settlement = await setupPrisma.importedCardInvoiceSettlement.create({
      data: {
        tenantId: TENANT,
        bankStatementImportId: params.importId,
        paymentExpenseId: params.paymentId,
        cardId,
        cardProjectId: params.cardProjectId ?? PESSOAL,
        strategy: 'DUE_MONTH',
        targetDueMonth: '2026-08',
      },
    });
    await setupPrisma.importedCardInvoiceSettlementEntry.create({
      data: {
        tenantId: TENANT,
        settlementId: settlement.id,
        cashFlowEntryId: entry.id,
        expenseId: purchase.id,
      },
    });
    return { purchaseId: purchase.id, entryId: entry.id };
  }

  async function expectPreserved(importId: string, paymentId: string, entryIds: string[]): Promise<void> {
    const [storedImport, payment, entries] = await Promise.all([
      setupPrisma.bankStatementImport.findUnique({ where: { id: importId } }),
      setupPrisma.expense.findUnique({ where: { id: paymentId } }),
      entryIds.length
        ? setupPrisma.cashFlowEntry.findMany({ where: { id: { in: entryIds } } })
        : Promise.resolve([]),
    ]);
    expect(storedImport?.deletedAt).toBeNull();
    expect(payment?.deletedAt).toBeNull();
    expect(entries.every((e) => e.status === 'PAGO' && e.deletedAt === null)).toBe(true);
  }

  it('RED #7 — parcela registrada num projeto que o USER não vê: 404 e zero write', async () => {
    const { importId, paymentId } = await createImportWithPayment();
    const { entryId } = await ledgerFor({ importId, paymentId, purchaseProjectId: HIDDEN });

    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, importId, MANAGED),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expectPreserved(importId, paymentId, [entryId]);
  });

  it('cardProjectId do ledger sob projeto removido: 404 e zero write', async () => {
    const { importId, paymentId } = await createImportWithPayment();
    const { entryId } = await ledgerFor({
      importId,
      paymentId,
      purchaseProjectId: PESSOAL,
      cardProjectId: REMOVED_PROJECT,
    });

    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, importId, MANAGED),
    ).rejects.toMatchObject({ status: 404 });

    await expectPreserved(importId, paymentId, [entryId]);
  });

  it('OWNER reverte o ledger: parcela volta a PLANEJADO e o lote some', async () => {
    const { importId, paymentId } = await createImportWithPayment();
    const { purchaseId, entryId } = await ledgerFor({ importId, paymentId, purchaseProjectId: HIDDEN });

    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, importId, OWNER),
    ).resolves.toMatchObject({ ok: true, alreadyUndone: false, revertedInvoiceParcelas: 1 });

    const [storedImport, payment, purchase, entry, ledgerEntry] = await Promise.all([
      setupPrisma.bankStatementImport.findUnique({ where: { id: importId } }),
      setupPrisma.expense.findUnique({ where: { id: paymentId } }),
      setupPrisma.expense.findUnique({ where: { id: purchaseId } }),
      setupPrisma.cashFlowEntry.findUnique({ where: { id: entryId } }),
      setupPrisma.importedCardInvoiceSettlementEntry.findFirst({ where: { cashFlowEntryId: entryId } }),
    ]);
    expect(storedImport?.deletedAt).not.toBeNull();
    expect(payment?.deletedAt).not.toBeNull();
    expect(purchase?.status).toBe('PLANEJADO');
    expect(entry?.status).toBe('PLANEJADO');
    expect(ledgerEntry?.releasedAt).not.toBeNull();
  });

  it('pagamento SEM ledger (legado): não é mais 404 por cartão — some com o lote, compra intacta', async () => {
    const { importId, paymentId } = await createImportWithPayment();
    // Compra do cartão que ficou PAGO por esse pagamento legado — sem ledger.
    const purchase = await setupPrisma.expense.create({
      data: {
        tenantId: TENANT,
        projectId: HIDDEN,
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        titulo: 'Compra legado',
        valor: 10_000,
        quantidade: 1,
        valorTotal: 10_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: PURCHASE_DATE,
        status: 'PAGO',
        cardLast4: LAST4,
      },
    });
    const entry = await setupPrisma.cashFlowEntry.create({
      data: {
        tenantId: TENANT,
        projectId: HIDDEN,
        expenseId: purchase.id,
        valor: 10_000,
        tipo: 'DESPESA',
        data: PURCHASE_DATE,
        categoria: 'MATERIAL_CONSTRUCAO',
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
      },
    });

    const result = await service.undoImport(TENANT, PESSOAL, accountId, importId, MANAGED);
    expect(result).toMatchObject({ ok: true, notRevertedInvoiceLiquidations: 1, revertedInvoiceParcelas: 0 });

    expect((await setupPrisma.bankStatementImport.findUnique({ where: { id: importId } }))?.deletedAt).not.toBeNull();
    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: entry.id } }))?.status).toBe('PAGO');
  });

  it('requester ausente rejeita antes de qualquer write', async () => {
    const imported = await setupPrisma.bankStatementImport.create({
      data: { tenantId: TENANT, accountId, periodLabel: '2026-08', source: 'OFX', inserted: 0, totalAmountCents: 0 },
    });
    await expect(
      (service as any).undoImport(TENANT, PESSOAL, accountId, imported.id, undefined),
    ).rejects.toBeDefined();
    expect((await setupPrisma.bankStatementImport.findUnique({ where: { id: imported.id } }))?.deletedAt).toBeNull();
  });
});
