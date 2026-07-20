import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PendenciaService } from './pendencia.service';
import { PrismaService } from '../prisma/prisma.service';
import { MonthlyOverviewService } from '../monthly-overview/monthly-overview.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';

const TENANT = 't1';
const PROJECT = 'reforma1';

function makeRow(over: Partial<any> = {}) {
  return {
    id: 'p1',
    projectId: PROJECT,
    tenantId: TENANT,
    title: 'Comprar cimento',
    description: null,
    status: 'PENDENTE',
    dueDate: null,
    owner: null,
    roomId: null,
    scheduleTaskId: null,
    order: 0,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    room: null,
    scheduleTask: null,
    ...over,
  };
}

describe('PendenciaService', () => {
  let service: PendenciaService;
  let prisma: any;
  let monthlyOverviewService: any;
  let merchantClassifierService: any;

  beforeEach(async () => {
    prisma = {
      pendencia: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      room: { findFirst: jest.fn() },
      scheduleTask: { findFirst: jest.fn() },
    };
    monthlyOverviewService = { getAccountView: jest.fn() };
    merchantClassifierService = { fromCache: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PendenciaService,
        { provide: PrismaService, useValue: prisma },
        { provide: MonthlyOverviewService, useValue: monthlyOverviewService },
        { provide: MerchantClassifierService, useValue: merchantClassifierService },
      ],
    }).compile();

    service = module.get(PendenciaService);
  });

  describe('create', () => {
    it('applies default status/order and scopes writes to tenant+project', async () => {
      prisma.pendencia.findFirst.mockResolvedValue({ order: 4 }); // max order
      prisma.pendencia.create.mockResolvedValue(makeRow({ order: 5 }));

      const res = await service.create(TENANT, PROJECT, { title: 'Comprar cimento' });

      const arg = prisma.pendencia.create.mock.calls[0][0];
      expect(arg.data).toMatchObject({
        tenantId: TENANT,
        projectId: PROJECT,
        title: 'Comprar cimento',
        status: 'PENDENTE',
        order: 5, // max(4)+1
      });
      expect(res.status).toBe('PENDENTE');
      expect(res.roomName).toBeNull();
    });

    it('rejects a roomId from another project (BadRequest, create not called)', async () => {
      prisma.room.findFirst.mockResolvedValue(null);

      await expect(
        service.create(TENANT, PROJECT, { title: 'x', roomId: 'foreign-room' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.pendencia.create).not.toHaveBeenCalled();
      // guard resolved against the OWNER project from the route
      expect(prisma.room.findFirst).toHaveBeenCalledWith({
        where: { id: 'foreign-room', projectId: PROJECT },
      });
    });

    it('rejects a scheduleTaskId from another project (BadRequest, create not called)', async () => {
      prisma.scheduleTask.findFirst.mockResolvedValue(null);

      await expect(
        service.create(TENANT, PROJECT, { title: 'x', scheduleTaskId: 'foreign-task' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.pendencia.create).not.toHaveBeenCalled();
      expect(prisma.scheduleTask.findFirst).toHaveBeenCalledWith({
        where: { id: 'foreign-task', projectId: PROJECT, tenantId: TENANT },
      });
    });
  });

  describe('findAll', () => {
    it('scopes by tenant+project, includes chip labels and uses deterministic orderBy', async () => {
      prisma.pendencia.findMany.mockResolvedValue([]);

      await service.findAll(TENANT, PROJECT);

      expect(prisma.pendencia.findMany).toHaveBeenCalledWith({
        where: { tenantId: TENANT, projectId: PROJECT },
        include: {
          room: { select: { name: true } },
          scheduleTask: { select: { nome: true, numero: true } },
        },
        orderBy: [{ status: 'asc' }, { order: 'asc' }, { id: 'asc' }],
      });
    });

    it('maps roomName from the included room and leaves scheduleTaskNome null when absent', async () => {
      prisma.pendencia.findMany.mockResolvedValue([
        makeRow({ roomId: 'r1', room: { name: 'Cozinha' }, scheduleTask: null }),
      ]);

      const [dto] = await service.findAll(TENANT, PROJECT);

      expect(dto.roomName).toBe('Cozinha');
      expect(dto.scheduleTaskNome).toBeNull();
      expect(dto.scheduleTaskNumero).toBeNull();
    });
  });

  describe('move', () => {
    it('guards then updates status+order', async () => {
      prisma.pendencia.findFirst.mockResolvedValue(makeRow());
      prisma.pendencia.update.mockResolvedValue(makeRow({ status: 'ANDAMENTO', order: 2 }));

      const res = await service.move(TENANT, PROJECT, 'p1', { status: 'ANDAMENTO', order: 2 });

      expect(prisma.pendencia.findFirst).toHaveBeenCalledWith({
        where: { id: 'p1', tenantId: TENANT, projectId: PROJECT },
      });
      expect(prisma.pendencia.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { status: 'ANDAMENTO', order: 2 },
        include: {
          room: { select: { name: true } },
          scheduleTask: { select: { nome: true, numero: true } },
        },
      });
      expect(res.status).toBe('ANDAMENTO');
    });

    it('throws NotFound for a foreign row and does not update', async () => {
      prisma.pendencia.findFirst.mockResolvedValue(null);

      await expect(
        service.move(TENANT, PROJECT, 'foreign', { status: 'PARADO', order: 0 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.pendencia.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('guards then calls prisma.delete (soft-delete via $use) and returns {deleted:true}', async () => {
      prisma.pendencia.findFirst.mockResolvedValue(makeRow());
      prisma.pendencia.delete.mockResolvedValue(makeRow());

      const res = await service.remove(TENANT, PROJECT, 'p1');

      expect(prisma.pendencia.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
      expect(res).toEqual({ deleted: true });
    });
  });

  describe('findFinancialQueue', () => {
    it('aggregates queue groups and keeps only rows with actionable payload', async () => {
      const dueSoon = new Date();
      dueSoon.setDate(dueSoon.getDate() + 2);
      monthlyOverviewService.getAccountView.mockResolvedValue({
        cartoes: [
          {
            nickname: 'Nubank',
            last4: '1234',
            dueMonth: '2026-07',
            vencimento: dueSoon.toISOString(),
            status: 'a pagar',
            faturaPendente: 20000,
          },
        ],
        saidas: [
          {
            id: 'e1',
            descricao: 'PIX pedreiro',
            valor: 9000,
            data: '2026-07-10T00:00:00.000Z',
            isInvoice: false,
            cardLast4: null,
            bankLast4: null,
            tipoDespesa: 'OUTROS',
            realizado: false,
            foreignExpenseId: 'fx1',
            parcelaIndex: 2,
          },
        ],
        entradas: [
          {
            id: 'r1',
            descricao: 'Recebimento cliente',
            valor: 4500,
            data: '2025-01-01T00:00:00.000Z',
            status: 'PREVISTO',
          },
        ],
      });
      merchantClassifierService.fromCache.mockResolvedValue({
        category: 'alimentação',
      });

      const res = await service.findFinancialQueue(TENANT, PROJECT, '2026-07');

      expect(monthlyOverviewService.getAccountView).toHaveBeenCalledWith(TENANT, PROJECT, '2026-07');
      expect(res.total).toBe(5);
      expect(res.grupos.map((g: any) => g.tipo)).toEqual([
        'SEM_CONTA',
        'SEM_CATEGORIA',
        'FATURA_NAO_PAGA',
        'PARCELA_FOREIGN_PENDENTE',
        'RECEBIMENTO_PREVISTO_ATRASADO',
      ]);
      expect(res.grupos[0].itens[0].expenseId).toBe('e1');
      expect(res.grupos[0].itens[0].foreignExpenseId).toBe('fx1');
      expect(res.grupos[0].itens[0].parcelaIndex).toBe(2);
      expect(res.grupos[0].itens[0].label).toBe('Quitar parcela');
      expect(res.grupos[1].itens[0].suggestionTipoDespesa).toBe('ALIMENTACAO');
      expect(res.grupos[2].itens[0].cardLast4).toBe('1234');
      expect(res.grupos[3].itens[0].parcelaIndex).toBe(2);
      expect(res.grupos[4].itens[0].receiptId).toBe('r1');
    });
  });
});
