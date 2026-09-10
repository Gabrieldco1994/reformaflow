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

  it('injeção de settlesInvoiceDueMonth NÃO cunha m1 no create (produtor prefixa o last4 do cartão quitado)', async () => {
    await mintManualPayment(); // (re)semeia tenant + card 7070 + conta + 1 pagamento m1 legítimo
    // Chamada de SERVIÇO direta (sem ValidationPipe): o `create` retém o input cru,
    // mas o PRODUTOR compõe a chave como `{last4}:{settlesInvoiceDueMonth}` — o
    // resultado começa por `7070:`, NUNCA pelo prefixo reservado `m1:`. O atacante
    // não consegue cunhar um `m1:` real por esta rota.
    const created = await expenses.create(TENANT, PESSOAL, {
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
    } as never, REQ.id, undefined, REQ);
    const row = await setup.expense.findUnique({ where: { id: (created as { id: string }).id } });
    const key = (row as any)?.settlesInvoiceKey as string;
    // Resultado EXATO observado.
    expect(key).toBe(`7070:m1:${card.id}:7070:2026-10`);
    expect(key.startsWith('m1:')).toBe(false);
    expect(isManualInvoiceKey(key)).toBe(false);
    // Nenhuma chave NOVA com o prefixo reservado foi criada — só o mint legítimo.
    const all = await setup.expense.findMany({
      where: { tenantId: TENANT, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO' },
      select: { settlesInvoiceKey: true },
    });
    expect(all.filter((r) => (r.settlesInvoiceKey ?? '').startsWith('m1:'))).toHaveLength(1);
  });

  it('chave m1 MALFORMED continua protegida pela rota genérica (prefixo reservado, não o parse)', async () => {
    const id = await mintManualPayment();
    // Corrompe a identidade no banco descartável mantendo o PREFIXO reservado.
    await setup.expense.update({ where: { id }, data: { settlesInvoiceKey: 'm1:corrompido' } });
    expect(isManualInvoiceKey('m1:corrompido')).toBe(false); // parse ESTRITO recusa
    const before = await setup.expense.findUnique({ where: { id } });

    // Financeiro → 409 (prefixo reservado protege o m1 malformado), ZERO escrita.
    const patch = await cap(() => expenses.update(TENANT, PESSOAL, id, { valor: 500 } as never, REQ));
    expect((patch as any).status).toBe(409);
    expect((patch as any).msg).not.toMatch(/importa/i);
    expect(await setup.expense.findUnique({ where: { id } })).toEqual(before);

    // Remoção → 409, pagamento intacto.
    const rm = await cap(() => expenses.remove(TENANT, PESSOAL, id, REQ));
    expect((rm as any).status).toBe(409);
    expect((await setup.expense.findUnique({ where: { id } }) as any)?.deletedAt ?? null).toBeNull();

    // Descritivo (título) segue permitido.
    const desc = await cap(() => expenses.update(TENANT, PESSOAL, id, { titulo: 'ok desc' } as never, REQ));
    expect((desc as any).ok).toBeTruthy();
    expect((await setup.expense.findUnique({ where: { id } }) as any)?.titulo).toBe('ok desc');
  });
});
