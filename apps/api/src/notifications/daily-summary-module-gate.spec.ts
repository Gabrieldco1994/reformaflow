/**
 * #484 C — `/notifications/daily-summary` não tinha NENHUM gate de módulo.
 *
 * O endpoint agrega SEIS famílias de recurso (cash flow de despesa, cash flow
 * de recebimento, cronograma, contas recorrentes, lembretes e manutenções) e
 * resolvia UM escopo sem `requiredModule`: quem alcançava o projeto por
 * QUALQUER módulo do tipo levava junto `titulo`/`tipoDespesa` da despesa e o
 * valor do recebimento de todo projeto do escopo.
 *
 * Contrato exigido: cada recurso é escopado pelo SEU módulo dono. Um
 * `@RequireModule` de rota não serve aqui — o guard exige TODOS os slugs
 * declarados (semântica E), e o sino de notificações é global: quem tem só
 * `reminders` continuaria precisando ver o seu lembrete. Um módulo nunca
 * entrega as linhas do outro, e a resposta de quem não tem o módulo é
 * deep-equal à de um tenant que genuinamente não tem aquele recurso.
 *
 * Prisma REAL (SQLite descartável), sem mock que espelhe a lógica do service.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';

const setup = new PrismaClient();
const prisma = new PrismaService();

const CLOCK = new Date('2026-08-19T15:00:00.000Z');

const TENANT = 'qa484-notif-tenant';
const PESSOAL = 'qa484-notif-pessoal';
const CASA = 'qa484-notif-casa';

const EXPENSE = 'qa484-notif-expense';
const EXPENSE_CASH = 'qa484-notif-expense-cash';
const RECEIPT = 'qa484-notif-receipt';
const RECEIPT_CASH = 'qa484-notif-receipt-cash';
const REMINDER = 'qa484-notif-reminder';
const BILL = 'qa484-notif-bill';

const EXPENSE_TITLE = 'Despesa do dia SENTINELA';
const EXPENSE_TYPE = 'MATERIAL_CONSTRUCAO';
const RECEIPT_CATEGORY = 'PAGAMENTO';
const REMINDER_TITLE = 'Lembrete do dia SENTINELA';
const BILL_TITLE = 'Conta recorrente SENTINELA';

interface Requester {
  role: string;
  allowedProjects?: string[];
  allowedProjectTypes?: string[];
  allowedModules?: string[];
}

/**
 * `allowedProjectTypes: []` é o legado "sem restrição por tipo": os tipos saem
 * dos MÓDULOS. Cada requester abaixo alcança o projeto por um módulo e não
 * pode levar o recurso do outro.
 */
function requester(modules: string[]): Requester {
  return {
    role: 'USER',
    allowedProjects: [],
    allowedProjectTypes: [],
    allowedModules: modules,
  };
}

const RECEIPTS_ONLY = requester(['receipts']);
const EXPENSES_ONLY = requester(['expenses']);
const REMINDERS_ONLY = requester(['reminders']);
const EXPENSES_AND_RECEIPTS = requester(['expenses', 'receipts']);
const OWNER: Requester = {
  role: 'OWNER',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

describe('/notifications/daily-summary module gate (#484 C)', () => {
  const controller = new NotificationsController(
    new NotificationsService(prisma),
    prisma,
  );

  async function cleanupAll(): Promise<void> {
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.receipt.deleteMany({ where: { tenantId: TENANT } });
    await setup.reminder.deleteMany({ where: { tenantId: TENANT } });
    await setup.recurringBill.deleteMany({ where: { tenantId: TENANT } });
    await setup.project.deleteMany({ where: { tenantId: TENANT } });
    await setup.tenant.deleteMany({ where: { id: TENANT } });
  }

  async function setExpenseCashActive(active: boolean): Promise<void> {
    await setup.cashFlowEntry.update({
      where: { id: EXPENSE_CASH },
      data: { deletedAt: active ? null : CLOCK },
    });
  }

  async function setReceiptCashActive(active: boolean): Promise<void> {
    await setup.cashFlowEntry.update({
      where: { id: RECEIPT_CASH },
      data: { deletedAt: active ? null : CLOCK },
    });
  }

  function summary(user: Requester) {
    return controller.getDailySummary(TENANT, user as never);
  }

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'setInterval',
        'setTimeout',
      ],
    });
    jest.setSystemTime(CLOCK);
    await setup.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setup.tenant.create({ data: { id: TENANT, name: 'QA 484 notificações' } });
    await setup.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal QA 484 notif' },
        { id: CASA, tenantId: TENANT, type: 'CASA', name: 'Casa QA 484 notif' },
      ],
    });
    await setup.expense.create({
      data: {
        id: EXPENSE,
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: EXPENSE_TYPE,
        titulo: EXPENSE_TITLE,
        valor: 12_345,
        quantidade: 1,
        valorTotal: 12_345,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
        dataPagamento: CLOCK,
      },
    });
    await setup.receipt.create({
      data: {
        id: RECEIPT,
        tenantId: TENANT,
        projectId: PESSOAL,
        valor: 54_321,
        data: CLOCK,
        tipo: RECEIPT_CATEGORY,
        status: 'EM_CAIXA',
        descricao: 'Recebimento do dia',
      },
    });
    await setup.cashFlowEntry.createMany({
      data: [
        {
          id: EXPENSE_CASH,
          tenantId: TENANT,
          projectId: PESSOAL,
          expenseId: EXPENSE,
          valor: 12_345,
          tipo: 'DESPESA',
          data: CLOCK,
          categoria: EXPENSE_TYPE,
          status: 'PAGO',
        },
        {
          id: RECEIPT_CASH,
          tenantId: TENANT,
          projectId: PESSOAL,
          receiptId: RECEIPT,
          valor: 54_321,
          tipo: 'RECEBIMENTO',
          data: CLOCK,
          categoria: RECEIPT_CATEGORY,
          status: 'EM_CAIXA',
        },
      ],
    });
    await setup.reminder.create({
      data: {
        id: REMINDER,
        tenantId: TENANT,
        projectId: CASA,
        titulo: REMINDER_TITLE,
        data: CLOCK,
        status: 'PENDENTE',
        prioridade: 'ALTA',
      },
    });
    await setup.recurringBill.create({
      data: {
        id: BILL,
        tenantId: TENANT,
        projectId: CASA,
        nome: BILL_TITLE,
        valor: 9_900,
        categoria: 'LUZ',
        diaVencimento: 19,
        status: 'ATIVO',
        proximoVencimento: CLOCK,
      },
    });
  });

  afterAll(async () => {
    jest.useRealTimers();
    await cleanupAll();
    await setup.$disconnect();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await setExpenseCashActive(true);
    await setReceiptCashActive(true);
  });

  it('não entrega despesa a quem só tem `receipts` — nem título, nem tipo, nem total', async () => {
    const denied = await summary(RECEIPTS_ONLY);

    expect(JSON.stringify(denied)).not.toContain(EXPENSE_TITLE);
    expect(JSON.stringify(denied)).not.toContain(EXPENSE_TYPE);
    expect(denied.hoje.gastos).toEqual({ total: 0, count: 0, items: [] });

    // Controle de indistinguibilidade: o MESMO payload, para quem TEM
    // `expenses`, num tenant onde a despesa do dia genuinamente não existe.
    await setExpenseCashActive(false);
    const genuinelyEmpty = await summary(EXPENSES_AND_RECEIPTS);
    expect(denied).toEqual(genuinelyEmpty);
  });

  it('mantém o recebimento para o mesmo requester de `receipts`', async () => {
    const allowed = await summary(RECEIPTS_ONLY);

    expect(allowed.hoje.recebimentos.items.map((item) => item.id)).toEqual([
      RECEIPT_CASH,
    ]);
    expect(allowed.hoje.recebimentos.total).toBe(54_321);
  });

  it('não entrega recebimento a quem só tem `expenses` (e entrega a despesa)', async () => {
    const denied = await summary(EXPENSES_ONLY);

    expect(denied.hoje.recebimentos).toEqual({ total: 0, count: 0, items: [] });
    expect(denied.hoje.gastos.items.map((item) => item.titulo)).toEqual([
      EXPENSE_TITLE,
    ]);

    await setReceiptCashActive(false);
    const genuinelyEmpty = await summary(EXPENSES_AND_RECEIPTS);
    expect(denied).toEqual(genuinelyEmpty);
  });

  it('escopa lembrete e conta recorrente por módulos distintos', async () => {
    const remindersOnly = await summary(REMINDERS_ONLY);

    expect(remindersOnly.hoje.vencendoHoje.map((item) => item.titulo)).toEqual([
      REMINDER_TITLE,
    ]);
    expect(JSON.stringify(remindersOnly)).not.toContain(BILL_TITLE);
    expect(JSON.stringify(remindersOnly)).not.toContain(EXPENSE_TITLE);
    expect(remindersOnly.hoje.gastos.count).toBe(0);
    expect(remindersOnly.hoje.recebimentos.count).toBe(0);
  });

  it('mantém OWNER irrestrito no mesmo tenant', async () => {
    const owner = await summary(OWNER);

    expect(owner.hoje.gastos.items.map((item) => item.titulo)).toEqual([
      EXPENSE_TITLE,
    ]);
    expect(owner.hoje.recebimentos.items.map((item) => item.id)).toEqual([
      RECEIPT_CASH,
    ]);
    expect(owner.hoje.vencendoHoje.map((item) => item.titulo).sort()).toEqual(
      [BILL_TITLE, REMINDER_TITLE].sort(),
    );
  });
});
