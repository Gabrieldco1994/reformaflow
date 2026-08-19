require('../../../../scripts/test-db-env.cjs');

import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExpenseService } from './expense.service';
import type { RateioRequester } from './rateio.types';

const setup = new PrismaClient();
const prisma = new PrismaService();
const TENANT = 'reversal-acl-tenant';
const PESSOAL = 'reversal-acl-pessoal';
const HIDDEN = 'reversal-acl-hidden';
const SOURCE = 'reversal-acl-source';
const TARGET = 'reversal-acl-target';
const NOW = new Date('2026-08-18T12:00:00.000Z');

const MANAGED: RateioRequester = {
  role: 'USER',
  allowedProjects: [PESSOAL],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses'],
};
const OWNER: RateioRequester = {
  role: 'OWNER',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

async function clean(): Promise<void> {
  await setup.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
  await setup.crossProjectSettlement.deleteMany({ where: { tenantId: TENANT } });
  await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setup.expense.deleteMany({ where: { tenantId: TENANT } });
}

async function seedExpenses(): Promise<void> {
  await setup.expense.createMany({
    data: [
      {
        id: SOURCE,
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 10_000,
        quantidade: 1,
        valorTotal: 10_000,
        titulo: 'Fonte',
        formaPagamento: 'A_VISTA',
        dataPagamento: NOW,
        status: 'PAGO',
        linkedExpenseId: TARGET,
      },
      {
        id: TARGET,
        tenantId: TENANT,
        projectId: HIDDEN,
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 10_000,
        quantidade: 1,
        valorTotal: 10_000,
        titulo: 'Alvo oculto',
        formaPagamento: 'A_VISTA',
        dataPagamento: NOW,
        status: 'PAGO',
      },
    ],
  });
}

async function seedRateio(): Promise<void> {
  await seedExpenses();
  await setup.rateioAllocation.create({
    data: {
      tenantId: TENANT,
      sourceExpenseId: SOURCE,
      targetExpenseId: TARGET,
      allocation: 10_000,
      plannedStatus: 'PLANEJADO',
      plannedValor: 10_000,
      plannedQuantidade: 1,
      plannedValorTotal: 10_000,
      plannedForma: 'A_VISTA',
      plannedDataPagamento: NOW,
    },
  });
}

async function seedSettlement(): Promise<void> {
  await seedExpenses();
  await setup.crossProjectSettlement.create({
    data: {
      tenantId: TENANT,
      sourceExpenseId: SOURCE,
      targetExpenseId: TARGET,
      parcelaIndex: 0,
      realValor: 10_000,
      plannedValor: 10_000,
      plannedStatus: 'PLANEJADO',
    },
  });
}

async function snapshot(): Promise<unknown> {
  return {
    expenses: await setup.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: 'asc' },
    }),
    rateios: await setup.rateioAllocation.findMany({ where: { tenantId: TENANT } }),
    settlements: await setup.crossProjectSettlement.findMany({ where: { tenantId: TENANT } }),
  };
}

describe('ExpenseService — child ACL nas reversões B1a', () => {
  let service: ExpenseService;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await setup.tenant.upsert({
      where: { id: TENANT },
      update: {},
      create: { id: TENANT, name: 'Reversal ACL tenant' },
    });
    await setup.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal' },
        { id: HIDDEN, tenantId: TENANT, type: 'REFORMA', name: 'Oculto' },
      ],
    });
    service = new ExpenseService(prisma, new ConciliacaoService(prisma));
  });

  afterEach(clean);

  afterAll(async () => {
    await clean();
    await setup.project.deleteMany({ where: { tenantId: TENANT } });
    await setup.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  it.each([
    ['desratear', seedRateio, (s: ExpenseService) => s.desratear(TENANT, PESSOAL, SOURCE, MANAGED)],
    [
      'desconciliar',
      seedSettlement,
      (s: ExpenseService) => s.desconciliar(TENANT, PESSOAL, SOURCE, MANAGED),
    ],
    ['remove', seedRateio, (s: ExpenseService) => s.remove(TENANT, PESSOAL, SOURCE, MANAGED)],
  ] as const)('%s rejeita alvo oculto com 404 e zero writes', async (_name, seed, act) => {
    await seed();
    const before = await snapshot();
    await expect(act(service)).rejects.toBeInstanceOf(NotFoundException);
    expect(await snapshot()).toEqual(before);
  });

  it('requester undefined falha fechado e preserva o rateio', async () => {
    await seedRateio();
    const before = await snapshot();
    await expect(
      service.desratear(TENANT, PESSOAL, SOURCE, undefined as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await snapshot()).toEqual(before);
  });

  it('OWNER pode reverter e no-op sem relações continua idempotente', async () => {
    await seedRateio();
    await expect(
      service.desratear(TENANT, PESSOAL, SOURCE, OWNER),
    ).resolves.toMatchObject({ ok: true, targets: [TARGET] });
    expect(await setup.rateioAllocation.count({ where: { tenantId: TENANT } })).toBe(0);

    await expect(
      service.desratear(TENANT, PESSOAL, SOURCE, OWNER),
    ).resolves.toMatchObject({ ok: true, targets: [] });
  });
});
