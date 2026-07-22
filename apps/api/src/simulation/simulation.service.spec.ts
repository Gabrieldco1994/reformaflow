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
  budgetAllocation: { findMany: AnyFn };
}

const makePrismaMock = (): PrismaMock => ({
  project: { findFirst: jest.fn() },
  receipt: { findMany: jest.fn().mockResolvedValue([]) },
  expense: { findMany: jest.fn().mockResolvedValue([]) },
  cashFlowEntry: { findMany: jest.fn().mockResolvedValue([]) },
  room: { findMany: jest.fn().mockResolvedValue([]) },
  simulationValue: { findMany: jest.fn().mockResolvedValue([]) },
  budgetAllocation: { findMany: jest.fn().mockResolvedValue([]) },
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

describe('SimulationService.getData — recebimentos via budget allocation', () => {
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

  describe('SimulationService.getData — COMPRA', () => {
    it('preserva o baseline financeiro sem expor ambientes ou categorias de REFORMA', async () => {
      const prisma = makePrismaMock();
      prisma.project.findFirst.mockResolvedValue({
        id: 'project-compra',
        tenantId: 'tenant-1',
        type: 'COMPRA',
      });
      prisma.receipt.findMany.mockResolvedValue([
        { id: 'r1', tipo: 'OUTROS', valor: 500_000, status: 'EM_CAIXA' },
      ]);
      prisma.expense.findMany.mockResolvedValue([
        {
          id: 'e1',
          valorTotal: 120_000,
          tipoDespesa: 'DOCUMENTACAO',
          status: 'PLANEJADO',
          roomId: null,
          room: null,
        },
      ]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([
        {
          id: 'cf1',
          data: new Date('2026-07-10T00:00:00.000Z'),
          tipo: 'RECEBIMENTO',
          valor: 500_000,
        },
        {
          id: 'cf2',
          data: new Date('2026-07-15T00:00:00.000Z'),
          tipo: 'DESPESA',
          valor: 120_000,
        },
      ]);

      const module: TestingModule = await Test.createTestingModule({
        providers: [SimulationService, { provide: PrismaService, useValue: prisma }],
      }).compile();
      const service = module.get<SimulationService>(SimulationService);

      const data = await service.getData('tenant-1', 'project-compra');

      expect(data.kpis).toEqual({
        totalRecebimentos: 500_000,
        previsaoGastos: 120_000,
        previsaoSaldo: 380_000,
      });
      expect(data.ambientes).toEqual([]);
      expect(data.porTipo).toEqual([]);
      expect(data.projecaoMensal[0]).toEqual({
        month: '2026-07',
        recebimentos: 500_000,
        despesas: 120_000,
      });
      expect(prisma.room.findMany).not.toHaveBeenCalled();
    });
  });

  it('usa o orçamento alocado como Total Recebimentos quando há budget allocations', async () => {
    prisma.budgetAllocation.findMany.mockResolvedValue([
      { id: 'a1', valor: 3000000, targetProjectId: projectId, tenantId },
      { id: 'a2', valor: 2000000, targetProjectId: projectId, tenantId },
    ]);

    const data = await service.getData(tenantId, projectId);

    expect(data.kpis.totalRecebimentos).toBe(5000000);
    expect(data.recebimentosPorTipo).toEqual([
      { key: 'ALOCACAO_ORCAMENTO', label: 'Alocação de Orçamento', total: 5000000 },
    ]);
    // Não deve buscar receipts quando há alocações (evita dupla contagem)
    expect(prisma.receipt.findMany).not.toHaveBeenCalled();
  });

  it('cai no fluxo de receipts quando não há budget allocations', async () => {
    prisma.budgetAllocation.findMany.mockResolvedValue([]);
    prisma.receipt.findMany.mockResolvedValue([
      { id: 'r1', tipo: 'COMISSAO', valor: 1500000, status: 'EM_CAIXA' },
    ]);

    const data = await service.getData(tenantId, projectId);

    expect(data.kpis.totalRecebimentos).toBe(1500000);
    expect(prisma.receipt.findMany).toHaveBeenCalled();
  });
});
