/**
 * #484 A — `/tenant/credit-cards` não tinha NENHUM gate de módulo.
 *
 * `ModulesGuard.canActivate` devolve `true` quando não há metadata: ausência do
 * decorator é ausência de trava. O controller resolvia o escopo com
 * `resolveAccessibleProjectScope` SEM `requiredModule`, então quem alcança um
 * projeto PESSOAL por `expenses` (módulo NÃO relacionado ao recurso) enumerava
 * todo cartão do projeto — `nickname`, `last4`, `brand`, limites.
 *
 * Contrato exigido (o mesmo de #480 SEC-1, com as duas pernas):
 *  1. `@RequireModule('creditCards')` na rota — falha rápido (403) antes de
 *     qualquer leitura;
 *  2. `CREDIT_CARD_MODULE` no resolvedor de escopo — o escopo não pode admitir
 *     projeto alcançado por módulo não relacionado, mesmo se o guard for
 *     contornado (chamada interna, teste, refactor de rota).
 *
 * Indistinguibilidade: a resposta de quem NÃO tem o módulo é deep-equal à de
 * um tenant que genuinamente não tem cartão — sem contagem, total ou metadata
 * que diferencie os dois mundos.
 *
 * Prisma REAL (SQLite descartável), sem mock que espelhe a lógica do service.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { CreditCardTenantController } from './credit-card-tenant.controller';
import { CreditCardService } from './credit-card.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import { ModulesGuard } from '../common/guards/modules.guard';
import { PrismaService } from '../prisma/prisma.service';

const setup = new PrismaClient();
const prisma = new PrismaService();

const CLOCK = new Date('2026-08-19T15:00:00.000Z');

const TENANT = 'qa484-cards-tenant';
const PESSOAL = 'qa484-cards-pessoal';
const REFORMA = 'qa484-cards-reforma';
const PESSOAL_CARD = 'qa484-cards-card-pessoal';
const REFORMA_CARD = 'qa484-cards-card-reforma';

/** Strings que NUNCA podem aparecer na resposta de quem não tem o módulo. */
const SENTINELS = [
  'Cartão pessoal SENTINELA',
  'Cartão de obra SENTINELA',
  '4841',
  '4842',
] as const;

interface Requester {
  role: string;
  allowedProjects?: string[];
  allowedProjectTypes?: string[];
  allowedModules?: string[];
}

/**
 * `allowedProjectTypes: []` é o legado "sem restrição por tipo": os tipos são
 * derivados dos MÓDULOS. Este requester alcança PESSOAL e REFORMA por
 * `expenses` — e nada mais deveria vir junto.
 */
const EXPENSES_ONLY: Requester = {
  role: 'USER',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: ['expenses'],
};

const WITH_CARDS: Requester = {
  role: 'USER',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: ['expenses', 'creditCards'],
};

const OWNER: Requester = {
  role: 'OWNER',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

function contextFor(user: Requester | undefined): ExecutionContext {
  return {
    getHandler: () => CreditCardTenantController.prototype.list,
    getClass: () => CreditCardTenantController,
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

async function setCardsActive(active: boolean): Promise<void> {
  await setup.creditCard.updateMany({
    where: { tenantId: TENANT },
    data: { deletedAt: active ? null : CLOCK },
  });
}

describe('/tenant/credit-cards module gate (#484 A)', () => {
  const service = new CreditCardService(
    prisma,
    new ConciliacaoService(prisma),
    new MerchantClassifierService(prisma),
  );
  const controller = new CreditCardTenantController(service, prisma);
  const guard = new ModulesGuard(new Reflector(), prisma);

  async function cleanupAll(): Promise<void> {
    await setup.creditCard.deleteMany({ where: { tenantId: TENANT } });
    await setup.project.deleteMany({ where: { tenantId: TENANT } });
    await setup.tenant.deleteMany({ where: { id: TENANT } });
  }

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setup.tenant.create({ data: { id: TENANT, name: 'QA 484 cards' } });
    await setup.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal QA 484' },
        { id: REFORMA, tenantId: TENANT, type: 'REFORMA', name: 'Obra QA 484' },
      ],
    });
    await setup.creditCard.createMany({
      data: [
        {
          id: PESSOAL_CARD,
          tenantId: TENANT,
          projectId: PESSOAL,
          institution: 'ITAU',
          brand: 'Visa',
          nickname: 'Cartão pessoal SENTINELA',
          last4: '4841',
          limitTotalCents: 500_000,
          closingDay: 5,
          dueDay: 12,
        },
        {
          id: REFORMA_CARD,
          tenantId: TENANT,
          projectId: REFORMA,
          institution: 'NUBANC',
          brand: 'Mastercard',
          nickname: 'Cartão de obra SENTINELA',
          last4: '4842',
          closingDay: 3,
          dueDay: 10,
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanupAll();
    await setup.$disconnect();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await setCardsActive(true);
  });

  it('devolve a um requester sem `creditCards` exatamente o que um tenant sem cartão devolve', async () => {
    const denied = await controller.list(TENANT, EXPENSES_ONLY as never);

    // Controle: o MESMO endpoint, com o módulo, num tenant que genuinamente
    // não tem cartão nenhum. Deep-equal prova que nada (nem contagem, nem
    // metadata) distingue "não pode ver" de "não existe".
    await setCardsActive(false);
    const genuinelyEmpty = await controller.list(TENANT, WITH_CARDS as never);

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

  it('entrega os cartões ao MESMO requester quando ele tem `creditCards`', async () => {
    const allowed = await controller.list(TENANT, WITH_CARDS as never);

    expect(allowed.map((card) => card.id).sort()).toEqual(
      [PESSOAL_CARD, REFORMA_CARD].sort(),
    );
  });

  it('mantém OWNER irrestrito no mesmo tenant', async () => {
    const owner = await controller.list(TENANT, OWNER as never);

    expect(owner.map((card) => card.id).sort()).toEqual(
      [PESSOAL_CARD, REFORMA_CARD].sort(),
    );
  });

  it('falha rápido no guard: a rota declara `creditCards`', async () => {
    const denied = await captureError(() =>
      Promise.resolve(guard.canActivate(contextFor(EXPENSES_ONLY))),
    );

    expect(denied).toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(contextFor(WITH_CARDS))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor(OWNER))).resolves.toBe(true);
  });
});
