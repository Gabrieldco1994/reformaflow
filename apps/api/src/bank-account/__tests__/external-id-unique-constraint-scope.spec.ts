/**
 * #570 (Fase 2) — a unique constraint física para `externalId` precisa
 * fazer a MESMA pergunta que o dedupe de aplicação já faz hoje
 * (`findExistingExternalIds` em bank-account.service.ts e
 * credit-card.service.ts): "já existe ESTE externalId NESTE PROJETO?",
 * não "já existe em QUALQUER projeto deste tenant?".
 *
 * Achado do PO (antes da migration rodar): a constraint originalmente
 * proposta era `(tenant_id, external_id)` — tenant inteiro. O dedupe de
 * aplicação sempre filtrou por `project_id` também. Se o mesmo
 * `externalId` existisse em dois projetos do mesmo tenant, a aplicação
 * diria "pode inserir" e o banco devolveria P2002 — o mesmo formato de
 * erro duro do incidente #586, por um índice físico desalinhado da
 * lógica de aplicação.
 *
 * Hoje (0 casos em produção, verificado) isso é inatingível: `externalId`
 * é hash semeado com `accountId`/`cardId`, e cada conta pertence a um
 * projeto só. Mas "seguro por coincidência de construção" não é rede —
 * este teste materializa o cenário direto no modelo de dados (dois
 * projetos do mesmo tenant, mesmo `externalId`) para prová-lo
 * independente de como o hash é montado hoje.
 *
 * DECISÃO (rota b, ver relato final do agente): a constraint física foi
 * escopada por `(tenantId, projectId, externalId)` — não
 * `(tenantId, externalId)` — replicando exatamente o que
 * `findExistingExternalIds` já verifica. Efeito:
 *   - MESMO externalId em projetos DIFERENTES do mesmo tenant: cada
 *     inserção é permitida (não é duplicata para a regra de negócio
 *     atual — é o mesmo extrato importado, por engano ou não, em dois
 *     projetos distintos; hoje isso já criaria duas despesas).
 *   - MESMO externalId no MESMO projeto: a 2ª inserção é rejeitada pelo
 *     banco (P2002), reforçando em profundidade o que o dedupe de
 *     aplicação já impede antes de chegar aqui.
 *
 * Antes da migration rodar (schema sem a unique constraint), a segunda
 * asserção de rejeição (mesmo projeto) falha — RED documentando a
 * lacuna. Depois da migration (rota b aplicada), o arquivo inteiro fica
 * verde.
 */
// O guard do banco de teste precisa carregar ANTES de qualquer import do Prisma.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../../scripts/test-db-env.cjs');

import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'ba570f2-tenant';
const PROJECT_A = 'ba570f2-project-a';
const PROJECT_B = 'ba570f2-project-b';

async function cleanup() {
  await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.receipt.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

describe('Unique constraint (tenantId, projectId, externalId) — #570 Fase 2', () => {
  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanup();
    await setupPrisma.tenant.create({ data: { id: TENANT, name: 'Dedupe scope tenant' } });
    await setupPrisma.project.create({
      data: { id: PROJECT_A, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal A' },
    });
    await setupPrisma.project.create({
      data: { id: PROJECT_B, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal B' },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  afterEach(async () => {
    await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.receipt.deleteMany({ where: { tenantId: TENANT } });
  });

  function expenseData(projectId: string, externalId: string) {
    return {
      tenantId: TENANT,
      projectId,
      tipoDespesa: 'OUTROS',
      valor: 10000,
      quantidade: 1,
      valorTotal: 10000,
      formaPagamento: 'A_VISTA',
      externalId,
    };
  }

  function receiptData(projectId: string, externalId: string) {
    return {
      tenantId: TENANT,
      projectId,
      valor: 10000,
      data: new Date('2026-07-15'),
      tipo: 'OUTROS',
      externalId,
    };
  }

  it('MESMO externalId, MESMO tenant, projetos DIFERENTES: ambas as inserções são permitidas (Expense)', async () => {
    const externalId = 'ext-cross-project-expense-1';

    await expect(prisma.expense.create({ data: expenseData(PROJECT_A, externalId) })).resolves.toBeTruthy();
    await expect(prisma.expense.create({ data: expenseData(PROJECT_B, externalId) })).resolves.toBeTruthy();

    const count = await setupPrisma.expense.count({ where: { tenantId: TENANT, externalId } });
    expect(count).toBe(2);
  });

  it('MESMO externalId, MESMO tenant, MESMO projeto: a 2ª inserção é rejeitada pelo banco (Expense)', async () => {
    const externalId = 'ext-same-project-expense-1';

    await prisma.expense.create({ data: expenseData(PROJECT_A, externalId) });

    let threw: unknown;
    try {
      await prisma.expense.create({ data: expenseData(PROJECT_A, externalId) });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect(isUniqueConstraintError(threw)).toBe(true);

    const count = await setupPrisma.expense.count({ where: { tenantId: TENANT, externalId } });
    expect(count).toBe(1);
  });

  it('MESMO externalId, MESMO tenant, projetos DIFERENTES: ambas as inserções são permitidas (Receipt)', async () => {
    const externalId = 'ext-cross-project-receipt-1';

    await expect(prisma.receipt.create({ data: receiptData(PROJECT_A, externalId) })).resolves.toBeTruthy();
    await expect(prisma.receipt.create({ data: receiptData(PROJECT_B, externalId) })).resolves.toBeTruthy();

    const count = await setupPrisma.receipt.count({ where: { tenantId: TENANT, externalId } });
    expect(count).toBe(2);
  });

  it('MESMO externalId, MESMO tenant, MESMO projeto: a 2ª inserção é rejeitada pelo banco (Receipt)', async () => {
    const externalId = 'ext-same-project-receipt-1';

    await prisma.receipt.create({ data: receiptData(PROJECT_A, externalId) });

    let threw: unknown;
    try {
      await prisma.receipt.create({ data: receiptData(PROJECT_A, externalId) });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect(isUniqueConstraintError(threw)).toBe(true);

    const count = await setupPrisma.receipt.count({ where: { tenantId: TENANT, externalId } });
    expect(count).toBe(1);
  });
});
