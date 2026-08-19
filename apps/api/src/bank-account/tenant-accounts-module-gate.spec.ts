/**
 * #484 B — `/tenant/bank-accounts` não tinha NENHUM gate de módulo.
 *
 * Gêmeo exato de `credit-card/tenant-cards-module-gate.spec.ts`: quem alcança
 * um projeto PESSOAL por `expenses` (módulo NÃO relacionado ao recurso)
 * enumerava toda conta do projeto — `institution`, `nickname`, `last4`.
 *
 * Contrato exigido: `@RequireModule('bankAccounts')` na rota (falha rápido) E
 * `BANK_ACCOUNT_MODULE` no resolvedor de escopo (o escopo não pode admitir
 * projeto alcançado por módulo não relacionado). A resposta de quem não tem o
 * módulo é deep-equal à de um tenant que genuinamente não tem conta.
 *
 * Prisma REAL (SQLite descartável), sem mock que espelhe a lógica do service.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { BankAccountTenantController } from './bank-account-tenant.controller';
import { BankAccountService } from './bank-account.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import { ModulesGuard } from '../common/guards/modules.guard';
import { PrismaService } from '../prisma/prisma.service';

const setup = new PrismaClient();
const prisma = new PrismaService();

const CLOCK = new Date('2026-08-19T15:00:00.000Z');

const TENANT = 'qa484-accounts-tenant';
const PESSOAL = 'qa484-accounts-pessoal';
const ACCOUNT = 'qa484-accounts-account';

/** Strings que NUNCA podem aparecer na resposta de quem não tem o módulo. */
const SENTINELS = ['Conta pessoal SENTINELA', '4843'] as const;

interface Requester {
  role: string;
  allowedProjects?: string[];
  allowedProjectTypes?: string[];
  allowedModules?: string[];
}

/** Alcança PESSOAL por `expenses`; `bankAccounts` é outro módulo do MESMO tipo. */
const EXPENSES_ONLY: Requester = {
  role: 'USER',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: ['expenses'],
};

const WITH_ACCOUNTS: Requester = {
  role: 'USER',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: ['expenses', 'bankAccounts'],
};

const OWNER: Requester = {
  role: 'OWNER',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

function contextFor(user: Requester | undefined): ExecutionContext {
  return {
    getHandler: () => BankAccountTenantController.prototype.list,
    getClass: () => BankAccountTenantController,
    switchToHttp: () => ({ getRequest: () => ({ user, params: {} }) }),
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

async function setAccountsActive(active: boolean): Promise<void> {
  await setup.bankAccount.updateMany({
    where: { tenantId: TENANT },
    data: { deletedAt: active ? null : CLOCK },
  });
}

describe('/tenant/bank-accounts module gate (#484 B)', () => {
  const service = new BankAccountService(
    prisma,
    new MerchantClassifierService(prisma),
    new ConciliacaoService(prisma),
    new CardInvoiceSettlementService(prisma),
  );
  const controller = new BankAccountTenantController(service, prisma);
  const guard = new ModulesGuard(new Reflector(), prisma);

  async function cleanupAll(): Promise<void> {
    await setup.bankAccount.deleteMany({ where: { tenantId: TENANT } });
    await setup.project.deleteMany({ where: { tenantId: TENANT } });
    await setup.tenant.deleteMany({ where: { id: TENANT } });
  }

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setup.tenant.create({ data: { id: TENANT, name: 'QA 484 accounts' } });
    await setup.project.create({
      data: {
        id: PESSOAL,
        tenantId: TENANT,
        type: 'PESSOAL',
        name: 'Pessoal QA 484 contas',
      },
    });
    await setup.bankAccount.create({
      data: {
        id: ACCOUNT,
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: 'ITAU',
        nickname: 'Conta pessoal SENTINELA',
        last4: '4843',
      },
    });
  });

  afterAll(async () => {
    await cleanupAll();
    await setup.$disconnect();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await setAccountsActive(true);
  });

  it('devolve a um requester sem `bankAccounts` exatamente o que um tenant sem conta devolve', async () => {
    const denied = await controller.list(TENANT, EXPENSES_ONLY as never);

    await setAccountsActive(false);
    const genuinelyEmpty = await controller.list(TENANT, WITH_ACCOUNTS as never);

    expect(denied).toEqual(genuinelyEmpty);
    expect(denied).toEqual([]);
    for (const sentinel of SENTINELS) {
      expect(JSON.stringify(denied)).not.toContain(sentinel);
    }
  });

  it('resolve o escopo vazio ANTES de qualquer leitura de projeto', async () => {
    const findMany = jest.spyOn(prisma.project, 'findMany');
    try {
      await controller.list(TENANT, EXPENSES_ONLY as never);
      expect(findMany).not.toHaveBeenCalled();
    } finally {
      findMany.mockRestore();
    }
  });

  it('entrega as contas ao MESMO requester quando ele tem `bankAccounts`', async () => {
    const allowed = await controller.list(TENANT, WITH_ACCOUNTS as never);

    expect(allowed.map((account) => account.id)).toEqual([ACCOUNT]);
  });

  it('mantém OWNER irrestrito no mesmo tenant', async () => {
    const owner = await controller.list(TENANT, OWNER as never);

    expect(owner.map((account) => account.id)).toEqual([ACCOUNT]);
  });

  it('falha rápido no guard: a rota declara `bankAccounts`', async () => {
    const denied = await captureError(() =>
      Promise.resolve(guard.canActivate(contextFor(EXPENSES_ONLY))),
    );

    expect(denied).toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(contextFor(WITH_ACCOUNTS))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor(OWNER))).resolves.toBe(true);
  });
});
