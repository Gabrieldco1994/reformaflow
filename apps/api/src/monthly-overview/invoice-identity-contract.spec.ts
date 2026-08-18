/**
 * B1a (#448) — identidade aditiva (`cardId`/`accountId`/`dueMonth`) nas
 * mutações de fatura (`payInvoice`/`undoInvoicePayment`) e na leitura da Visão
 * Conta, coexistindo com o legado (`cardLast4`/`bankLast4`). Autorado RED
 * contra o baseline pré-#448; GREEN após a implementação — mantido como
 * regression lock, agora chamando `payInvoice`/`undoInvoicePayment` com o DTO
 * REAL (sem cast `as any`): a implementação passou a declarar `cardId`/
 * `accountId` no tipo do body.
 *
 * Contrato (issue #448, B1a):
 *  - "IDs/actions/fingerprint aditivos (cardId/accountId/dueMonth) coexistem
 *    com o legado; nenhuma rota existente quebra."
 *  - "Settlement é project-scoped (nunca tenant+last4 amplo)."
 *  - "Last4 legado permanece determinístico — comportamento antigo intocado
 *    neste PR."
 *  - Fingerprint calculado, sem coluna: `${cardId}:${dueMonth}` — NUNCA
 *    contém last4/PAN.
 *
 * No baseline pré-#448, `payInvoice`/`undoInvoicePayment` só conheciam
 * `cardLast4`/`bankLast4` — não existia `cardId`/`accountId` no DTO, não
 * existia checagem de ID+last4-mismatch, e a Visão Conta não emitia
 * `cardId`/`fingerprint`/`actions` nenhum. Prisma REAL, sem mocks (evita
 * reimplementar `buildCardInvoiceAggregates` num harness que provaria a
 * suposição, não o comportamento).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { MonthlyOverviewService, MonthlyOverviewMutationRequester } from './monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'invid-tenant';
const PROJECT = 'invid-pessoal';
const DUE_MONTH = '2026-08';
const PURCHASE_DATE = new Date('2026-08-05T12:00:00.000Z');

const REQUESTER: MonthlyOverviewMutationRequester = { id: 'invid-user', role: 'ADMIN' };

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

describe('MonthlyOverviewService — identidade aditiva cardId/accountId/fingerprint (#448 B1a)', () => {
  let service: MonthlyOverviewService;
  let cardA: { id: string; last4: string };
  let cardB: { id: string; last4: string };
  let account: { id: string; last4: string };

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupAll();

    await setupPrisma.tenant.create({ data: { id: TENANT, name: 'Invoice identity tenant' } });
    await setupPrisma.project.create({ data: { id: PROJECT, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal' } });
    // closingDay/dueDay nulos: dueMonth cai na competência da compra (sem
    // aritmética de fechamento a coordenar no teste).
    cardA = await setupPrisma.creditCard.create({
      data: { tenantId: TENANT, projectId: PROJECT, institution: 'ITAU', brand: 'Visa', nickname: 'Cartão A', last4: '1111' },
    });
    cardB = await setupPrisma.creditCard.create({
      data: { tenantId: TENANT, projectId: PROJECT, institution: 'NUBANK', brand: 'Mastercard', nickname: 'Cartão B', last4: '2222' },
    });
    account = await setupPrisma.bankAccount.create({
      data: { tenantId: TENANT, projectId: PROJECT, institution: 'ITAU', nickname: 'Conta', last4: '9999', openingBalanceCents: 0 },
    });

    service = new MonthlyOverviewService(prisma, new CardInvoiceSettlementService(prisma));
  });

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  afterEach(async () => {
    await cleanupTransient();
  });

  /** Abre uma fatura de `card` no DUE_MONTH: 1 compra DESPESA de `amountCents`. */
  async function openInvoice(card: { id: string; last4: string }, amountCents: number, titulo: string) {
    const purchase = await setupPrisma.expense.create({
      data: {
        tenantId: TENANT, projectId: PROJECT, tipoDespesa: 'ALIMENTACAO', titulo,
        valor: amountCents, quantidade: 1, valorTotal: amountCents, formaPagamento: 'A_VISTA',
        dataPagamento: PURCHASE_DATE, status: 'PAGO', cardLast4: card.last4, origin: 'import',
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        tenantId: TENANT, projectId: PROJECT, expenseId: purchase.id, valor: amountCents,
        tipo: 'DESPESA', categoria: 'Alimentação', formaPagamento: 'CARTAO_CREDITO',
        data: PURCHASE_DATE, status: 'PAGO',
      },
    });
    return purchase;
  }

  const payDto = (over: Record<string, unknown>) => ({
    month: DUE_MONTH,
    bankLast4: account.last4,
    paymentDate: '2026-08-10',
    ...over,
  });

  describe('payInvoice — identidade', () => {
    it('cardId aponta para um cartão DIFERENTE do cardLast4 informado → 400, zero writes (mismatch)', async () => {
      await openInvoice(cardA, 30_000, 'compra-a');

      await expect(
        service.payInvoice(
          TENANT, PROJECT,
          payDto({ cardId: cardB.id, cardLast4: cardA.last4, amountCents: 30_000 }),
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const payments = await setupPrisma.expense.count({
        where: { tenantId: TENANT, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO' },
      });
      expect(payments).toBe(0);
    });

    it('legado (somente cardLast4, sem cardId) continua funcionando — comportamento antigo intocado (controle)', async () => {
      await openInvoice(cardA, 30_000, 'compra-a-legado');

      const result = await service.payInvoice(
        TENANT, PROJECT, payDto({ cardLast4: cardA.last4, amountCents: 30_000 }), REQUESTER,
      );
      expect(result.ok).toBe(true);
      expect(result.cardLast4).toBe(cardA.last4);
    });
  });

  describe('undoInvoicePayment — identidade', () => {
    it('cardId aponta para um cartão DIFERENTE do cardLast4 informado → 400, zero writes (mismatch)', async () => {
      await openInvoice(cardA, 30_000, 'compra-a-undo');
      await service.payInvoice(TENANT, PROJECT, payDto({ cardLast4: cardA.last4, amountCents: 30_000 }), REQUESTER);

      await expect(
        service.undoInvoicePayment(
          TENANT, PROJECT,
          { cardId: cardB.id, cardLast4: cardA.last4, dueMonth: DUE_MONTH },
          REQUESTER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const stillPaid = await setupPrisma.expense.findFirst({
        where: { tenantId: TENANT, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', deletedAt: null },
      });
      expect(stillPaid).not.toBeNull();
    });
  });

  describe('getAccountView — IDs/fingerprint na Visão Conta', () => {
    it('a fatura paga emite cardId exato (não só cardLast4)', async () => {
      await openInvoice(cardA, 30_000, 'compra-a-view');
      await service.payInvoice(TENANT, PROJECT, payDto({ cardLast4: cardA.last4, amountCents: 30_000 }), REQUESTER);

      const view = await service.getAccountView(TENANT, PROJECT, DUE_MONTH, REQUESTER);
      const invoiceRow = (view as any).saidas.find((s: any) => s.isInvoice && s.cardLast4 === cardA.last4);
      expect(invoiceRow).toBeDefined();
      expect(invoiceRow.cardId).toBe(cardA.id);
    });

    it('fingerprint da fatura é exatamente `${cardId}:${dueMonth}` e não contém last4/PAN', async () => {
      await openInvoice(cardA, 30_000, 'compra-a-fp');
      await service.payInvoice(TENANT, PROJECT, payDto({ cardLast4: cardA.last4, amountCents: 30_000 }), REQUESTER);

      const view = await service.getAccountView(TENANT, PROJECT, DUE_MONTH, REQUESTER);
      const invoiceRow = (view as any).saidas.find((s: any) => s.isInvoice && s.cardLast4 === cardA.last4);
      expect(invoiceRow).toBeDefined();
      expect(invoiceRow.fingerprint).toBe(`${cardA.id}:${DUE_MONTH}`);
      expect(String(invoiceRow.fingerprint ?? '')).not.toContain(cardA.last4);
    });

    it('actions é fornecido pelo servidor: fatura QUITADA (pending=0) expõe SÓ "undo", nunca "pay" (executável exato)', async () => {
      await openInvoice(cardA, 30_000, 'compra-a-actions');
      await service.payInvoice(TENANT, PROJECT, payDto({ cardLast4: cardA.last4, amountCents: 30_000 }), REQUESTER);

      const view = await service.getAccountView(TENANT, PROJECT, DUE_MONTH, REQUESTER);
      const invoiceRow = (view as any).saidas.find((s: any) => s.isInvoice && s.cardLast4 === cardA.last4);
      expect(invoiceRow).toBeDefined();
      expect(invoiceRow.editavel).toBe(true);
      expect(invoiceRow.invoicePaidAmount).toBe(30_000); // pending=0 — nada a "pay"
      // Igualdade EXATA (não só toContain): pega mutações que sempre incluem
      // 'pay' independente do saldo, ou que sempre retornam [] / [ambos].
      expect(invoiceRow.actions).toEqual(['undo']);
    });

    it('actions omite "undo" e expõe SÓ "pay" quando não há pagamento implícito a desfazer (fatura ainda aberta, saldo pendente)', async () => {
      await openInvoice(cardA, 15_000, 'compra-a-actions-aberta');

      const view = await service.getAccountView(TENANT, PROJECT, DUE_MONTH, REQUESTER);
      const invoiceRow = (view as any).saidas.find((s: any) => s.isInvoice && s.cardLast4 === cardA.last4);
      expect(invoiceRow).toBeDefined();
      expect(invoiceRow.editavel).toBe(false);
      expect(invoiceRow.invoicePaidAmount).toBe(0);
      // Igualdade EXATA: uma mutação que sempre retorna `actions: []` passaria
      // no antigo `not.toContain('undo')` mesmo omitindo 'pay' indevidamente.
      expect(invoiceRow.actions).toEqual(['pay']);
    });
  });

  describe('getAccountView — cartoes[] (resumo por cartão): MESMOS campos aditivos, computados por um caminho INDEPENDENTE de saidas[]', () => {
    // `cartoes[]` (resumo do cartão) e `saidas[].isInvoice` (linha de fatura no
    // extrato) são dois `cards.map(...)`/`selectedInvoices.map(...)` SEPARADOS
    // no service — cada um calcula seu próprio `actions`/`fingerprint`. Uma
    // mutação pode quebrar um sem quebrar o outro; os testes acima só cobrem
    // `saidas[]` — estes cobrem `cartoes[]` explicitamente.
    it('cartoes[] emite cardId/fingerprint exatos para o cartão pago', async () => {
      await openInvoice(cardA, 30_000, 'compra-a-cartoes-view');
      await service.payInvoice(TENANT, PROJECT, payDto({ cardLast4: cardA.last4, amountCents: 30_000 }), REQUESTER);

      const view = await service.getAccountView(TENANT, PROJECT, DUE_MONTH, REQUESTER);
      const cartaoA = (view as any).cartoes.find((c: any) => c.last4 === cardA.last4);
      expect(cartaoA).toBeDefined();
      expect(cartaoA.cardId).toBe(cardA.id);
      expect(cartaoA.fingerprint).toBe(`${cardA.id}:${DUE_MONTH}`);
      expect(String(cartaoA.fingerprint ?? '')).not.toContain(cardA.last4);
    });

    it('cartoes[] actions exato: fatura QUITADA expõe SÓ "undo"; fatura ABERTA expõe SÓ "pay"', async () => {
      await openInvoice(cardA, 30_000, 'compra-a-cartoes-quitada');
      await service.payInvoice(TENANT, PROJECT, payDto({ cardLast4: cardA.last4, amountCents: 30_000 }), REQUESTER);
      await openInvoice(cardB, 15_000, 'compra-b-cartoes-aberta');

      const view = await service.getAccountView(TENANT, PROJECT, DUE_MONTH, REQUESTER);
      const cartaoA = (view as any).cartoes.find((c: any) => c.last4 === cardA.last4);
      const cartaoB = (view as any).cartoes.find((c: any) => c.last4 === cardB.last4);
      expect(cartaoA.status).toBe('paga');
      expect(cartaoA.actions).toEqual(['undo']);
      expect(cartaoB.status).toBe('a pagar');
      expect(cartaoB.actions).toEqual(['pay']);
    });
  });
});
