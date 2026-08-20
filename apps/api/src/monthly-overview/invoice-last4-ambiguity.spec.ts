/**
 * B1b (#448, PR 3/3) — endurecimento do legado: last4 AMBÍGUO falha alto.
 *
 * Contrato (issue #448, seção B1b + RED "IDs nos summaries; colisões last4 sem
 * actions/409"):
 *  - "Last4 ambíguo no legado retorna 409 (nunca resolve silenciosamente)."
 *  - "Servidor emite capabilities; UI não inventa CTA."
 *  - "Ações reautorizam parent/filhos no servidor."
 *
 * No runtime pré-B1b, `payInvoice`/`undoInvoicePayment` resolviam o caminho
 * legado com `findFirst({ tenantId, projectId, last4 })`: com DOIS cartões
 * ativos de mesmo final, o banco escolhia um em silêncio e a ação caía no
 * cartão que o servidor adivinhou. O guard de duplicado do B1a impede CRIAR
 * essa colisão, então ela só existe como DADO LEGADO — por isso as duplicatas
 * abaixo entram pelo client cru (`setupPrisma`), não pelos services.
 *
 * A leitura tem a contraparte: uma linha de fatura de last4 ambíguo não pode
 * oferecer CTA (`actions: []`) nem emitir o `cardId` adivinhado — senão um web
 * novo mandaria esse id exato e passaria por cima do 409, agindo justamente
 * sobre o cartão que o servidor chutou.
 *
 * Prisma REAL (SQLite descartável); zero-write provado por snapshot financeiro
 * completo antes/depois.
 */
// O guard do banco de teste precisa carregar ANTES de qualquer import do Prisma.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { HttpException } from '@nestjs/common';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  MonthlyOverviewMutationRequester,
  MonthlyOverviewService,
} from './monthly-overview.service';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'b1b-last4-tenant';
const PESSOAL = 'b1b-last4-pessoal';
const OUTRO_PESSOAL = 'b1b-last4-outro-pessoal';

const DUPLICATE_CARD_LAST4 = '4488';
const UNIQUE_CARD_LAST4 = '7777';
const DUPLICATE_BANK_LAST4 = '1881';
const UNIQUE_BANK_LAST4 = '9999';

const DUE_MONTH = '2026-08';
const PURCHASE_DATE = new Date('2026-08-05T12:00:00.000Z');
const PAYMENT_DATE = '2026-08-10';

const REQUESTER: MonthlyOverviewMutationRequester = {
  id: 'b1b-last4-user',
  role: 'ADMIN',
};
/** Alcança o PESSOAL âncora pelo módulo do cockpit (mesma população do #480 SEC-1). */
const SCOPED: MonthlyOverviewMutationRequester = {
  id: 'b1b-last4-scoped-user',
  role: 'USER',
  allowedProjects: [PESSOAL],
  allowedProjectTypes: [],
  allowedModules: ['monthlyOverview', 'expenses'],
};
/** MESMO usuário depois de perder o projeto da lente (revogação entre ler e agir). */
const REVOKED: MonthlyOverviewMutationRequester = {
  ...SCOPED,
  allowedProjects: [OUTRO_PESSOAL],
};

let duplicateCardA: { id: string; last4: string };
let duplicateCardB: { id: string; last4: string };
let uniqueCard: { id: string; last4: string };
let duplicateAccountA: { id: string; last4: string };
let uniqueAccount: { id: string; last4: string };

function rejectionShape(error: unknown) {
  if (!(error instanceof HttpException)) {
    return error
      ? { name: (error as Error).constructor.name, status: null, message: (error as Error).message, body: null }
      : null;
  }
  return {
    name: error.constructor.name,
    status: error.getStatus(),
    message: error.message,
    body: error.getResponse(),
  };
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

async function financialSnapshot() {
  const [expenses, entries] = await Promise.all([
    setupPrisma.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        projectId: true,
        tipoDespesa: true,
        valor: true,
        valorTotal: true,
        status: true,
        paidParcelas: true,
        cardLast4: true,
        bankLast4: true,
        dataPagamento: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    setupPrisma.cashFlowEntry.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        expenseId: true,
        valor: true,
        status: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);
  return { expenses, entries };
}

async function cleanupTransient() {
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
}

async function cleanupAll() {
  await cleanupTransient();
  await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
}

/** Abre uma fatura no DUE_MONTH (cartão sem closingDay/dueDay: competência = mês da compra). */
async function openInvoice(cardLast4: string, amountCents: number, titulo: string) {
  const purchase = await setupPrisma.expense.create({
    data: {
      tenantId: TENANT,
      projectId: PESSOAL,
      tipoDespesa: 'ALIMENTACAO',
      titulo,
      valor: amountCents,
      quantidade: 1,
      valorTotal: amountCents,
      formaPagamento: 'A_VISTA',
      dataPagamento: PURCHASE_DATE,
      status: 'PAGO',
      cardLast4,
      origin: 'import',
    },
  });
  await setupPrisma.cashFlowEntry.create({
    data: {
      tenantId: TENANT,
      projectId: PESSOAL,
      expenseId: purchase.id,
      valor: amountCents,
      tipo: 'DESPESA',
      categoria: 'Alimentação',
      formaPagamento: 'CARTAO_CREDITO',
      data: PURCHASE_DATE,
      status: 'PAGO',
    },
  });
  return purchase;
}

describe('Fatura de cartão — last4 legado ambíguo (#448 B1b)', () => {
  let service: MonthlyOverviewService;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupAll();

    await setupPrisma.tenant.create({ data: { id: TENANT, name: 'B1b last4 tenant' } });
    await setupPrisma.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal' },
        { id: OUTRO_PESSOAL, tenantId: TENANT, type: 'PESSOAL', name: 'Outro pessoal' },
      ],
    });

    // DADO LEGADO: dois cartões ATIVOS de mesmo final no MESMO projeto. O guard
    // do B1a bloqueia criar isso pelo service — aqui entra pelo client cru.
    duplicateCardA = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, institution: 'ITAU', brand: 'Visa',
        nickname: 'Cartão legado A', last4: DUPLICATE_CARD_LAST4,
      },
    });
    duplicateCardB = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, institution: 'NUBANK', brand: 'Mastercard',
        nickname: 'Cartão legado B', last4: DUPLICATE_CARD_LAST4,
      },
    });
    uniqueCard = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, institution: 'BB', brand: 'Elo',
        nickname: 'Cartão único', last4: UNIQUE_CARD_LAST4,
      },
    });
    duplicateAccountA = await setupPrisma.bankAccount.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, institution: 'ITAU',
        nickname: 'Conta legada A', last4: DUPLICATE_BANK_LAST4, openingBalanceCents: 0,
      },
    });
    await setupPrisma.bankAccount.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, institution: 'BRADESCO',
        nickname: 'Conta legada B', last4: DUPLICATE_BANK_LAST4, openingBalanceCents: 0,
      },
    });
    uniqueAccount = await setupPrisma.bankAccount.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, institution: 'BB',
        nickname: 'Conta única', last4: UNIQUE_BANK_LAST4, openingBalanceCents: 0,
      },
    });

    service = new MonthlyOverviewService(prisma, new CardInvoiceSettlementService(prisma));
  });

  afterEach(cleanupTransient);

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  const payDto = (over: Record<string, unknown>) => ({
    month: DUE_MONTH,
    paymentDate: PAYMENT_DATE,
    ...over,
  });

  describe('payInvoice', () => {
    it('cartão legado ambíguo → 409 exato e ZERO writes', async () => {
      await openInvoice(DUPLICATE_CARD_LAST4, 30_000, 'compra-ambigua');
      const before = await financialSnapshot();

      const error = await captureError(() =>
        service.payInvoice(
          TENANT, PESSOAL,
          payDto({ cardLast4: DUPLICATE_CARD_LAST4, amountCents: 30_000, bankLast4: UNIQUE_BANK_LAST4 }),
          REQUESTER,
        ),
      );
      const after = await financialSnapshot();

      expect({ rejection: rejectionShape(error), state: after }).toEqual({
        rejection: {
          name: 'ConflictException',
          status: 409,
          message: 'Cartão ambíguo',
          body: { message: 'Cartão ambíguo', error: 'Conflict', statusCode: 409 },
        },
        state: before,
      });
      // A mensagem não conta QUANTAS duplicatas existem nem QUAIS são.
      expect(JSON.stringify(rejectionShape(error))).not.toContain(duplicateCardA.id);
      expect(JSON.stringify(rejectionShape(error))).not.toContain(duplicateCardB.id);
    });

    it('conta de débito legada ambígua → 409 exato e ZERO writes (cartão exato não salva o payload)', async () => {
      await openInvoice(UNIQUE_CARD_LAST4, 30_000, 'compra-conta-ambigua');
      const before = await financialSnapshot();

      const error = await captureError(() =>
        service.payInvoice(
          TENANT, PESSOAL,
          payDto({
            cardId: uniqueCard.id,
            cardLast4: UNIQUE_CARD_LAST4,
            amountCents: 30_000,
            bankLast4: DUPLICATE_BANK_LAST4,
          }),
          REQUESTER,
        ),
      );
      const after = await financialSnapshot();

      expect({ rejection: rejectionShape(error), state: after }).toEqual({
        rejection: {
          name: 'ConflictException',
          status: 409,
          message: 'Conta ambígua',
          body: { message: 'Conta ambígua', error: 'Conflict', statusCode: 409 },
        },
        state: before,
      });
      expect(JSON.stringify(rejectionShape(error))).not.toContain(duplicateAccountA.id);
    });

    it('last4 ÚNICO no legado continua pagando exatamente como antes (prova que não é 409 geral)', async () => {
      await openInvoice(UNIQUE_CARD_LAST4, 30_000, 'compra-unica');

      const result = await service.payInvoice(
        TENANT, PESSOAL,
        payDto({ cardLast4: UNIQUE_CARD_LAST4, amountCents: 30_000, bankLast4: UNIQUE_BANK_LAST4 }),
        REQUESTER,
      );

      expect(result).toMatchObject({
        ok: true,
        cardId: uniqueCard.id,
        cardLast4: UNIQUE_CARD_LAST4,
        accountId: uniqueAccount.id,
        month: DUE_MONTH,
        amountCents: 30_000,
      });
      const payments = await setupPrisma.expense.findMany({
        where: { tenantId: TENANT, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', deletedAt: null },
      });
      expect(payments).toHaveLength(1);
    });

    it('identidade EXATA (cardId + accountId) desambigua e paga, mesmo com o last4 duplicado', async () => {
      await openInvoice(DUPLICATE_CARD_LAST4, 30_000, 'compra-id-exato');

      const result = await service.payInvoice(
        TENANT, PESSOAL,
        payDto({
          cardId: duplicateCardB.id,
          amountCents: 30_000,
          accountId: duplicateAccountA.id,
        }),
        REQUESTER,
      );

      expect(result).toMatchObject({
        ok: true,
        cardId: duplicateCardB.id,
        cardLast4: DUPLICATE_CARD_LAST4,
        accountId: duplicateAccountA.id,
      });
    });
  });

  describe('undoInvoicePayment', () => {
    it('cartão legado ambíguo → 409 exato e ZERO writes', async () => {
      await openInvoice(DUPLICATE_CARD_LAST4, 30_000, 'compra-undo-ambigua');
      await service.payInvoice(
        TENANT, PESSOAL,
        payDto({ cardId: duplicateCardA.id, amountCents: 30_000, accountId: uniqueAccount.id }),
        REQUESTER,
      );
      const before = await financialSnapshot();

      const error = await captureError(() =>
        service.undoInvoicePayment(
          TENANT, PESSOAL,
          { cardLast4: DUPLICATE_CARD_LAST4, dueMonth: DUE_MONTH },
          REQUESTER,
        ),
      );
      const after = await financialSnapshot();

      expect({ rejection: rejectionShape(error), state: after }).toEqual({
        rejection: {
          name: 'ConflictException',
          status: 409,
          message: 'Cartão ambíguo',
          body: { message: 'Cartão ambíguo', error: 'Conflict', statusCode: 409 },
        },
        state: before,
      });
    });

    it('last4 ÚNICO continua desfazendo exatamente como antes', async () => {
      await openInvoice(UNIQUE_CARD_LAST4, 30_000, 'compra-undo-unica');
      await service.payInvoice(
        TENANT, PESSOAL,
        payDto({ cardLast4: UNIQUE_CARD_LAST4, amountCents: 30_000, bankLast4: UNIQUE_BANK_LAST4 }),
        REQUESTER,
      );

      const result = await service.undoInvoicePayment(
        TENANT, PESSOAL,
        { cardLast4: UNIQUE_CARD_LAST4, dueMonth: DUE_MONTH },
        REQUESTER,
      );

      expect(result).toMatchObject({ ok: true });
      const alive = await setupPrisma.expense.count({
        where: { tenantId: TENANT, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', deletedAt: null },
      });
      expect(alive).toBe(0);
    });
  });

  describe('capabilities emitidas pelo servidor', () => {
    it('last4 ambíguo: nenhuma linha oferece CTA e a fatura não emite cardId/fingerprint adivinhados', async () => {
      await openInvoice(DUPLICATE_CARD_LAST4, 30_000, 'compra-view-ambigua');
      await openInvoice(UNIQUE_CARD_LAST4, 20_000, 'compra-view-unica');

      const view = (await service.getAccountView(TENANT, PESSOAL, DUE_MONTH, REQUESTER)) as any;

      const ambiguos = view.cartoes.filter((c: any) => c.last4 === DUPLICATE_CARD_LAST4);
      expect(ambiguos).toHaveLength(2);
      for (const cartao of ambiguos) {
        // A UI não pode inventar CTA sobre uma fatura que o servidor recusaria.
        expect(cartao.actions).toEqual([]);
      }

      const unico = view.cartoes.find((c: any) => c.last4 === UNIQUE_CARD_LAST4);
      expect(unico.actions).toEqual(['pay']);
      expect(unico.cardId).toBe(uniqueCard.id);

      const faturaAmbigua = view.saidas.find(
        (s: any) => s.isInvoice && s.cardLast4 === DUPLICATE_CARD_LAST4,
      );
      expect(faturaAmbigua).toBeDefined();
      expect(faturaAmbigua.actions).toEqual([]);
      // O `cardId` da linha de fatura vinha de um Map por last4 — um chute entre
      // duplicatas. Emiti-lo deixaria um web novo furar o 409 mandando o id exato.
      expect(faturaAmbigua.cardId).toBeNull();
      expect(faturaAmbigua.fingerprint).toBeNull();

      const faturaUnica = view.saidas.find(
        (s: any) => s.isInvoice && s.cardLast4 === UNIQUE_CARD_LAST4,
      );
      expect(faturaUnica.actions).toEqual(['pay']);
      expect(faturaUnica.cardId).toBe(uniqueCard.id);
      expect(faturaUnica.fingerprint).toBe(`${uniqueCard.id}:${DUE_MONTH}`);
    });
  });

  describe('reautorização no servidor', () => {
    it('ação oferecida na leitura é recusada na execução quando o projeto sai da lente — zero writes', async () => {
      await openInvoice(UNIQUE_CARD_LAST4, 30_000, 'compra-reauth');

      const view = (await service.getAccountView(TENANT, PESSOAL, DUE_MONTH, SCOPED)) as any;
      const oferta = view.saidas.find((s: any) => s.isInvoice && s.cardLast4 === UNIQUE_CARD_LAST4);
      expect(oferta.actions).toEqual(['pay']);

      const before = await financialSnapshot();
      const error = await captureError(() =>
        service.payInvoice(
          TENANT, PESSOAL,
          payDto({ cardId: uniqueCard.id, amountCents: 30_000, accountId: uniqueAccount.id }),
          REVOKED,
        ),
      );
      const after = await financialSnapshot();

      expect(rejectionShape(error)).toMatchObject({
        name: 'ForbiddenException',
        status: 403,
      });
      expect(after).toEqual(before);
    });

    it('undo reautoriza igual: revogado entre a oferta e a execução não reverte nada', async () => {
      await openInvoice(UNIQUE_CARD_LAST4, 30_000, 'compra-reauth-undo');
      await service.payInvoice(
        TENANT, PESSOAL,
        payDto({ cardId: uniqueCard.id, amountCents: 30_000, accountId: uniqueAccount.id }),
        SCOPED,
      );
      const before = await financialSnapshot();

      const error = await captureError(() =>
        service.undoInvoicePayment(
          TENANT, PESSOAL,
          { cardId: uniqueCard.id, dueMonth: DUE_MONTH },
          REVOKED,
        ),
      );
      const after = await financialSnapshot();

      expect(rejectionShape(error)).toMatchObject({
        name: 'ForbiddenException',
        status: 403,
      });
      expect(after).toEqual(before);
    });
  });
});
