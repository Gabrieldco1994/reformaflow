/**
 * B1a (#448) — RED: `sourcePriceItemId` (deep-link do item de PriceMonitor que
 * originou um item do Planejador) deve ser project-scoped: só pode referenciar
 * um `PriceMonitorItem` do MESMO tenant E do MESMO projeto do cenário/item.
 *
 * Contrato (issue #448, B1a): "Child ACL aplicada a ... sourcePriceItemId" +
 * STATUS CONTRACT: "room/source item 404".
 *
 * Hoje `createItem`/`updateItem` (purchase-planner.service.ts) gravam
 * `sourcePriceItemId` cru, sem NENHUMA validação — nem tenant, nem projeto.
 * Cobre tanto cross-tenant quanto same-tenant-outro-projeto (ambos devem
 * colapsar no mesmo 404, indistinguíveis), com Prisma REAL.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { PurchasePlannerService } from './purchase-planner.service';
import { PrismaService } from '../prisma/prisma.service';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'ppsi-tenant';
const TENANT_OTHER = 'ppsi-tenant-other';
const PROJECT = 'ppsi-project';
const PROJECT_OTHER_SAME_TENANT = 'ppsi-project-other-same-tenant';
const PROJECT_OTHER_TENANT = 'ppsi-project-other-tenant';

async function cleanupTransient() {
  await setupPrisma.purchaseScenarioItem.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
  await setupPrisma.purchaseScenario.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
}

async function cleanupAll() {
  await cleanupTransient();
  await setupPrisma.priceMonitorItem.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
  await setupPrisma.project.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
  await setupPrisma.tenant.deleteMany({ where: { id: { in: [TENANT, TENANT_OTHER] } } });
}

describe('PurchasePlannerService — sourcePriceItemId é project-scoped (#448 B1a)', () => {
  let service: PurchasePlannerService;
  let scenarioId: string;
  let priceItemSameProject: string;
  let priceItemOtherProjectSameTenant: string;
  let priceItemOtherTenant: string;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupAll();

    await setupPrisma.tenant.createMany({
      data: [{ id: TENANT, name: 'Planner tenant' }, { id: TENANT_OTHER, name: 'Planner outro tenant' }],
    });
    await setupPrisma.project.createMany({
      data: [
        { id: PROJECT, tenantId: TENANT, type: 'REFORMA', name: 'Reforma A' },
        { id: PROJECT_OTHER_SAME_TENANT, tenantId: TENANT, type: 'REFORMA', name: 'Reforma B' },
        { id: PROJECT_OTHER_TENANT, tenantId: TENANT_OTHER, type: 'REFORMA', name: 'Reforma outro tenant' },
      ],
    });
    const [same, otherProj, otherTenant] = await Promise.all([
      setupPrisma.priceMonitorItem.create({ data: { projectId: PROJECT, tenantId: TENANT, title: 'Piso' } }),
      setupPrisma.priceMonitorItem.create({ data: { projectId: PROJECT_OTHER_SAME_TENANT, tenantId: TENANT, title: 'Piso B' } }),
      setupPrisma.priceMonitorItem.create({ data: { projectId: PROJECT_OTHER_TENANT, tenantId: TENANT_OTHER, title: 'Piso outro tenant' } }),
    ]);
    priceItemSameProject = same.id;
    priceItemOtherProjectSameTenant = otherProj.id;
    priceItemOtherTenant = otherTenant.id;

    service = new PurchasePlannerService(prisma);
    const scenario = await service.createScenario(TENANT, PROJECT, { nome: 'Cenário principal' } as any);
    scenarioId = scenario.id;
  });

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  afterEach(async () => {
    await setupPrisma.purchaseScenarioItem.deleteMany({ where: { scenarioId } });
  });

  const itemDto = (over: Record<string, unknown> = {}) => ({
    nome: 'Porcelanato',
    tipo: 'A_VISTA',
    valorCents: 500_00,
    mesInicio: '2026-09',
    ...over,
  });

  describe('createItem', () => {
    it('sourcePriceItemId de OUTRO projeto do MESMO tenant → 404, nenhum item criado', async () => {
      const before = await setupPrisma.purchaseScenarioItem.count({ where: { scenarioId } });

      await expect(
        service.createItem(TENANT, PROJECT, scenarioId, itemDto({ sourcePriceItemId: priceItemOtherProjectSameTenant }) as any),
      ).rejects.toBeInstanceOf(NotFoundException);

      const after = await setupPrisma.purchaseScenarioItem.count({ where: { scenarioId } });
      expect(after).toBe(before);
    });

    it('sourcePriceItemId de OUTRO tenant → 404 idêntico ao same-tenant-outro-projeto (indistinguível)', async () => {
      let sameProjErr: unknown; let otherTenantErr: unknown;
      try {
        await service.createItem(TENANT, PROJECT, scenarioId, itemDto({ sourcePriceItemId: priceItemOtherProjectSameTenant }) as any);
      } catch (e) { sameProjErr = e; }
      try {
        await service.createItem(TENANT, PROJECT, scenarioId, itemDto({ sourcePriceItemId: priceItemOtherTenant }) as any);
      } catch (e) { otherTenantErr = e; }

      expect(sameProjErr).toBeInstanceOf(NotFoundException);
      expect(otherTenantErr).toBeInstanceOf(NotFoundException);
      expect((sameProjErr as NotFoundException)?.message).toBe((otherTenantErr as NotFoundException)?.message);

      const count = await setupPrisma.purchaseScenarioItem.count({ where: { scenarioId } });
      expect(count).toBe(0);
    });

    it('sourcePriceItemId do MESMO projeto → sucesso (controle)', async () => {
      const created = await service.createItem(TENANT, PROJECT, scenarioId, itemDto({ sourcePriceItemId: priceItemSameProject }) as any);
      expect(created.sourcePriceItemId).toBe(priceItemSameProject);
    });

    it('sourcePriceItemId omitido → sucesso, campo null (controle)', async () => {
      const created = await service.createItem(TENANT, PROJECT, scenarioId, itemDto() as any);
      expect(created.sourcePriceItemId).toBeNull();
    });
  });

  describe('updateItem', () => {
    it('sourcePriceItemId de OUTRO projeto (mesmo tenant) → 404, item existente não muda', async () => {
      const existing = await service.createItem(TENANT, PROJECT, scenarioId, itemDto({ sourcePriceItemId: priceItemSameProject }) as any);

      await expect(
        service.updateItem(TENANT, PROJECT, scenarioId, existing.id, { sourcePriceItemId: priceItemOtherProjectSameTenant } as any),
      ).rejects.toBeInstanceOf(NotFoundException);

      const row = await setupPrisma.purchaseScenarioItem.findUnique({ where: { id: existing.id } });
      expect(row?.sourcePriceItemId).toBe(priceItemSameProject);
    });

    it('sourcePriceItemId omitido no patch → mantém o valor atual (controle)', async () => {
      const existing = await service.createItem(TENANT, PROJECT, scenarioId, itemDto({ sourcePriceItemId: priceItemSameProject }) as any);
      const updated = await service.updateItem(TENANT, PROJECT, scenarioId, existing.id, { nome: 'Porcelanato retificado' } as any);
      expect(updated.sourcePriceItemId).toBe(priceItemSameProject);
    });
  });
});
