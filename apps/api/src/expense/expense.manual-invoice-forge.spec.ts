// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isManualInvoiceKey, parseManualInvoiceKey } from '../common/manual-invoice-key';
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
 * #569 — INFORJABILIDADE do pagamento manual `m1` pela rota GENÉRICA de despesas.
 *
 * A chave `m1:{cardId}:{last4}:{dueMonth}` é cunhada SÓ pelo `payInvoice`. Pela
 * porta genérica (`ExpenseService`) ela não pode ser forjada (create), nem
 * limpa/re-associada/editada financeiramente/removida (update/remove) — a
 * reversão correta é o UNDO DO COCKPIT, nunca "desfaça a importação". Edições
 * puramente descritivas seguem livres.
 */

const TENANT = 'mii-forge-tenant';
const PESSOAL = 'mii-forge-pessoal';
const BANK = '9090';
const REQ: any = { ...pessoalRequester(PESSOAL), id: 'mii-forge-user' };

const setup = new PrismaClient();
const prisma = new PrismaService();

async function cap(run: () => Promise<unknown>) {
  try { return { ok: await run() }; }
  catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), msg: e.message };
    return { msg: (e as Error).message };
  }
}

describe('#569 — pagamento manual m1 é inforjável pela rota genérica de despesas', () => {
  let overview: ReturnType<typeof makeMonthlyOverviewService>;
  let expenses: ReturnType<typeof makeExpenseService>;
  let accountId: string;
  let card: { id: string; last4: string };

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

  async function mintManualPayment(): Promise<string> {
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PESSOAL });
    ({ id: accountId } = await seedBankAccount(setup, { tenantId: TENANT, projectId: PESSOAL, last4: BANK }));
    card = await seedCardWithClosingDue(setup, { tenantId: TENANT, projectId: PESSOAL, last4: '7070', closingDay: 25, dueDay: 10 });
    await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: '7070', parcelas: 1, valorCents: 10000,
      primeiraData: new Date('2026-09-05T00:00:00.000Z'),
    });
    const pay = await overview.payInvoice(
      TENANT, PESSOAL,
      { cardId: card.id, month: '2026-10', amountCents: 10000, accountId, bankLast4: BANK, paymentDate: '2026-09-06' },
      REQ,
    );
    const row = await setup.expense.findUnique({ where: { id: pay.paymentExpenseId } });
    expect(isManualInvoiceKey((row as any)?.settlesInvoiceKey)).toBe(true);
    return pay.paymentExpenseId;
  }

  it('update DESCRITIVO (título) é permitido; NÃO desassocia nem limpa a identidade', async () => {
    const id = await mintManualPayment();
    const res = await cap(() => expenses.update(TENANT, PESSOAL, id, { titulo: 'Renomeado' } as never, REQ));
    expect((res as any).ok).toBeTruthy();
    const row = await setup.expense.findUnique({ where: { id } });
    expect((row as any)?.titulo).toBe('Renomeado');
    expect(isManualInvoiceKey((row as any)?.settlesInvoiceKey)).toBe(true);
  });

  it.each([
    ['valor (financeiro)', { valor: 200 }],
    ['status', { status: 'PLANEJADO' }],
    ['tipoDespesa incompatível', { tipoDespesa: 'MATERIAL' }],
    ['re-associa conta (ownership)', { bankAccountId: null }],
    ['limpa a identidade (settlesInvoiceCardId:null)', { settlesInvoiceCardId: null }],
    ['forja outra fatura (settlesInvoiceDueMonth)', { settlesInvoiceDueMonth: '2026-11' }],
  ])('update que %s → 409 com mensagem de UNDO DO COCKPIT, sem tocar a identidade', async (_label, patch) => {
    const id = await mintManualPayment();
    const before = await setup.expense.findUnique({ where: { id } });
    const res = await cap(() => expenses.update(TENANT, PESSOAL, id, patch as never, REQ));
    expect((res as any).status).toBe(409);
    expect((res as any).msg).toMatch(/pagamento.*cockpit|cockpit/i);
    expect((res as any).msg).not.toMatch(/importa/i);
    const after = await setup.expense.findUnique({ where: { id } });
    expect(after).toEqual(before); // zero escrita
  });

  it('remove pela rota genérica → 409 (undo do cockpit), pagamento intacto', async () => {
    const id = await mintManualPayment();
    const res = await cap(() => expenses.remove(TENANT, PESSOAL, id, REQ));
    expect((res as any).status).toBe(409);
    expect((res as any).msg).not.toMatch(/importa/i);
    const row = await setup.expense.findUnique({ where: { id } });
    expect((row as any)?.deletedAt ?? null).toBeNull();
  });

  it('create pela rota genérica NÃO cunha m1: settles-invoice vira chave LEGADA de 2 partes (não elegível)', async () => {
    await mintManualPayment(); // (re)semeia tenant + card 7070 + conta
    const created = await expenses.create(TENANT, PESSOAL, {
      tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
      titulo: 'PIX quita fatura',
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
    const row = await setup.expense.findUnique({ where: { id: (created as { id: string }).id } });
    const key = (row as any)?.settlesInvoiceKey as string | null;
    expect(key).toBe('7070:2026-10'); // 2 partes, legado
    expect(isManualInvoiceKey(key)).toBe(false);
    expect(parseManualInvoiceKey(key)).toBeNull();
  });

  it('injeção de settlesInvoiceDueMonth com ":" não consegue forjar m1 no create (formato validado)', async () => {
    await mintManualPayment();
    // O DTO valida settlesInvoiceDueMonth como YYYY-MM; um valor com ":" é rejeitado
    // ANTES de compor a chave — mas mesmo se passasse, o produtor usa {last4}:{mês}.
    const res = await cap(() => expenses.create(TENANT, PESSOAL, {
      tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
      titulo: 'forja',
      valor: 100,
      quantidade: 1,
      formaPagamento: 'A_VISTA',
      status: 'PAGO',
      creditCardId: card.id,
      bankAccountId: accountId,
      settlesInvoiceCardId: card.id,
      settlesInvoiceDueMonth: `m1:${card.id}:7070:2026-10`,
    } as never, REQ.id, undefined, REQ));
    // Ou falha de validação, ou cria mas SEM chave m1.
    if ((res as any).ok) {
      const row = await setup.expense.findUnique({ where: { id: (res as any).ok.id } });
      expect(isManualInvoiceKey((row as any)?.settlesInvoiceKey)).toBe(false);
    } else {
      expect((res as any).status ?? 400).toBeGreaterThanOrEqual(400);
    }
  });
});
