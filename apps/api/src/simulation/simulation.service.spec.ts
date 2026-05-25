import { Test, TestingModule } from '@nestjs/testing';
import { SimulationService } from './simulation.service';
import { PrismaService } from '../prisma/prisma.service';

type AnyFn = jest.Mock;

interface PrismaMock {
  project: { findFirst: AnyFn };
  receipt: { findMany: AnyFn };
  expense: { findMany: AnyFn };
  cashFlowEntry: { findMany: AnyFn };
  room: { findMany: AnyFn };
  simulationValue: { findMany: AnyFn };
}

const makePrismaMock = (): PrismaMock => ({
  project: { findFirst: jest.fn() },
  receipt: { findMany: jest.fn().mockResolvedValue([]) },
  expense: { findMany: jest.fn().mockResolvedValue([]) },
  cashFlowEntry: { findMany: jest.fn().mockResolvedValue([]) },
  room: { findMany: jest.fn().mockResolvedValue([]) },
  simulationValue: { findMany: jest.fn().mockResolvedValue([]) },
});

describe('SimulationService.getData — porTipo breakdown', () => {
  let service: SimulationService;
  let prisma: PrismaMock;
  const tenantId = 'tenant-1';
  const projectId = 'project-1';

  beforeEach(async () => {
    prisma = makePrismaMock();
    prisma.project.findFirst.mockResolvedValue({ id: projectId, tenantId, type: 'REFORMA' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [SimulationService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<SimulationService>(SimulationService);
  });

  it('returns total, pago and planejado segregados por tipo de despesa', async () => {
    prisma.room.findMany.mockResolvedValue([{ id: 'room-1', name: 'Cozinha', order: 0 }]);
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'e1',
        projectId,
        tenantId,
        roomId: 'room-1',
        room: { id: 'room-1', name: 'Cozinha' },
        tipoDespesa: 'MAO_DE_OBRA',
        categoriaMaoDeObra: 'EMPREITEIRO',
        valorTotal: 2000000, // R$ 20.000
        status: 'PAGO',
      },
      {
        id: 'e2',
        projectId,
        tenantId,
        roomId: 'room-1',
        room: { id: 'room-1', name: 'Cozinha' },
        tipoDespesa: 'MAO_DE_OBRA',
        categoriaMaoDeObra: 'PINTOR',
        valorTotal: 8559000, // R$ 85.590
        status: 'PLANEJADO',
      },
      {
        id: 'e3',
        projectId,
        tenantId,
        roomId: 'room-1',
        room: { id: 'room-1', name: 'Cozinha' },
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valorTotal: 500000, // R$ 5.000
        status: 'PAGO',
      },
    ]);

    const data = await service.getData(tenantId, projectId);

    const maoDeObra = data.porTipo.find((t) => t.key === 'MAO_DE_OBRA');
    expect(maoDeObra).toBeDefined();
    expect(maoDeObra!.label).toBe('Mão de Obra');
    expect(maoDeObra!.total).toBe(2000000 + 8559000);
    expect(maoDeObra!.pago).toBe(2000000);
    expect(maoDeObra!.planejado).toBe(8559000);

    const material = data.porTipo.find((t) => t.key === 'MATERIAL_CONSTRUCAO');
    expect(material).toBeDefined();
    expect(material!.label).toBe('Material p/ Construção');
    expect(material!.total).toBe(500000);
    expect(material!.pago).toBe(500000);
    expect(material!.planejado).toBe(0);
  });

  it('exclui despesas vinculadas (linkedExpenseId) do total via filtro Prisma', async () => {
    prisma.expense.findMany.mockResolvedValue([]);
    await service.getData(tenantId, projectId);

    expect(prisma.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId,
          tenantId,
          deletedAt: null,
          settledByExpenseId: null,
        }),
      }),
    );
  });

  it('soma pago=0 quando nenhuma despesa está com status PAGO', async () => {
    prisma.room.findMany.mockResolvedValue([{ id: 'room-1', name: 'Sala', order: 0 }]);
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'e1',
        projectId,
        tenantId,
        roomId: 'room-1',
        room: { id: 'room-1', name: 'Sala' },
        tipoDespesa: 'ILUMINACAO',
        valorTotal: 100000,
        status: 'PLANEJADO',
      },
    ]);

    const data = await service.getData(tenantId, projectId);
    const iluminacao = data.porTipo.find((t) => t.key === 'ILUMINACAO');
    expect(iluminacao!.total).toBe(100000);
    expect(iluminacao!.pago).toBe(0);
    expect(iluminacao!.planejado).toBe(100000);
  });
});
