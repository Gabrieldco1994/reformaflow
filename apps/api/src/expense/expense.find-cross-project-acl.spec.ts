/**
 * Security phase 2 (verified blocker, 2026-08-18) — RED: `findCrossProject`
 * (listagem "Vincular a outro projeto") não tem NENHUM child ACL: hoje o
 * método nem recebe/consulta um `requester` — filtra só por `tenantId`, então
 * QUALQUER despesa de QUALQUER projeto do tenant (inclusive um projeto fora
 * do `allowedProjects` do requester) aparece na lista, com título/fornecedor/
 * projectId/nome do projeto — um vazamento direto de metadata cross-project
 * para um requester restrito.
 *
 * Contrato exigido (mesmo padrão de #448 B1a): um requester restrito só pode
 * ver despesas de projetos na sua lente (`allowedProjects`/
 * `allowedProjectTypes`); hidden/cross-tenant NUNCA aparecem, mesmo com
 * `targetProjectId` explícito apontando pra lá (retorna `[]`, não 403/404 —
 * não confirma nem nega a existência do projeto ao requester); ADMIN continua
 * vendo tudo e requester ausente falha fechado.
 *
 * Mutation-mindset extra: a filtragem por scope tem que acontecer ANTES/
 * JUNTO do `take: limit` (no WHERE, não como um `.filter()` em JS depois de
 * já ter buscado e truncado `limit` linhas) — senão despesas ocultas mais
 * recentes "roubam" vagas do resultado e um requester restrito vê MENOS
 * itens visíveis do que deveria, mesmo havendo itens autorizados de sobra.
 *
 * Prisma REAL (SQLite descartável) — sem mocks que espelhem a lógica do
 * service. Convenção de chamada: como `findCrossProject` ainda não declara o
 * parâmetro `requester`, cada chamada abaixo o passa como argumento EXTRA
 * via `(service as any)` — documenta a assinatura-alvo sem quebrar a
 * compilação; o argumento extra é hoje simplesmente ignorado pelo runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { RateioRequester } from './rateio.types';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'efcp-tenant';
const TENANT_OTHER = 'efcp-tenant-other';
const PESSOAL = 'efcp-pessoal';       // :projectId da rota (sempre excluído do resultado, comportamento existente)
const ALLOWED = 'efcp-allowed';       // outro projeto do MESMO tenant, no scope
const HIDDEN = 'efcp-hidden';         // outro projeto do MESMO tenant, FORA do scope
const OTHER_TENANT_PROJECT = 'efcp-other-tenant-project';

const MANAGED: RateioRequester = {
  role: 'USER',
  allowedProjects: [PESSOAL, ALLOWED],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses'],
};
const ADMIN: RateioRequester = { role: 'ADMIN', allowedProjects: [], allowedProjectTypes: [], allowedModules: [] };

async function cleanupTransient() {
  await setupPrisma.expense.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
}

async function cleanupAll() {
  await cleanupTransient();
  await setupPrisma.project.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
  await setupPrisma.tenant.deleteMany({ where: { id: { in: [TENANT, TENANT_OTHER] } } });
}

const T0 = new Date('2026-08-01T12:00:00.000Z');

function expenseData(over: Record<string, unknown>): any {
  return {
    tenantId: TENANT,
    tipoDespesa: 'MATERIAL_CONSTRUCAO',
    valor: 10_000,
    quantidade: 1,
    valorTotal: 10_000,
    titulo: 'Item',
    formaPagamento: 'A_VISTA',
    status: 'PLANEJADO',
    ...over,
  };
}

describe('ExpenseService.findCrossProject — child ACL real DB (security phase 2)', () => {
  let service: ExpenseService;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupAll();

    await setupPrisma.tenant.createMany({
      data: [
        { id: TENANT, name: 'FindCrossProject ACL tenant' },
        { id: TENANT_OTHER, name: 'FindCrossProject ACL outro tenant' },
      ],
    });
    await setupPrisma.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal' },
        { id: ALLOWED, tenantId: TENANT, type: 'REFORMA', name: 'Reforma autorizada' },
        { id: HIDDEN, tenantId: TENANT, type: 'CASA', name: 'Casa oculta' },
        { id: OTHER_TENANT_PROJECT, tenantId: TENANT_OTHER, type: 'PESSOAL', name: 'Pessoal outro tenant' },
      ],
    });

    service = new ExpenseService(prisma, new ConciliacaoService(prisma));
  });

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  afterEach(async () => {
    await cleanupTransient();
  });

  it('requester restrito (MANAGED) só recebe despesas de projetos visíveis — hidden e cross-tenant nunca aparecem', async () => {
    await setupPrisma.expense.create({ data: expenseData({ projectId: ALLOWED, titulo: 'allowed-1' }) });
    await setupPrisma.expense.create({ data: expenseData({ projectId: HIDDEN, titulo: 'hidden-1' }) });
    await setupPrisma.expense.create({
      data: expenseData({ tenantId: TENANT_OTHER, projectId: OTHER_TENANT_PROJECT, titulo: 'other-tenant-1' }),
    });

    const results: any[] = await (service as any).findCrossProject(TENANT, PESSOAL, {}, MANAGED);

    expect(results.some((r: any) => r.titulo === 'allowed-1')).toBe(true);
    expect(results.some((r: any) => r.titulo === 'hidden-1')).toBe(false);
    expect(results.some((r: any) => r.titulo === 'other-tenant-1')).toBe(false);
    expect(results.every((r: any) => r.projectId !== HIDDEN)).toBe(true);
    expect(results.every((r: any) => r.tenantId !== TENANT_OTHER)).toBe(true);
  });

  it('targetProjectId=HIDDEN explícito → [] (nunca 403/404 — não confirma nem nega a existência do projeto)', async () => {
    await setupPrisma.expense.create({ data: expenseData({ projectId: HIDDEN, titulo: 'hidden-explicit' }) });

    const results: any[] = await (service as any).findCrossProject(
      TENANT, PESSOAL, { projectId: HIDDEN }, MANAGED,
    );
    expect(results).toEqual([]);
  });

  it('ADMIN (full-access) continua vendo despesas de QUALQUER projeto do tenant — comportamento inalterado (controle)', async () => {
    await setupPrisma.expense.create({ data: expenseData({ projectId: ALLOWED, titulo: 'admin-allowed' }) });
    await setupPrisma.expense.create({ data: expenseData({ projectId: HIDDEN, titulo: 'admin-hidden' }) });

    const results: any[] = await (service as any).findCrossProject(TENANT, PESSOAL, {}, ADMIN);
    expect(results.some((r: any) => r.titulo === 'admin-allowed')).toBe(true);
    expect(results.some((r: any) => r.titulo === 'admin-hidden')).toBe(true);
  });

  it('sem requester falha fechado em vez de assumir acesso total', async () => {
    await setupPrisma.expense.create({ data: expenseData({ projectId: HIDDEN, titulo: 'legacy-hidden' }) });
    const results: any[] = await service.findCrossProject(TENANT, PESSOAL, {});
    expect(results).toEqual([]);
  });

  it('filtragem por scope acontece ANTES/JUNTO do limit — despesas hidden mais recentes não "roubam" vagas de despesas allowed', async () => {
    // 5 despesas HIDDEN, mais recentes (createdAt crescente) — se a
    // filtragem por scope rodasse DEPOIS de um `take: limit` cru, elas
    // ocupariam as top-N vagas do orderBy(createdAt desc) e derrubariam as
    // allowed do resultado.
    for (let i = 0; i < 5; i++) {
      await setupPrisma.expense.create({
        data: expenseData({
          projectId: HIDDEN,
          titulo: `hidden-recent-${i}`,
          createdAt: new Date(T0.getTime() + (10 + i) * 1000),
        }),
      });
    }
    // 2 despesas ALLOWED, mais antigas.
    await setupPrisma.expense.create({
      data: expenseData({ projectId: ALLOWED, titulo: 'allowed-old-1', createdAt: new Date(T0.getTime()) }),
    });
    await setupPrisma.expense.create({
      data: expenseData({ projectId: ALLOWED, titulo: 'allowed-old-2', createdAt: new Date(T0.getTime() + 1000) }),
    });

    const results: any[] = await (service as any).findCrossProject(
      TENANT, PESSOAL, { limit: 3 }, MANAGED,
    );

    // As 2 despesas allowed (as ÚNICAS visíveis) devem estar TODAS presentes
    // — nenhuma vaga do limit=3 foi consumida por uma hidden mais recente.
    expect(results).toHaveLength(2);
    expect(results.map((r: any) => r.titulo).sort()).toEqual(['allowed-old-1', 'allowed-old-2']);
    expect(results.every((r: any) => r.projectId === ALLOWED)).toBe(true);
  });
});
