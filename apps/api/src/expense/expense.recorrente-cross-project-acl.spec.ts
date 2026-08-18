/**
 * Security phase 2 (verified blocker, 2026-08-18) — RED: `createRecorrente`'s
 * `dto.obraProjectId` (cross-project child, chega SÓ por body) não tem
 * NENHUM child ACL: hoje `createRecorrente` nem recebe/consulta um
 * `requester`, e o lookup do projeto de obra filtra só por `{id, tenantId,
 * deletedAt:null}` — um projeto de OUTRO tenant já cai fora por acidente (o
 * filtro `tenantId` já existia), mas um projeto do MESMO tenant fora do
 * `allowedProjects` do requester (hidden) passa livremente e a recorrência
 * cria o par canônica+espelho lá, vazando escrita para um projeto que o
 * requester não deveria nem enxergar.
 *
 * Contrato exigido (mesmo padrão de #448 B1a): hidden E cross-tenant devem
 * colapsar na MESMA mensagem/status já usado para "projeto de obra não
 * encontrado" (400, BadRequestException) — nunca reveal a diferença entre
 * "não existe"/"existe mas é de outro tenant"/"existe mas está fora do
 * scope". Zero writes em qualquer um dos dois casos negados (nem a canônica
 * na obra, nem o espelho no PESSOAL). In-scope continua funcionando
 * (controle).
 *
 * Prisma REAL (SQLite descartável) — sem mocks que espelhem a lógica do
 * service. Convenção de chamada: como `createRecorrente` ainda não declara o
 * parâmetro `requester`, cada chamada abaixo o passa como argumento EXTRA
 * via `(service as any)` — documenta a assinatura-alvo sem quebrar a
 * compilação; o argumento extra é hoje simplesmente ignorado pelo runtime, e
 * é isso que a asserção RED expõe.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { RateioRequester } from './rateio.types';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'erec-tenant';
const TENANT_OTHER = 'erec-tenant-other';
const PESSOAL = 'erec-pessoal';         // projeto de origem (:projectId da rota), sempre no scope
const ALLOWED = 'erec-allowed';         // outro projeto do MESMO tenant, no scope do requester
const HIDDEN = 'erec-hidden';           // outro projeto do MESMO tenant, FORA do scope do requester
const OTHER_TENANT_OBRA = 'erec-other-tenant-obra';

const MANAGED: RateioRequester = {
  role: 'USER',
  allowedProjects: [PESSOAL, ALLOWED],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses'],
};

async function cleanupTransient() {
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
}

async function cleanupAll() {
  await cleanupTransient();
  await setupPrisma.project.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
  await setupPrisma.tenant.deleteMany({ where: { id: { in: [TENANT, TENANT_OTHER] } } });
}

describe('ExpenseService.createRecorrente — child ACL do obraProjectId real DB (security phase 2)', () => {
  let service: ExpenseService;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupAll();

    await setupPrisma.tenant.createMany({
      data: [
        { id: TENANT, name: 'Recorrente ACL tenant' },
        { id: TENANT_OTHER, name: 'Recorrente ACL outro tenant' },
      ],
    });
    await setupPrisma.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal' },
        { id: ALLOWED, tenantId: TENANT, type: 'REFORMA', name: 'Reforma autorizada' },
        { id: HIDDEN, tenantId: TENANT, type: 'CASA', name: 'Casa oculta' },
        { id: OTHER_TENANT_OBRA, tenantId: TENANT_OTHER, type: 'REFORMA', name: 'Obra de outro tenant' },
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

  const baseDto = (obraProjectId: string) => ({
    tipoDespesa: 'MATERIAL_CONSTRUCAO',
    valor: 500,
    titulo: 'Aluguel de equipamento',
    frequencia: 'MENSAL',
    dataInicio: '2026-08-05',
    dataFim: '2026-08-05', // 1 única ocorrência — mais fácil de contar writes
    obraProjectId,
  });

  async function countExpenses() {
    return setupPrisma.expense.count({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
  }

  it('obraProjectId em projeto HIDDEN (mesmo tenant, fora do scope) → 400, zero despesas criadas', async () => {
    const before = await countExpenses();

    await expect(
      (service as any).createRecorrente(TENANT, PESSOAL, baseDto(HIDDEN), null, MANAGED),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(await countExpenses()).toBe(before);
    // Nenhuma despesa vazou para o projeto oculto especificamente.
    const hiddenCount = await setupPrisma.expense.count({ where: { tenantId: TENANT, projectId: HIDDEN } });
    expect(hiddenCount).toBe(0);
  });

  it('obraProjectId em OUTRO tenant → 400 com a MESMA mensagem do hidden (indistinguível), zero writes', async () => {
    let hiddenErr: unknown;
    let crossTenantErr: unknown;
    try {
      await (service as any).createRecorrente(TENANT, PESSOAL, baseDto(HIDDEN), null, MANAGED);
    } catch (e) { hiddenErr = e; }
    try {
      await (service as any).createRecorrente(TENANT, PESSOAL, baseDto(OTHER_TENANT_OBRA), null, MANAGED);
    } catch (e) { crossTenantErr = e; }

    expect(hiddenErr).toBeInstanceOf(BadRequestException);
    expect(crossTenantErr).toBeInstanceOf(BadRequestException);
    expect((hiddenErr as BadRequestException).message).toBe((crossTenantErr as BadRequestException).message);

    const crossTenantCount = await setupPrisma.expense.count({
      where: { tenantId: TENANT_OTHER, projectId: OTHER_TENANT_OBRA },
    });
    expect(crossTenantCount).toBe(0);
  });

  it('obraProjectId REALMENTE inexistente → 400 com a MESMA mensagem do hidden/cross-tenant (indistinguível)', async () => {
    let hiddenErr: unknown;
    let missingErr: unknown;
    try {
      await (service as any).createRecorrente(TENANT, PESSOAL, baseDto(HIDDEN), null, MANAGED);
    } catch (e) { hiddenErr = e; }
    try {
      await (service as any).createRecorrente(TENANT, PESSOAL, baseDto('does-not-exist-at-all'), null, MANAGED);
    } catch (e) { missingErr = e; }

    expect(hiddenErr).toBeInstanceOf(BadRequestException);
    expect(missingErr).toBeInstanceOf(BadRequestException);
    expect((hiddenErr as BadRequestException).message).toBe((missingErr as BadRequestException).message);
  });

  it('obraProjectId em projeto AUTORIZADO (allowed) → sucesso (controle): cria a canônica na obra + o espelho no PESSOAL', async () => {
    const result = await (service as any).createRecorrente(TENANT, PESSOAL, baseDto(ALLOWED), null, MANAGED);
    expect(result.count).toBe(1);
    expect(result.crossProject).toBe(true);

    const canonico = await setupPrisma.expense.count({ where: { tenantId: TENANT, projectId: ALLOWED } });
    const espelho = await setupPrisma.expense.count({ where: { tenantId: TENANT, projectId: PESSOAL } });
    expect(canonico).toBe(1);
    expect(espelho).toBe(1);
  });
});
