// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  makeExpenseService,
  makeMonthlyOverviewService,
  pessoalRequester,
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedInstallmentPurchase,
  seedPessoal,
} from '../bank-account/__tests__/invoice-undo.fixtures';

/**
 * #569 — LOCK do contrato de IDENTIDADE do desfazer manual (revisão do architect
 * ao sanity da metadata; #569 requiredChecks §4).
 *
 * Reusar `settlesInvoiceKey = "{last4}:{dueMonth}"` (2 partes) como discriminador
 * do undo manual era SHAPE, não CONTRATO. A correção introduz o namespace
 * RESERVADO `m1:{cardId}:{cardLast4}:{dueMonth}`, cunhado SOMENTE pelo `payInvoice`
 * (proveniência do servidor), parseado estritamente por `common/manual-invoice-key.ts`:
 *
 *  - RED-A (buraco que a chave `m1` FECHA): uma despesa GERAL
 *    `PAGAMENTO_FATURA_CARTAO` com conta + `settlesInvoiceKey` LEGADO de 2 partes
 *    + sem import, criada pela rota comum de despesas (PIX/"quita fatura de outro
 *    cartão"), que NUNCA virou parcela, NÃO parseia como `m1` ⇒ nunca é oferecida
 *    com `undo` nem é apagável por `undoInvoicePayment`. Só o pagamento manual REAL
 *    do cockpit (chave `m1`) é elegível.
 *
 * Contrato (o que este teste EXIGE, INDEPENDENTE da implementação): uma declaração
 * geral de quitação NÃO é elegível ao undo do cockpit — nem CTA, nem apagamento.
 * As asserções abaixo não mudam com a abordagem escolhida.
 */

const TENANT = 'mii-guard-tenant';
const PESSOAL = 'mii-guard-pessoal';
const LAST4 = '3333';
const BANK = '9090';
const REQ: any = { ...pessoalRequester(PESSOAL), id: 'mii-guard-user' };

const setup = new PrismaClient();
const prisma = new PrismaService();

function shape(e: unknown) {
  if (e instanceof HttpException) return { name: e.constructor.name, status: e.getStatus(), msg: e.message };
  if (e) return { name: (e as Error).constructor.name, msg: (e as Error).message };
  return null;
}
async function cap(run: () => Promise<unknown>) {
  try { return { ok: await run() }; } catch (e) { return { err: shape(e) }; }
}

describe('#569 RED LOCK — identidade do undo manual (não SHAPE de settlesInvoiceKey)', () => {
  let overview: ReturnType<typeof makeMonthlyOverviewService>;
  let expenses: ReturnType<typeof makeExpenseService>;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    overview = makeMonthlyOverviewService(prisma);
    expenses = makeExpenseService(prisma);
  });
  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await setup.$disconnect();
  });

  it('RED-A: despesa GERAL settles-invoice (sem flip) NÃO pode ser oferecida/apagada pelo undo do cockpit', async () => {
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PESSOAL });
    const { id: accountId } = await seedBankAccount(setup, { tenantId: TENANT, projectId: PESSOAL, last4: BANK });
    const card = await seedCardWithClosingDue(setup, { tenantId: TENANT, projectId: PESSOAL, last4: LAST4, closingDay: 25, dueDay: 10 });
    // Compra PLANEJADO na fatura 2026-10 — NÃO liquidada por ninguém.
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: LAST4, parcelas: 1, valorCents: 10000,
      primeiraData: new Date('2026-09-05T00:00:00.000Z'),
    });

    // Declaração GERAL de quitação (mesma SHAPE do carimbo, SEM claim de flip),
    // criada pela rota de despesas suportada.
    const created = await expenses.create(TENANT, PESSOAL, {
      tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
      titulo: 'PIX quita fatura (declaração geral)',
      valor: 100,
      quantidade: 1,
      formaPagamento: 'A_VISTA',
      status: 'PAGO',
      dataPagamento: '2026-09-06',
      creditCardId: card.id,
      bankAccountId: accountId,
      settlesInvoiceCardId: card.id,
      settlesInvoiceDueMonth: '2026-10',
    } as never, REQ.id, undefined, REQ);
    const generalId = (created as { id: string }).id;

    // CONTRATO: o cockpit NÃO pode oferecer `undo` para essa declaração...
    const view = (await overview.getAccountView(TENANT, PESSOAL, '2026-10', REQ)) as any;
    const invoice = view.saidas.find((s: any) => s.isInvoice && s.cardLast4 === LAST4);
    expect(invoice?.actions ?? []).not.toContain('undo');

    // ...nem apagá-la por `undoInvoicePayment`; a parcela nunca virou.
    const undo = await cap(() => overview.undoInvoicePayment(TENANT, PESSOAL, { cardId: card.id, dueMonth: '2026-10' }, REQ));
    expect((undo as any).ok).toBeUndefined(); // deve REJEITAR (404), não desfazer nada
    const after = await setup.expense.findUnique({ where: { id: generalId } });
    expect((after as any)?.deletedAt ?? null).toBeNull(); // declaração intacta
    const parcela = await setup.cashFlowEntry.findUnique({ where: { id: purchase.entryIds[0] } });
    expect((parcela as any)?.status).toBe('PLANEJADO');
  });
});
