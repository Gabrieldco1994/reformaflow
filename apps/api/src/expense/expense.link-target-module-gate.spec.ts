/**
 * #484 D — gêmeos divergentes para o MESMO recurso.
 *
 * `ConciliacaoService.canRequesterSeeProject` foi apertado em #480 para
 * `userCanAccessProjectModule(..., EXPENSE_MODULE)`, enquanto o gêmeo em
 * `ExpenseService` continuava em `userCanAccessProjectType` — que responde
 * "esse usuário enxerga esse TIPO?" e aceita QUALQUER módulo não-universal do
 * tipo. Os dois autorizam o mesmo recurso (alvo Expense de vínculo/quitação),
 * então precisam do MESMO predicado.
 *
 * Fresta alcançável hoje: PLANTAS é o único tipo SEM o módulo `expenses`. Um
 * requester que chega em PLANTAS por `plantsAi` passava no gate de tipo do
 * `ExpenseService` e vinculava/descobria uma despesa daquele projeto —
 * enquanto a mesma despesa, pelo caminho da conciliação, já era negada.
 *
 * Prisma REAL (SQLite descartável), sem mock que espelhe a lógica do service.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExpenseService } from './expense.service';
import type { RateioRequester } from './rateio.types';

const setup = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'qa484-twin-tenant';
const PESSOAL = 'qa484-twin-pessoal';
const PLANTAS = 'qa484-twin-plantas';
const REFORMA = 'qa484-twin-reforma';
const SOURCE = 'qa484-twin-source';
const PLANTAS_TARGET = 'qa484-twin-plantas-target';
const REFORMA_TARGET = 'qa484-twin-reforma-target';

/**
 * Alcança PLANTAS por `plantsAi` (tipo SEM `expenses`) e PESSOAL/REFORMA por
 * `expenses`. `allowedProjectTypes: []` é o legado "sem restrição por tipo".
 */
const PLANTS_MODULE_REQUESTER: RateioRequester = {
  role: 'USER',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: ['expenses', 'plantsAi'],
};

const OWNER: RateioRequester = {
  role: 'OWNER',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

describe('Expense × Conciliação: mesmo predicado para o mesmo recurso (#484 D)', () => {
  const conciliacao = new ConciliacaoService(prisma);
  const service = new ExpenseService(prisma, conciliacao);

  async function cleanupAll(): Promise<void> {
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.project.deleteMany({ where: { tenantId: TENANT } });
    await setup.tenant.deleteMany({ where: { id: TENANT } });
  }

  async function createExpense(id: string, projectId: string, titulo: string) {
    await setup.expense.create({
      data: {
        id,
        tenantId: TENANT,
        projectId,
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        titulo,
        valor: 10_000,
        quantidade: 1,
        valorTotal: 10_000,
        formaPagamento: 'A_VISTA',
        status: 'PLANEJADO',
      },
    });
  }

  async function linkedTargetOfSource(): Promise<string | null> {
    const row = await setup.expense.findUnique({
      where: { id: SOURCE },
      select: { linkedExpenseId: true },
    });
    return row?.linkedExpenseId ?? null;
  }

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setup.tenant.create({ data: { id: TENANT, name: 'QA 484 gêmeos' } });
    await setup.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal QA 484 gêmeos' },
        { id: PLANTAS, tenantId: TENANT, type: 'PLANTAS', name: 'Plantas QA 484 gêmeos' },
        { id: REFORMA, tenantId: TENANT, type: 'REFORMA', name: 'Obra QA 484 gêmeos' },
      ],
    });
    await createExpense(SOURCE, PESSOAL, 'Despesa fonte');
    await createExpense(PLANTAS_TARGET, PLANTAS, 'Alvo em PLANTAS');
    await createExpense(REFORMA_TARGET, REFORMA, 'Alvo em REFORMA');
  });

  afterAll(async () => {
    await cleanupAll();
    await setup.$disconnect();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await setup.expense.update({
      where: { id: SOURCE },
      data: { linkedExpenseId: null },
    });
  });

  it('recusa o alvo alcançado por módulo não relacionado (`plantsAi`) no vínculo cross-project', async () => {
    const error = await captureError(() =>
      service.linkCrossProject(
        TENANT,
        PESSOAL,
        SOURCE,
        PLANTAS_TARGET,
        PLANTS_MODULE_REQUESTER,
      ),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe('Despesa alvo não encontrada');
    expect(await linkedTargetOfSource()).toBeNull();
  });

  it('recusa o MESMO alvo pelo gêmeo da conciliação (os dois gates concordam)', async () => {
    const error = await captureError(() =>
      conciliacao.assertCanSettleTargets(
        prisma as never,
        { tenantId: TENANT, targetExpenseIds: [PLANTAS_TARGET] },
        PLANTS_MODULE_REQUESTER,
      ),
    );

    expect(error).toBeInstanceOf(NotFoundException);
  });

  it('mantém o vínculo para um alvo cujo tipo TEM o módulo do recurso', async () => {
    await service.linkCrossProject(
      TENANT,
      PESSOAL,
      SOURCE,
      REFORMA_TARGET,
      PLANTS_MODULE_REQUESTER,
    );

    expect(await linkedTargetOfSource()).toBe(REFORMA_TARGET);
    await expect(
      conciliacao.assertCanSettleTargets(
        prisma as never,
        { tenantId: TENANT, targetExpenseIds: [REFORMA_TARGET] },
        PLANTS_MODULE_REQUESTER,
      ),
    ).resolves.toBeDefined();
  });

  it('mantém OWNER irrestrito no mesmo tenant', async () => {
    await service.linkCrossProject(TENANT, PESSOAL, SOURCE, PLANTAS_TARGET, OWNER);

    expect(await linkedTargetOfSource()).toBe(PLANTAS_TARGET);
  });

  /**
   * O seletor que ALIMENTA o vínculo é o mesmo recurso: se o alvo em PLANTAS
   * é recusado no link, ele também não pode aparecer na lista cross-project —
   * senão o gate vira uma CTA que erra depois de clicada.
   */
  it('não lista o alvo de tipo sem `expenses` no seletor cross-project', async () => {
    const rows = await service.findCrossProject(
      TENANT,
      PESSOAL,
      {},
      PLANTS_MODULE_REQUESTER,
    );

    expect(rows.map((row) => row.id)).toEqual([REFORMA_TARGET]);
    expect(JSON.stringify(rows)).not.toContain('Alvo em PLANTAS');
  });

  it('mantém o seletor cross-project completo para OWNER', async () => {
    const rows = await service.findCrossProject(TENANT, PESSOAL, {}, OWNER);

    expect(rows.map((row) => row.id).sort()).toEqual(
      [PLANTAS_TARGET, REFORMA_TARGET].sort(),
    );
  });
});
