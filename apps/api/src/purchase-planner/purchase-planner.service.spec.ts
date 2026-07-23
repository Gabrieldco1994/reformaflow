import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PurchasePlannerService } from './purchase-planner.service';
import { PrismaService } from '../prisma/prisma.service';

function makePrismaMock() {
  return {
    purchaseScenario: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    purchaseScenarioItem: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

describe('PurchasePlannerService', () => {
  let service: PurchasePlannerService;
  let prisma: ReturnType<typeof makePrismaMock>;
  const tenantId = 'tenant-1';
  const projectId = 'project-1';

  beforeEach(async () => {
    prisma = makePrismaMock();
    prisma.$transaction.mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(prisma);
      return Promise.all(arg);
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PurchasePlannerService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(PurchasePlannerService);
  });

  describe('escopo por tenant+projeto', () => {
    it('lança NotFoundException ao buscar cenário de outro tenant/projeto', async () => {
      prisma.purchaseScenario.findFirst.mockResolvedValue(null);
      await expect(
        service.findScenarioById(tenantId, projectId, 'scenario-x'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sempre filtra findFirst por id+tenantId+projectId+deletedAt:null', async () => {
      prisma.purchaseScenario.findFirst.mockResolvedValue({ id: 's1' });
      await service.findScenarioById(tenantId, projectId, 's1');
      expect(prisma.purchaseScenario.findFirst).toHaveBeenCalledWith({
        where: { id: 's1', tenantId, projectId, deletedAt: null },
      });
    });

    it('lança NotFoundException ao operar item de outro cenário', async () => {
      prisma.purchaseScenario.findFirst.mockResolvedValue({ id: 's1' });
      prisma.purchaseScenarioItem.findFirst.mockResolvedValue(null);
      await expect(
        service.removeItem(tenantId, projectId, 's1', 'item-de-outro-cenario'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createItem — validação por tipo', () => {
    beforeEach(() => {
      prisma.purchaseScenario.findFirst.mockResolvedValue({ id: 's1' });
    });

    it('rejeita PARCELADO sem parcelas', async () => {
      await expect(
        service.createItem(tenantId, projectId, 's1', {
          nome: 'Sofá',
          tipo: 'PARCELADO',
          valorCents: 100_000,
          mesInicio: '2026-08',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.purchaseScenarioItem.create).not.toHaveBeenCalled();
    });

    it('rejeita FINANCIAMENTO sem sistema', async () => {
      await expect(
        service.createItem(tenantId, projectId, 's1', {
          nome: 'Carro',
          tipo: 'FINANCIAMENTO',
          valorCents: 5_000_000,
          parcelas: 48,
          mesInicio: '2026-08',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('aceita A_VISTA sem parcelas/sistema', async () => {
      prisma.purchaseScenarioItem.create.mockResolvedValue({ id: 'i1' });
      await service.createItem(tenantId, projectId, 's1', {
        nome: 'Geladeira',
        tipo: 'A_VISTA',
        valorCents: 300_000,
        mesInicio: '2026-08',
      } as any);
      expect(prisma.purchaseScenarioItem.create).toHaveBeenCalled();
    });

    it('cria FINANCIAMENTO válido com todos os campos', async () => {
      prisma.purchaseScenarioItem.create.mockResolvedValue({ id: 'i1' });
      await service.createItem(tenantId, projectId, 's1', {
        nome: 'Carro',
        tipo: 'FINANCIAMENTO',
        valorCents: 5_000_000,
        entradaCents: 500_000,
        parcelas: 48,
        taxaJurosMensalBps: 150,
        sistema: 'PRICE',
        mesInicio: '2026-08',
        sourcePriceItemId: 'price-item-1',
      } as any);
      expect(prisma.purchaseScenarioItem.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId,
          projectId,
          scenarioId: 's1',
          tipo: 'FINANCIAMENTO',
          entradaCents: 500_000,
          parcelas: 48,
          sistema: 'PRICE',
          sourcePriceItemId: 'price-item-1',
        }),
      });
    });
  });

  describe('updateItem — valida o resultado final (existente + patch)', () => {
    it('rejeita trocar tipo para FINANCIAMENTO sem sistema já existente nem enviado', async () => {
      prisma.purchaseScenario.findFirst.mockResolvedValue({ id: 's1' });
      prisma.purchaseScenarioItem.findFirst.mockResolvedValue({
        id: 'i1',
        tipo: 'A_VISTA',
        parcelas: null,
        sistema: null,
      });
      await expect(
        service.updateItem(tenantId, projectId, 's1', 'i1', { tipo: 'FINANCIAMENTO', parcelas: 12 } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('aceita patch parcial que preserva parcelas já existente', async () => {
      prisma.purchaseScenario.findFirst.mockResolvedValue({ id: 's1' });
      prisma.purchaseScenarioItem.findFirst.mockResolvedValue({
        id: 'i1',
        tipo: 'PARCELADO',
        parcelas: 6,
        sistema: null,
      });
      prisma.purchaseScenarioItem.update.mockResolvedValue({ id: 'i1' });
      await service.updateItem(tenantId, projectId, 's1', 'i1', { incluido: false } as any);
      expect(prisma.purchaseScenarioItem.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { incluido: false },
      });
    });
  });

  describe('removeScenario — cascade manual', () => {
    it('soft-deleta todos os itens do cenário antes de soft-deletar o cenário', async () => {
      prisma.purchaseScenario.findFirst.mockResolvedValue({ id: 's1' });
      prisma.purchaseScenarioItem.updateMany.mockResolvedValue({ count: 3 });
      prisma.purchaseScenario.update.mockResolvedValue({ id: 's1', deletedAt: new Date() });

      const result = await service.removeScenario(tenantId, projectId, 's1');

      expect(prisma.purchaseScenarioItem.updateMany).toHaveBeenCalledWith({
        where: { scenarioId: 's1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.purchaseScenario.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(result).toEqual({ deleted: true });
    });
  });

  describe('findAllScenarios / findScenarioById — anexa itens não deletados', () => {
    it('busca os itens de cada cenário filtrando deletedAt:null', async () => {
      prisma.purchaseScenario.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
      prisma.purchaseScenarioItem.findMany.mockResolvedValue([{ id: 'i1', scenarioId: 's1' }]);

      const result = await service.findAllScenarios(tenantId, projectId);

      expect(prisma.purchaseScenarioItem.findMany).toHaveBeenCalledWith({
        where: { scenarioId: 's1', deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 's1', itens: [{ id: 'i1', scenarioId: 's1' }] });
    });
  });
});
