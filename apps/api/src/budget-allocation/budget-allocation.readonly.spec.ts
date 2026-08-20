/**
 * #449 B2b — Budget Allocation congelado em modo administrativo read-only.
 *
 * Três contratos, todos verificados contra Prisma REAL (SQLite descartável):
 *
 * 1. NENHUMA escrita sobrevive — para papel nenhum. Não basta esconder o botão:
 *    a rota mutável deixa de existir e o método de escrita sai do service. Isso
 *    fecha, por construção, a fabricação de relação cross-tenant que o `PATCH`
 *    permitia (gravava `dto.targetProjectId` sem validar tenant, ao contrário do
 *    `create`).
 * 2. LEITURA só para requisitante full-access (ADMIN|OWNER) autenticado e
 *    NÃO-CONVIDADO. `@Roles('ADMIN')` não serve de gate: `auth.service` cria
 *    convidado de demo com `role: 'ADMIN', isGuest: true` e `roles.guard`
 *    aprova por `isFullAccessRole` sem nunca ler `isGuest` (#497). Daí o
 *    `!isGuest` explícito.
 * 3. RELAÇÃO LEGADA CROSS-TENANT é REDIGIDA NA RESPOSTA e PRESERVADA NO BANCO.
 *    O `include` do Prisma resolve por FK e não carrega filtro de tenant, então
 *    os quatro sites (findAll, findOne e os DOIS branches de getSummary) vazavam
 *    nome/tipo de projeto e recebimento de outro tenant. Redigir ≠ apagar:
 *    o histórico continua byte a byte igual (checksum antes/depois).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { ExecutionContext, ForbiddenException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BudgetAllocationAdminGuard } from './budget-allocation-admin.guard';
import { BudgetAllocationController } from './budget-allocation.controller';
import { BudgetAllocationService, type RequestUser } from './budget-allocation.service';

const setup = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'b2-449-tenant';
const OTHER_TENANT = 'b2-449-other-tenant';

const PESSOAL = 'b2-449-pessoal';
const REFORMA = 'b2-449-reforma';
const ALIEN_PROJECT = 'b2-449-alien-project';

const RECEIPT = 'b2-449-receipt';
const ALIEN_RECEIPT = 'b2-449-alien-receipt';

const ALLOC_SAME = 'b2-449-alloc-same';
const ALLOC_ALIEN_TARGET = 'b2-449-alloc-alien-target';
const ALLOC_ALIEN_SOURCE = 'b2-449-alloc-alien-source';
const ALLOC_DELETED = 'b2-449-alloc-deleted';

const CFE_SAME = 'b2-449-cfe-same';
const CFE_ALIEN = 'b2-449-cfe-alien';

/** Nomes/valores que NUNCA podem aparecer na resposta do tenant dono. */
const ALIEN_PROJECT_NAME = 'Projeto de Outro Tenant';
const ALIEN_RECEIPT_VALOR = 777_777;

const RECEIPT_VALOR = 5_000_000; // R$ 50.000,00 EM_CAIXA no PESSOAL
const VALOR_SAME = 2_000_000; // R$ 20.000,00
const VALOR_ALIEN_TARGET = 150_000; // R$ 1.500,00
const VALOR_ALIEN_SOURCE = 100_000; // R$ 1.000,00
const VALOR_DELETED = 900_000; // R$ 9.000,00 (soft-deleted: fora de toda leitura)
const VALOR_CFE_ALIEN = 999_999;

const ADMIN: RequestUser = {
  role: 'ADMIN',
  isGuest: false,
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};
const GUEST_ADMIN: RequestUser = { ...ADMIN, isGuest: true };
const USER_RESTRICTED: RequestUser = {
  role: 'USER',
  isGuest: false,
  allowedProjects: [REFORMA],
  allowedProjectTypes: [],
  allowedModules: ['dashboard', 'receipts', 'expenses'],
};
const USER_BOTH_PROJECTS: RequestUser = {
  ...USER_RESTRICTED,
  allowedProjects: [PESSOAL, REFORMA],
};
const OWNER: RequestUser = { ...ADMIN, role: 'OWNER' };
const GUEST_OWNER: RequestUser = { ...OWNER, isGuest: true };

function contextFor(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

describe('#449 B2b — Budget Allocation administrativo read-only', () => {
  const service = new BudgetAllocationService(prisma);
  const guard = new BudgetAllocationAdminGuard();

  async function cleanupAll(): Promise<void> {
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: { in: [TENANT, OTHER_TENANT] } } });
    await setup.budgetAllocation.deleteMany({
      where: { tenantId: { in: [TENANT, OTHER_TENANT] } },
    });
    await setup.receipt.deleteMany({ where: { tenantId: { in: [TENANT, OTHER_TENANT] } } });
    await setup.project.deleteMany({ where: { tenantId: { in: [TENANT, OTHER_TENANT] } } });
    await setup.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER_TENANT] } } });
  }

  /** Fotografia byte a byte das linhas históricas do tenant (via SQL cru). */
  async function historicalRows(): Promise<string> {
    const allocations = await setup.$queryRawUnsafe(
      'SELECT * FROM budget_allocations WHERE tenant_id = ? ORDER BY id',
      TENANT,
    );
    const entries = await setup.$queryRawUnsafe(
      'SELECT * FROM cash_flow_entries WHERE tenant_id IN (?, ?) ORDER BY id',
      TENANT,
      OTHER_TENANT,
    );
    return JSON.stringify({ allocations, entries });
  }

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await cleanupAll();

    await setup.tenant.createMany({
      data: [
        { id: TENANT, name: 'Tenant dono do histórico' },
        { id: OTHER_TENANT, name: 'Tenant vizinho' },
      ],
    });
    await setup.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: 'PESSOAL', name: 'Vida Financeira' },
        { id: REFORMA, tenantId: TENANT, type: 'REFORMA', name: 'Obra do Apê' },
        {
          id: ALIEN_PROJECT,
          tenantId: OTHER_TENANT,
          type: 'REFORMA',
          name: ALIEN_PROJECT_NAME,
        },
      ],
    });
    await setup.receipt.createMany({
      data: [
        {
          id: RECEIPT,
          tenantId: TENANT,
          projectId: PESSOAL,
          valor: RECEIPT_VALOR,
          data: new Date('2026-05-01T00:00:00.000Z'),
          tipo: 'PAGAMENTO',
          status: 'EM_CAIXA',
        },
        {
          id: ALIEN_RECEIPT,
          tenantId: OTHER_TENANT,
          projectId: ALIEN_PROJECT,
          valor: ALIEN_RECEIPT_VALOR,
          data: new Date('2026-05-01T00:00:00.000Z'),
          tipo: 'PAGAMENTO',
          status: 'EM_CAIXA',
        },
      ],
    });
    // Todas as alocações pertencem ao TENANT: o legado cross-tenant está nas
    // RELAÇÕES (source/target/receipt apontando para o vizinho), não na linha.
    await setup.budgetAllocation.createMany({
      data: [
        {
          id: ALLOC_SAME,
          tenantId: TENANT,
          sourceProjectId: PESSOAL,
          targetProjectId: REFORMA,
          sourceReceiptId: RECEIPT,
          valor: VALOR_SAME,
          descricao: 'Alocação legítima',
          mes: '2026-05',
          dataAlocacao: new Date('2026-05-03T00:00:00.000Z'),
        },
        {
          id: ALLOC_ALIEN_TARGET,
          tenantId: TENANT,
          sourceProjectId: PESSOAL,
          targetProjectId: ALIEN_PROJECT,
          sourceReceiptId: ALIEN_RECEIPT,
          valor: VALOR_ALIEN_TARGET,
          descricao: 'Legado com alvo de outro tenant',
          mes: '2026-05',
          dataAlocacao: new Date('2026-05-02T00:00:00.000Z'),
        },
        {
          id: ALLOC_ALIEN_SOURCE,
          tenantId: TENANT,
          sourceProjectId: ALIEN_PROJECT,
          targetProjectId: REFORMA,
          valor: VALOR_ALIEN_SOURCE,
          descricao: 'Legado com origem de outro tenant',
          mes: '2026-05',
          dataAlocacao: new Date('2026-05-01T00:00:00.000Z'),
        },
        {
          id: ALLOC_DELETED,
          tenantId: TENANT,
          sourceProjectId: PESSOAL,
          targetProjectId: REFORMA,
          valor: VALOR_DELETED,
          descricao: 'Alocação removida em 2026-05',
          mes: '2026-05',
          dataAlocacao: new Date('2026-05-04T00:00:00.000Z'),
          deletedAt: new Date('2026-05-05T00:00:00.000Z'),
        },
      ],
    });
    await setup.cashFlowEntry.createMany({
      data: [
        {
          id: CFE_SAME,
          tenantId: TENANT,
          projectId: REFORMA,
          budgetAllocationId: ALLOC_SAME,
          valor: VALOR_SAME,
          tipo: 'RECEBIMENTO',
          categoria: 'ALOCACAO_ORCAMENTO',
          status: 'EM_CAIXA',
          data: new Date('2026-05-01T00:00:00.000Z'),
        },
        {
          id: CFE_ALIEN,
          tenantId: OTHER_TENANT,
          projectId: ALIEN_PROJECT,
          budgetAllocationId: ALLOC_SAME,
          valor: VALOR_CFE_ALIEN,
          tipo: 'RECEBIMENTO',
          categoria: 'ALOCACAO_ORCAMENTO',
          status: 'EM_CAIXA',
          data: new Date('2026-05-01T00:00:00.000Z'),
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanupAll();
    await setup.$disconnect();
    await prisma.$disconnect();
  });

  describe('1. escrita congelada para TODO papel', () => {
    it('não registra nenhuma rota mutável (POST/PATCH/DELETE) no controller', () => {
      const proto = BudgetAllocationController.prototype as unknown as Record<string, unknown>;
      const handlers = Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor');
      const verbs = handlers.map((name) => ({
        name,
        method: Reflect.getMetadata(METHOD_METADATA, proto[name] as object),
      }));

      expect(verbs.length).toBeGreaterThan(0);
      for (const verb of verbs) {
        expect({ handler: verb.name, method: verb.method }).toEqual({
          handler: verb.name,
          method: RequestMethod.GET,
        });
      }
    });

    it('não expõe método de escrita no service (create/update/remove)', () => {
      const surface = service as unknown as Record<string, unknown>;
      expect(surface.create).toBeUndefined();
      expect(surface.update).toBeUndefined();
      expect(surface.remove).toBeUndefined();
    });
  });

  describe('2. leitura só para papel full-access autenticado e não-convidado (403)', () => {
    it('deixa passar ADMIN não-convidado', () => {
      expect(guard.canActivate(contextFor(ADMIN))).toBe(true);
    });

    it('deixa passar OWNER: o dono do tenant lê o próprio histórico congelado', () => {
      // B2 é read-only COM histórico preservado. Se o dono do tenant não
      // alcança o histórico, para ele o histórico não foi preservado — foi
      // sumido. `isFullAccessRole` (ADMIN|OWNER) é a convenção da casa.
      expect(guard.canActivate(contextFor(OWNER))).toBe(true);
    });

    it('recusa USER com 403 (Budget é administrativo)', () => {
      expect(() => guard.canActivate(contextFor(USER_RESTRICTED))).toThrow(ForbiddenException);
    });

    it('recusa convidado de demo mesmo com role ADMIN (#497)', () => {
      expect(() => guard.canActivate(contextFor(GUEST_ADMIN))).toThrow(ForbiddenException);
    });

    it('recusa convidado mesmo que algum fluxo o crie como OWNER (#497)', () => {
      expect(() => guard.canActivate(contextFor(GUEST_OWNER))).toThrow(ForbiddenException);
    });

    it('recusa requisição sem usuário autenticado', () => {
      expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
    });
  });

  describe('3. relações legadas cross-tenant redigidas (4 sites)', () => {
    it('findAll: redige alvo, origem e recebimento de outro tenant', async () => {
      const rows = await service.findAll(TENANT, {}, ADMIN);

      expect(rows.map((row) => row.id)).toEqual([
        ALLOC_SAME,
        ALLOC_ALIEN_TARGET,
        ALLOC_ALIEN_SOURCE,
      ]);

      const same = rows[0];
      expect(same.valor).toBe(VALOR_SAME);
      expect(same.sourceProject).toEqual({ id: PESSOAL, name: 'Vida Financeira', type: 'PESSOAL' });
      expect(same.targetProject).toEqual({ id: REFORMA, name: 'Obra do Apê', type: 'REFORMA' });
      expect(same.sourceReceipt).toEqual({
        id: RECEIPT,
        valor: RECEIPT_VALOR,
        tipo: 'PAGAMENTO',
        data: new Date('2026-05-01T00:00:00.000Z'),
      });

      const alienTarget = rows[1];
      expect(alienTarget.valor).toBe(VALOR_ALIEN_TARGET);
      expect(alienTarget.targetProject).toBeNull();
      expect(alienTarget.sourceReceipt).toBeNull();
      expect(alienTarget.sourceProject).not.toBeNull();

      const alienSource = rows[2];
      expect(alienSource.valor).toBe(VALOR_ALIEN_SOURCE);
      expect(alienSource.sourceProject).toBeNull();
      expect(alienSource.targetProject).not.toBeNull();

      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(ALIEN_PROJECT_NAME);
      expect(serialized).not.toContain(OTHER_TENANT);
      expect(serialized).not.toContain(String(ALIEN_RECEIPT_VALOR));

      // Decisão explícita: o ESCALAR da FK legada é preservado, só o CONTEÚDO da
      // relação é redigido. Um cuid opaco não é "recurso exposto" (toda outra
      // rota é escopada por tenant), e é o que permite ao ADMIN reconciliar o
      // histórico. Zerar o escalar seria transformar a linha na resposta —
      // exatamente o que B2 promete não fazer.
      expect(alienTarget.targetProjectId).toBe(ALIEN_PROJECT);
      expect(alienTarget.sourceReceiptId).toBe(ALIEN_RECEIPT);
      expect(alienSource.sourceProjectId).toBe(ALIEN_PROJECT);
    });

    it('findOne: redige relações e filtra cash flow de outro tenant', async () => {
      const alienTarget = await service.findOne(ALLOC_ALIEN_TARGET, TENANT, ADMIN);
      expect(alienTarget.targetProject).toBeNull();
      expect(alienTarget.sourceReceipt).toBeNull();
      expect(JSON.stringify(alienTarget)).not.toContain(ALIEN_PROJECT_NAME);

      const same = await service.findOne(ALLOC_SAME, TENANT, ADMIN);
      expect(same.cashFlowEntries.map((entry) => entry.id)).toEqual([CFE_SAME]);
      expect(JSON.stringify(same)).not.toContain(String(VALOR_CFE_ALIEN));
    });

    it('getSummary (branch PESSOAL): preserva o total e redige a identidade do alvo', async () => {
      const summary = (await service.getSummary(PESSOAL, TENANT)) as {
        totalAllocated: number;
        available: number;
        totalExpenses: number;
        totalReceipts: number;
        allocations: Array<{
          projectId: string | null;
          projectName: string | null;
          projectType: string | null;
          total: number;
        }>;
      };

      // Centavo nenhum se move: o valor alocado continua sendo do tenant dono.
      expect(summary.totalAllocated).toBe(VALOR_SAME + VALOR_ALIEN_TARGET);
      expect(summary.totalReceipts).toBe(RECEIPT_VALOR);
      expect(summary.available).toBe(RECEIPT_VALOR - VALOR_SAME - VALOR_ALIEN_TARGET);

      const own = summary.allocations.find((row) => row.projectId === REFORMA);
      expect(own).toEqual({
        projectId: REFORMA,
        projectName: 'Obra do Apê',
        projectType: 'REFORMA',
        total: VALOR_SAME,
      });

      const redacted = summary.allocations.find((row) => row.projectId === null);
      expect(redacted).toEqual({
        projectId: null,
        projectName: null,
        projectType: null,
        total: VALOR_ALIEN_TARGET,
      });

      // Soma das linhas continua batendo com o total (nada some do dinheiro).
      expect(summary.allocations.reduce((sum, row) => sum + row.total, 0)).toBe(
        summary.totalAllocated,
      );
      expect(JSON.stringify(summary)).not.toContain(ALIEN_PROJECT_NAME);
    });

    it('getSummary (branch não-PESSOAL): preserva o total e redige a origem', async () => {
      const summary = (await service.getSummary(REFORMA, TENANT)) as {
        totalReceived: number;
        totalSpent: number;
        remaining: number;
        allocations: Array<{
          id: string;
          valor: number;
          sourceProject: { id: string; name: string; type: string } | null;
        }>;
      };

      expect(summary.totalReceived).toBe(VALOR_SAME + VALOR_ALIEN_SOURCE);

      const same = summary.allocations.find((row) => row.id === ALLOC_SAME);
      expect(same?.sourceProject).toEqual({
        id: PESSOAL,
        name: 'Vida Financeira',
        type: 'PESSOAL',
      });

      const alien = summary.allocations.find((row) => row.id === ALLOC_ALIEN_SOURCE);
      expect(alien).toBeDefined();
      expect(alien?.valor).toBe(VALOR_ALIEN_SOURCE);
      expect(alien?.sourceProject).toBeNull();

      expect(JSON.stringify(summary)).not.toContain(ALIEN_PROJECT_NAME);
    });

    it('as linhas legadas continuam no banco depois de toda leitura redigida', async () => {
      const alienTarget = await setup.budgetAllocation.findUnique({
        where: { id: ALLOC_ALIEN_TARGET },
      });
      expect(alienTarget?.targetProjectId).toBe(ALIEN_PROJECT);
      expect(alienTarget?.sourceReceiptId).toBe(ALIEN_RECEIPT);
      expect(alienTarget?.deletedAt).toBeNull();

      const alienSource = await setup.budgetAllocation.findUnique({
        where: { id: ALLOC_ALIEN_SOURCE },
      });
      expect(alienSource?.sourceProjectId).toBe(ALIEN_PROJECT);

      const alienEntry = await setup.cashFlowEntry.findUnique({ where: { id: CFE_ALIEN } });
      expect(alienEntry?.valor).toBe(VALOR_CFE_ALIEN);
      expect(alienEntry?.deletedAt).toBeNull();
    });
  });

  describe('4. findAll escopado pelo ACL do requisitante', () => {
    it('ADMIN vê o histórico inteiro do tenant', async () => {
      const rows = await service.findAll(TENANT, {}, ADMIN);
      expect(rows).toHaveLength(3);
    });

    it('OWNER enxerga exatamente o mesmo histórico que o ADMIN', async () => {
      const admin = await service.findAll(TENANT, {}, ADMIN);
      const owner = await service.findAll(TENANT, {}, OWNER);
      expect(JSON.stringify(owner)).toBe(JSON.stringify(admin));
    });

    it('requisitante restrito a um projeto não lista alocação de projeto fora do escopo', async () => {
      const rows = await service.findAll(TENANT, {}, USER_RESTRICTED);
      expect(rows).toEqual([]);
    });

    it('requisitante com origem e alvo no escopo vê só a alocação inteiramente sua', async () => {
      const rows = await service.findAll(TENANT, {}, USER_BOTH_PROJECTS);
      expect(rows.map((row) => row.id)).toEqual([ALLOC_SAME]);
    });

    it('sem requisitante não devolve o tenant inteiro (fail-closed)', async () => {
      const rows = await service.findAll(TENANT, {});
      expect(rows).toEqual([]);
    });

    it('findOne também é fail-closed sem requisitante (a rota `:id` não tem guard de projeto)', async () => {
      const error = await captureError(() => service.findOne(ALLOC_SAME, TENANT));
      expect(error).toBeInstanceOf(ForbiddenException);
    });

    it('findOne recusa alocação cujo projeto está fora do escopo do requisitante', async () => {
      const error = await captureError(() =>
        service.findOne(ALLOC_SAME, TENANT, USER_RESTRICTED),
      );
      expect(error).toBeInstanceOf(ForbiddenException);
    });
  });

  describe('5. histórico byte-equivalente', () => {
    it('um ciclo completo de leitura não altera um byte das linhas históricas', async () => {
      const before = await historicalRows();

      await service.findAll(TENANT, {}, ADMIN);
      await service.findAll(TENANT, { mes: '2026-05' }, ADMIN);
      await service.findOne(ALLOC_SAME, TENANT, ADMIN);
      await service.findOne(ALLOC_ALIEN_TARGET, TENANT, ADMIN);
      await service.findOne(ALLOC_ALIEN_SOURCE, TENANT, ADMIN);
      await service.getSummary(PESSOAL, TENANT);
      await service.getSummary(REFORMA, TENANT);
      await service.calculateAvailableBudget(PESSOAL, TENANT);

      const after = await historicalRows();
      expect(after).toBe(before);

      // A linha soft-deletada segue fora das leituras E dentro do banco.
      const deleted = await setup.budgetAllocation.findUnique({ where: { id: ALLOC_DELETED } });
      expect(deleted?.valor).toBe(VALOR_DELETED);
      expect(deleted?.deletedAt).not.toBeNull();
      expect(await setup.budgetAllocation.count({ where: { tenantId: TENANT } })).toBe(4);
    });

    it('leitura de alocação inexistente não vaza existência de linha de outro tenant', async () => {
      const error = await captureError(() => service.findOne(ALLOC_SAME, OTHER_TENANT, ADMIN));
      expect(error).not.toBeNull();
      expect((error as Error).message).toBe('Budget allocation not found');
    });
  });
});
