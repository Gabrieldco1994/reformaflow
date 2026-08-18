/**
 * B1a (#448) — `roomId` deve ser project-scoped (não pode apontar para um
 * Room de OUTRO projeto do tenant), nas 3 vias de escrita que aceitam roomId:
 * `create`, `update` e `ratearMixed` (novo alvo). Autorado RED contra o
 * baseline pré-#448; GREEN após a implementação — mantido como regression
 * lock.
 *
 * Contrato (issue #448, B1a): "Child ACL aplicada a link, rateio, settlement,
 * pay/undo, roomId e sourcePriceItemId; reler no commit." + STATUS CONTRACT:
 * "room/source item 404".
 *
 * No baseline pré-#448, `roomId` era gravado cru, sem NENHUMA validação de que
 * o Room pertence ao MESMO projeto da despesa (`Room.projectId`) — só existia
 * uma FK solta no schema, sem checagem de aplicação. Um roomId de outro
 * projeto do mesmo tenant era aceito silenciosamente. Prisma REAL, sem mocks.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { RateioRequester } from './rateio.types';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'ersc-tenant';
const PESSOAL = 'ersc-pessoal';
const OTHER = 'ersc-other';
const ADMIN: RateioRequester = {
  role: 'ADMIN',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

async function cleanupTransient() {
  await setupPrisma.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
}

async function cleanupAll() {
  await cleanupTransient();
  await setupPrisma.room.deleteMany({ where: { project: { tenantId: TENANT } } });
  await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
}

describe('ExpenseService — roomId é project-scoped (#448 B1a)', () => {
  let service: ExpenseService;
  let roomInPessoal: string;
  let roomInOther: string;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupAll();

    await setupPrisma.tenant.create({ data: { id: TENANT, name: 'Room scope tenant' } });
    await setupPrisma.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: 'REFORMA', name: 'Reforma A' },
        { id: OTHER, tenantId: TENANT, type: 'REFORMA', name: 'Reforma B' },
      ],
    });
    const rp = await setupPrisma.room.create({ data: { projectId: PESSOAL, name: 'Cozinha' } });
    const ro = await setupPrisma.room.create({ data: { projectId: OTHER, name: 'Sala' } });
    roomInPessoal = rp.id;
    roomInOther = ro.id;

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

  const dto = (over: Record<string, unknown> = {}) => ({
    tipoDespesa: 'MATERIAL_CONSTRUCAO',
    valor: 100,
    quantidade: 1,
    titulo: 'Piso',
    formaPagamento: 'A_VISTA',
    status: 'PLANEJADO',
    ...over,
  });

  describe('create', () => {
    it('roomId de OUTRO projeto → 404, nenhuma despesa criada', async () => {
      const before = await setupPrisma.expense.count({ where: { tenantId: TENANT, projectId: PESSOAL } });

      await expect(
        service.create(TENANT, PESSOAL, dto({ roomId: roomInOther }) as any),
      ).rejects.toBeInstanceOf(NotFoundException);

      const after = await setupPrisma.expense.count({ where: { tenantId: TENANT, projectId: PESSOAL } });
      expect(after).toBe(before);
    });

    it('roomId do MESMO projeto → sucesso (controle)', async () => {
      const created = await service.create(TENANT, PESSOAL, dto({ roomId: roomInPessoal }) as any);
      expect(created.roomId).toBe(roomInPessoal);
    });

    it('roomId omitido → sucesso, não afetado (controle)', async () => {
      const created = await service.create(TENANT, PESSOAL, dto() as any);
      expect(created.roomId).toBeNull();
    });
  });

  describe('update', () => {
    it('roomId de OUTRO projeto → 404, despesa existente não muda de room', async () => {
      const existing = await service.create(TENANT, PESSOAL, dto({ roomId: roomInPessoal }) as any);

      await expect(
        service.update(TENANT, PESSOAL, existing.id, { roomId: roomInOther } as any),
      ).rejects.toBeInstanceOf(NotFoundException);

      const row = await setupPrisma.expense.findUnique({ where: { id: existing.id } });
      expect(row?.roomId).toBe(roomInPessoal);
    });

    it('roomId omitido no patch → mantém o room atual (controle)', async () => {
      const existing = await service.create(TENANT, PESSOAL, dto({ roomId: roomInPessoal }) as any);
      const updated = await service.update(TENANT, PESSOAL, existing.id, { titulo: 'Piso porcelanato' } as any);
      expect(updated.roomId).toBe(roomInPessoal);
    });
  });

  describe('ratearMixed — novo alvo com roomId', () => {
    it('roomId do alvo NOVO em projeto DIFERENTE do targetProjectId → 404 e rollback total (nenhum alvo órfão)', async () => {
      const source = await setupPrisma.expense.create({
        data: {
          tenantId: TENANT, projectId: PESSOAL, tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 20_000, quantidade: 1, valorTotal: 20_000, titulo: 'Fonte rateio',
          formaPagamento: 'A_VISTA', status: 'PLANEJADO', dataPagamento: new Date('2026-08-10T12:00:00.000Z'),
        } as any,
      });
      const marker = 'ratear-mixed-room-orfao-marker';

      await expect(
        service.ratearMixed(TENANT, PESSOAL, source.id, {
          newTargets: [{
            targetProjectId: OTHER,
            tipoDespesa: 'MATERIAL_CONSTRUCAO',
            valor: 100,
            titulo: marker,
            roomId: roomInPessoal, // pertence a PESSOAL, não a OTHER (targetProjectId)
            allocation: 20_000,
          }],
          existing: [],
        } as any, null, ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);

      const orphan = await setupPrisma.expense.findFirst({ where: { tenantId: TENANT, titulo: marker } });
      expect(orphan).toBeNull();
      const allocCount = await setupPrisma.rateioAllocation.count({ where: { sourceExpenseId: source.id } });
      expect(allocCount).toBe(0);
    });

    it('roomId do alvo NOVO no MESMO projeto do targetProjectId → sucesso (controle)', async () => {
      const source = await setupPrisma.expense.create({
        data: {
          tenantId: TENANT, projectId: PESSOAL, tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 20_000, quantidade: 1, valorTotal: 20_000, titulo: 'Fonte rateio ok',
          formaPagamento: 'A_VISTA', status: 'PLANEJADO', dataPagamento: new Date('2026-08-10T12:00:00.000Z'),
        } as any,
      });

      const result = await service.ratearMixed(TENANT, PESSOAL, source.id, {
        newTargets: [{
          targetProjectId: OTHER,
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 100,
          titulo: 'rtm-room-ok',
          roomId: roomInOther, // pertence a OTHER — mesmo projeto do targetProjectId
          allocation: 20_000,
        }],
        existing: [],
      } as any, null, ADMIN);

      expect(result.createdTargetIds).toHaveLength(1);
      const createdRow = await setupPrisma.expense.findUnique({ where: { id: result.createdTargetIds[0] } });
      expect(createdRow?.roomId).toBe(roomInOther);
    });
  });
});
