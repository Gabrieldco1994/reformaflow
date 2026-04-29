import { Test, TestingModule } from '@nestjs/testing';
import { BudgetItemService } from './budget-item.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';
import { BudgetStatus } from '@reformaflow/domain';

describe('BudgetItemService', () => {
  let service: BudgetItemService;
  let prisma: jest.Mocked<PrismaService>;

  const mockProject = { id: 'proj-1', tenantId: 'tenant-1', name: 'Reforma' };

  beforeEach(async () => {
    const mockPrisma = {
      project: { findFirst: jest.fn() },
      budgetItem: { findMany: jest.fn(), update: jest.fn() },
      materialPurchase: { groupBy: jest.fn() },
      contractorMilestone: { findMany: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetItemService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<BudgetItemService>(BudgetItemService);
    prisma = module.get(PrismaService);
  });

  describe('findAllByProject', () => {
    it('deve lançar NotFoundException se projeto não pertence ao tenant', async () => {
      (prisma.project.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.findAllByProject('tenant-1', 'proj-inexistente'),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve calcular Realizado dinamicamente a partir de purchases', async () => {
      (prisma.project.findFirst as jest.Mock).mockResolvedValue(mockProject);
      (prisma.budgetItem.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'bi-1',
          projectId: 'proj-1',
          roomId: 'room-1',
          workTypeId: 'wt-1',
          planned: 10000,
          room: { name: 'Cozinha', order: 0 },
          workType: { name: 'Civil', category: 'CIVIL' },
        },
      ]);
      (prisma.materialPurchase.groupBy as jest.Mock).mockResolvedValue([
        { roomId: 'room-1', workTypeId: 'wt-1', _sum: { totalAmount: 3000 } },
      ]);
      (prisma.contractorMilestone.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.findAllByProject('tenant-1', 'proj-1');

      expect(result[0]).toMatchObject({
        id: 'bi-1',
        roomName: 'Cozinha',
        workTypeName: 'Civil',
        planned: 10000,
        actual: 3000,
        balance: 7000,
        percentConsumed: 0.3,
        status: BudgetStatus.OK,
      });
    });

    it('deve marcar WARNING quando 80-100% consumido', async () => {
      (prisma.project.findFirst as jest.Mock).mockResolvedValue(mockProject);
      (prisma.budgetItem.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'bi-1',
          projectId: 'proj-1',
          roomId: 'room-1',
          workTypeId: 'wt-1',
          planned: 5000,
          room: { name: 'Sala de TV', order: 0 },
          workType: { name: 'Pintura', category: 'PAINTING' },
        },
      ]);
      (prisma.materialPurchase.groupBy as jest.Mock).mockResolvedValue([
        { roomId: 'room-1', workTypeId: 'wt-1', _sum: { totalAmount: 4500 } },
      ]);
      (prisma.contractorMilestone.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.findAllByProject('tenant-1', 'proj-1');

      expect(result[0]!.status).toBe(BudgetStatus.WARNING);
      expect(result[0]!.percentConsumed).toBe(0.9);
    });

    it('deve marcar OVER_BUDGET quando >100% consumido', async () => {
      (prisma.project.findFirst as jest.Mock).mockResolvedValue(mockProject);
      (prisma.budgetItem.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'bi-1',
          projectId: 'proj-1',
          roomId: 'room-1',
          workTypeId: 'wt-1',
          planned: 3000,
          room: { name: 'Banheiro', order: 0 },
          workType: { name: 'Hidráulica', category: 'PLUMBING' },
        },
      ]);
      (prisma.materialPurchase.groupBy as jest.Mock).mockResolvedValue([
        { roomId: 'room-1', workTypeId: 'wt-1', _sum: { totalAmount: 3500 } },
      ]);
      (prisma.contractorMilestone.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.findAllByProject('tenant-1', 'proj-1');

      expect(result[0]!.status).toBe(BudgetStatus.OVER_BUDGET);
      expect(result[0]!.balance).toBe(-500);
    });

    it('deve retornar "-" para status quando previsto é 0', async () => {
      (prisma.project.findFirst as jest.Mock).mockResolvedValue(mockProject);
      (prisma.budgetItem.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'bi-1',
          projectId: 'proj-1',
          roomId: 'room-1',
          workTypeId: 'wt-1',
          planned: 0,
          room: { name: 'Hall', order: 0 },
          workType: { name: 'Iluminação', category: 'LIGHTING' },
        },
      ]);
      (prisma.materialPurchase.groupBy as jest.Mock).mockResolvedValue([]);
      (prisma.contractorMilestone.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.findAllByProject('tenant-1', 'proj-1');

      expect(result[0]!.status).toBe('-');
    });
  });

  describe('getDashboardSummary', () => {
    it('deve agregar por ambiente (como SUMIF da planilha)', async () => {
      (prisma.project.findFirst as jest.Mock).mockResolvedValue(mockProject);
      (prisma.budgetItem.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'bi-1', projectId: 'proj-1', roomId: 'r1', workTypeId: 'wt-1',
          planned: 5000, room: { name: 'Cozinha', order: 0 }, workType: { name: 'Civil', category: 'CIVIL' },
        },
        {
          id: 'bi-2', projectId: 'proj-1', roomId: 'r1', workTypeId: 'wt-2',
          planned: 3000, room: { name: 'Cozinha', order: 0 }, workType: { name: 'Elétrica', category: 'ELECTRICAL' },
        },
      ]);
      (prisma.materialPurchase.groupBy as jest.Mock).mockResolvedValue([
        { roomId: 'r1', workTypeId: 'wt-1', _sum: { totalAmount: 2000 } },
      ]);
      (prisma.contractorMilestone.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.getDashboardSummary('tenant-1', 'proj-1');

      expect(result.totalPlanned).toBe(8000);
      expect(result.totalActual).toBe(2000);
      expect(result.totalBalance).toBe(6000);
      expect(result.byRoom).toHaveLength(1);
      expect(result.byRoom[0]).toMatchObject({
        roomName: 'Cozinha',
        planned: 8000,
        actual: 2000,
      });
    });
  });
});
