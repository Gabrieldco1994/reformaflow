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
  allowedProjects: [PESSOAL, ALLOWED, REMOVED_PROJECT],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses'],
};
const OWNER: RateioRequester = { role: 'OWNER' };

function expenseData(projectId: string, title: string, value: number) {
  return {
    tenantId: TENANT,
    projectId,
    tipoDespesa: 'MATERIAL_CONSTRUCAO',
    titulo: title,
    valor: value,
    quantidade: 1,
    valorTotal: value,
    formaPagamento: 'A_VISTA',
    dataPagamento: PURCHASE_DATE,
    status: 'PAGO',
    cardLast4: LAST4,
  };
}

describe('BankAccountService.undoImport — ACL das compras de fatura', () => {
  let service: BankAccountService;
  let accountId: string;
  let cardId: string;

  async function cleanupTransient(): Promise<void> {
    await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.receipt.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  }

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupTransient();
    await setupPrisma.creditCardStatementImport.deleteMany({ where: { tenantId: TENANT } });
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
        {
          id: REMOVED_PROJECT,
          tenantId: TENANT,
          type: 'REFORMA',
          name: 'Removido',
          deletedAt: DELETED_AT,
        },
      ],
    });
    const account = await setupPrisma.bankAccount.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: 'ITAU',
        nickname: 'Conta ACL',
        last4: '1881',
      },
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
    await setupPrisma.creditCardStatementImport.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  async function createImportWithPayment(): Promise<{ importId: string; paymentId: string }> {
    const imported = await setupPrisma.bankStatementImport.create({
      data: {
        tenantId: TENANT,
        accountId,
        periodLabel: '2026-08',
        source: 'OFX',
        inserted: 1,
        totalAmountCents: 10_000,
      },
    });
    const payment = await setupPrisma.expense.create({
      data: {
        ...expenseData(PESSOAL, 'Pagamento da fatura', 10_000),
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        dataPagamento: PAYMENT_DATE,
        importId: imported.id,
        accountId,
        bankLast4: '1881',
        origin: 'import',
      },
    });
    return { importId: imported.id, paymentId: payment.id };
  }

  async function createPurchase(projectId: string, title: string): Promise<string> {
    const purchase = await setupPrisma.expense.create({
      data: expenseData(projectId, title, 10_000),
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        tenantId: TENANT,
        projectId,
        expenseId: purchase.id,
        valor: 10_000,
        tipo: 'DESPESA',
        data: PURCHASE_DATE,
        categoria: 'MATERIAL_CONSTRUCAO',
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
      },
    });
    return purchase.id;
  }

  async function expectEverythingPreserved(
    importId: string,
    paymentId: string,
    purchaseIds: string[],
  ): Promise<void> {
    const [storedImport, payment, purchases, entries] = await Promise.all([
      setupPrisma.bankStatementImport.findUnique({ where: { id: importId } }),
      setupPrisma.expense.findUnique({ where: { id: paymentId } }),
      setupPrisma.expense.findMany({ where: { id: { in: purchaseIds } } }),
      setupPrisma.cashFlowEntry.findMany({ where: { expenseId: { in: purchaseIds } } }),
    ]);
    expect(storedImport?.deletedAt).toBeNull();
    expect(payment?.deletedAt).toBeNull();
    expect(purchases).toHaveLength(purchaseIds.length);
    expect(purchases.every((purchase) => purchase.status === 'PAGO')).toBe(true);
    expect(entries).toHaveLength(purchaseIds.length);
    expect(entries.every((entry) => entry.status === 'PAGO' && entry.deletedAt === null)).toBe(
      true,
    );
  }

  it('bloqueia compra hidden com o mesmo last4 e preserva lote, fonte e compra', async () => {
    const { importId, paymentId } = await createImportWithPayment();
    const hiddenPurchaseId = await createPurchase(HIDDEN, 'Compra oculta');

    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, importId, MANAGED),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expectEverythingPreserved(importId, paymentId, [hiddenPurchaseId]);
  });

  it('torna cartão ausente e oculto indistinguíveis, sem alterar os lotes', async () => {
    const missing = await createImportWithPayment();
    await setupPrisma.expense.update({
      where: { id: missing.paymentId },
      data: { cardLast4: '9999' },
    });

    const missingResult = service.undoImport(
      TENANT,
      PESSOAL,
      accountId,
      missing.importId,
      MANAGED,
    );
    await expect(missingResult).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ message: 'Importação não encontrada' }),
    });
    await expectEverythingPreserved(missing.importId, missing.paymentId, []);

    const hidden = await createImportWithPayment();
    await setupPrisma.creditCard.update({
      where: { id: cardId },
      data: { projectId: HIDDEN },
    });
    try {
      await expect(
        service.undoImport(TENANT, PESSOAL, accountId, hidden.importId, MANAGED),
      ).rejects.toMatchObject({
        status: 404,
        response: expect.objectContaining({ message: 'Importação não encontrada' }),
      });
    } finally {
      await setupPrisma.creditCard.update({
        where: { id: cardId },
        data: { projectId: PESSOAL },
      });
    }
    await expectEverythingPreserved(hidden.importId, hidden.paymentId, []);
  });

  it('bloqueia lote misto allowed+hidden antes de qualquer alteração', async () => {
    const { importId, paymentId } = await createImportWithPayment();
    const [allowedPurchaseId, hiddenPurchaseId] = await Promise.all([
      createPurchase(ALLOWED, 'Compra permitida'),
      createPurchase(HIDDEN, 'Compra oculta'),
    ]);

    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, importId, MANAGED),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expectEverythingPreserved(importId, paymentId, [
      allowedPurchaseId,
      hiddenPurchaseId,
    ]);
  });

  it('requester ausente rejeita lote sem filhos antes de qualquer write', async () => {
    const imported = await setupPrisma.bankStatementImport.create({
      data: {
        tenantId: TENANT,
        accountId,
        periodLabel: '2026-08',
        source: 'OFX',
        inserted: 0,
        totalAmountCents: 0,
      },
    });

    await expect(
      (service as any).undoImport(TENANT, PESSOAL, accountId, imported.id, undefined),
    ).rejects.toBeDefined();

    const stored = await setupPrisma.bankStatementImport.findUnique({
      where: { id: imported.id },
    });
    expect(stored?.deletedAt).toBeNull();
  });

  it('OWNER same-tenant desfaz a liquidação e o lote', async () => {
    const { importId, paymentId } = await createImportWithPayment();
    const hiddenPurchaseId = await createPurchase(HIDDEN, 'Compra do owner');

    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, importId, OWNER),
    ).resolves.toMatchObject({
      ok: true,
      alreadyUndone: false,
      revertedInvoiceParcelas: 1,
    });

    const [storedImport, payment, purchase, entry] = await Promise.all([
      setupPrisma.bankStatementImport.findUnique({ where: { id: importId } }),
      setupPrisma.expense.findUnique({ where: { id: paymentId } }),
      setupPrisma.expense.findUnique({ where: { id: hiddenPurchaseId } }),
      setupPrisma.cashFlowEntry.findFirst({ where: { expenseId: hiddenPurchaseId } }),
    ]);
    expect(storedImport?.deletedAt).not.toBeNull();
    expect(payment?.deletedAt).not.toBeNull();
    expect(purchase?.status).toBe('PLANEJADO');
    expect(entry?.status).toBe('PLANEJADO');
  });

  it.each([
    ['USER autorizado', MANAGED],
    ['OWNER', OWNER],
  ])(
    'rejeita compra ativa sob projeto removido para %s e preserva o lote inteiro',
    async (_label, requester) => {
      const { importId, paymentId } = await createImportWithPayment();
      const purchaseId = await createPurchase(REMOVED_PROJECT, 'Compra em projeto removido');

      await expect(
        service.undoImport(TENANT, PESSOAL, accountId, importId, requester),
      ).rejects.toMatchObject({
        status: 404,
        response: expect.objectContaining({ message: 'Importação não encontrada' }),
      });

      await expectEverythingPreserved(importId, paymentId, [purchaseId]);
    },
  );

  it.each([
    ['USER autorizado', MANAGED],
    ['OWNER', OWNER],
  ])(
    'rejeita cartão ativo sob projeto removido para %s e preserva o lote inteiro',
    async (_label, requester) => {
      const { importId, paymentId } = await createImportWithPayment();
      await setupPrisma.creditCard.update({
        where: { id: cardId },
        data: { projectId: REMOVED_PROJECT },
      });

      try {
        await expect(
          service.undoImport(TENANT, PESSOAL, accountId, importId, requester),
        ).rejects.toMatchObject({
          status: 404,
          response: expect.objectContaining({ message: 'Importação não encontrada' }),
        });
      } finally {
        await setupPrisma.creditCard.update({
          where: { id: cardId },
          data: { projectId: PESSOAL },
        });
      }

      await expectEverythingPreserved(importId, paymentId, []);
    },
  );
});
