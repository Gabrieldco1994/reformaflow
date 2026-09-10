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
 * #569 — RED LOCK do contrato de IDENTIDADE do desfazer manual (revisão do
 * architect ao sanity da metadata; #569 requiredChecks §4).
 *
 * PROVA EXECUTÁVEL de que reusar `settlesInvoiceKey = "{last4}:{dueMonth}"` como
 * discriminador do NOVO caminho de undo é SHAPE, não CONTRATO:
 *
 *  - RED-A (buraco NOVO, introduzido pelo ramo explícito por chave): uma despesa
 *    GERAL `PAGAMENTO_FATURA_CARTAO` com conta + `settlesInvoiceKey` + sem import,
 *    criada pela rota comum de despesas (PIX/"quita fatura de outro cartão"), que
 *    NUNCA virou parcela (sem claim de liquidação), é oferecida com `undo` e é
 *    APAGADA por `undoInvoicePayment`. O caminho LEGADO (`settlesInvoiceKey: null`)
 *    nunca alcançava linhas com chave — logo isto é regressão do ramo novo.
 *
 * Contrato correto (o que este teste EXIGE): só um pagamento manual REAL de
 * `payInvoice` (com claim de liquidação/flip) é elegível ao undo do cockpit; uma
 * declaração geral de quitação NÃO é apagável por essa rota. Amarrar isso exige
 * a identidade dedicada (`invoiceUndo*`, id ESTÁVEL de cartão) — cujo produtor/
 * guarda vivem em `expense.service.ts` (fora do escopo deste degrau) — ou um
 * campo novo (schema). Enquanto a decisão de contrato não for tomada, este LOCK
 * fica VERMELHO de propósito e barra o merge do atalho por shape.
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
