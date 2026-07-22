import { Test, TestingModule } from '@nestjs/testing';
import { PriceMonitorService } from './price-monitor.service';
import { PriceCompareService } from './price-compare.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExpenseService } from '../expense/expense.service';

describe('PriceMonitorService', () => {
  let service: PriceMonitorService;
  let prisma: any;
  let priceCompare: any;
  let expenseService: any;

  beforeEach(async () => {
    prisma = {
      priceMonitorItem: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
      },
      notification: {
        create: jest.fn(),
      },
    };

    priceCompare = {
      searchPrices: jest.fn(),
    };
    expenseService = {
      create: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PriceMonitorService,
        { provide: PrismaService, useValue: prisma },
        { provide: PriceCompareService, useValue: priceCompare },
        { provide: ExpenseService, useValue: expenseService },
      ],
    }).compile();

    service = module.get<PriceMonitorService>(PriceMonitorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createItem', () => {
    it('should create an item with targetPrice and compute monitoringEndDate', async () => {
      const now = new Date();
      const diasMonitoramento = 30;
      const expectedEndDate = new Date(now.getTime() + diasMonitoramento * 24 * 60 * 60 * 1000);

      prisma.priceMonitorItem.create.mockResolvedValue({
        id: 'item-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        title: 'Test Item',
        url: 'https://example.com',
        targetPrice: 5000,
        alertSent: false,
        monitoringEndDate: expectedEndDate,
        createdAt: now,
        updatedAt: now,
      });

      const result = await service.createItem(
        'tenant-1',
        'project-1',
        'Test Item',
        'https://example.com',
        5000,
        diasMonitoramento,
      );

      expect(result.id).toBe('item-1');
      expect(result.targetPrice).toBe(5000);
      expect(result.alertSent).toBe(false);
      expect(prisma.priceMonitorItem.create).toHaveBeenCalled();
    });

    it('should create an item without alert when targetPrice is not provided', async () => {
      const now = new Date();
      prisma.priceMonitorItem.create.mockResolvedValue({
        id: 'item-2',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        title: 'Test Item',
        url: 'https://example.com',
        targetPrice: null,
        alertSent: false,
        monitoringEndDate: null,
        createdAt: now,
        updatedAt: now,
      });

      const result = await service.createItem(
        'tenant-1',
        'project-1',
        'Test Item',
        'https://example.com',
      );

      expect(result.targetPrice).toBeNull();
      expect(result.monitoringEndDate).toBeNull();
    });
  });

  describe('updateItem', () => {
    it('should reset alertSent when targetPrice changes', async () => {
      const now = new Date();
      const currentItem = {
        id: 'item-1',
        tenantId: 'tenant-1',
        targetPrice: 5000,
        alertSent: true,
        title: 'Test',
        url: 'http://example.com',
        notes: null,
      };

      prisma.priceMonitorItem.findFirst.mockResolvedValue(currentItem);
      prisma.priceMonitorItem.update.mockResolvedValue({
        ...currentItem,
        targetPrice: 4500,
        alertSent: false,
        updatedAt: now,
      });

      const result = await service.updateItem('tenant-1', 'item-1', {
        targetPrice: 4500,
      });

      expect(result.alertSent).toBe(false);
      expect(result.targetPrice).toBe(4500);
    });

    it('should reset alertSent when title changes', async () => {
      const currentItem = {
        id: 'item-1',
        tenantId: 'tenant-1',
        targetPrice: 5000,
        alertSent: true,
        title: 'Old Title',
        url: 'http://example.com',
        notes: null,
      };

      prisma.priceMonitorItem.findFirst.mockResolvedValue(currentItem);
      prisma.priceMonitorItem.update.mockResolvedValue({
        ...currentItem,
        title: 'New Title',
        alertSent: false,
      });

      const result = await service.updateItem('tenant-1', 'item-1', {
        title: 'New Title',
      });

      expect(result.alertSent).toBe(false);
    });

    it('should NOT reset alertSent when monitoringEndDate changes', async () => {
      const now = new Date();
      const newEndDate = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
      const currentItem = {
        id: 'item-1',
        tenantId: 'tenant-1',
        targetPrice: 5000,
        alertSent: true,
        title: 'Test',
        url: 'http://example.com',
        notes: null,
        monitoringEndDate: now,
      };

      prisma.priceMonitorItem.findFirst.mockResolvedValue(currentItem);
      prisma.priceMonitorItem.update.mockResolvedValue({
        ...currentItem,
        monitoringEndDate: newEndDate,
        alertSent: true, // should remain true
      });

      const result = await service.updateItem('tenant-1', 'item-1', {
        monitoringEndDate: newEndDate,
      });

      expect(result.alertSent).toBe(true);
    });
  });

  describe('isMonitoringActive', () => {
    it('should return false if no targetPrice', () => {
      const item = {
        targetPrice: null,
        monitoringEndDate: new Date(),
      };

      expect(service.isMonitoringActive(item)).toBe(false);
    });

    it('should return true if targetPrice exists and monitoringEndDate is null', () => {
      const item = {
        targetPrice: 5000,
        monitoringEndDate: null,
      };

      expect(service.isMonitoringActive(item)).toBe(true);
    });

    it('should return true for the canonical cents target', () => {
      expect(
        service.isMonitoringActive({
          isActive: true,
          targetPriceCents: 250_000,
          monitoringEndDate: null,
        }),
      ).toBe(true);
    });

    it('should return true if monitoringEndDate is in the future', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);

      const item = {
        targetPrice: 5000,
        monitoringEndDate: futureDate,
      };

      expect(service.isMonitoringActive(item)).toBe(true);
    });

    it('should return false if monitoringEndDate is in the past', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const item = {
        targetPrice: 5000,
        monitoringEndDate: pastDate,
      };

      expect(service.isMonitoringActive(item)).toBe(false);
    });
  });

  describe('refreshAndCheckAlerts', () => {
    it('should trigger alert when price <= targetPrice and alertSent is false', async () => {
      const item = {
        id: 'item-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        targetPrice: 5000,
        alertSent: false,
        monitoringEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        url: 'https://example.com',
        title: 'Test Product',
      };

      prisma.priceMonitorItem.findFirst.mockResolvedValue(item);
      priceCompare.searchPrices.mockResolvedValue([
        {
          title: 'Product',
          price: 45,
          currency: 'BRL',
          store: 'Store A',
          link: 'https://store-a.com',
        },
      ]);

      prisma.notification.create.mockResolvedValue({
        id: 'notif-1',
      });

      prisma.priceMonitorItem.update.mockResolvedValue({
        ...item,
        lastBestPrice: 4500,
        lastBestStore: 'Store A',
        alertSent: true,
      });

      const result = await service.refreshAndCheckAlerts('tenant-1', 'project-1', 'item-1');

      expect(result.alertTriggered).toBe(true);
      expect(result.newPrice).toBe(4500);
      expect(prisma.notification.create).toHaveBeenCalled();
      expect(prisma.priceMonitorItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'item-1' },
          data: expect.objectContaining({
            alertSent: true,
            lastBestPrice: 45,
            lastBestPriceCents: 4500,
          }),
        }),
      );
    });

    it('should NOT trigger alert when price > targetPrice', async () => {
      const item = {
        id: 'item-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        targetPrice: 5000,
        alertSent: false,
        monitoringEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        url: 'https://example.com',
        title: 'Test Product',
      };

      prisma.priceMonitorItem.findFirst.mockResolvedValue(item);
      priceCompare.searchPrices.mockResolvedValue([
        {
          title: 'Product',
          price: 60,
          currency: 'BRL',
          store: 'Store A',
          link: 'https://store-a.com',
        },
      ]);

      prisma.priceMonitorItem.update.mockResolvedValue({
        ...item,
        lastBestPrice: 6000,
        alertSent: false,
      });

      const result = await service.refreshAndCheckAlerts('tenant-1', 'project-1', 'item-1');

      expect(result.alertTriggered).toBe(false);
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('should NOT trigger alert if alertSent is already true', async () => {
      const item = {
        id: 'item-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        targetPrice: 5000,
        alertSent: true, // already sent
        monitoringEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        url: 'https://example.com',
        title: 'Test Product',
      };

      prisma.priceMonitorItem.findFirst.mockResolvedValue(item);
      priceCompare.searchPrices.mockResolvedValue([
        {
          title: 'Product',
          price: 45,
          currency: 'BRL',
          store: 'Store A',
          link: 'https://store-a.com',
        },
      ]);

      prisma.priceMonitorItem.update.mockResolvedValue({
        ...item,
        lastBestPrice: 4500,
      });

      const result = await service.refreshAndCheckAlerts('tenant-1', 'project-1', 'item-1');

      expect(result.alertTriggered).toBe(false);
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('should NOT trigger alert if monitoring is not active (monitoringEndDate is past)', async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const item = {
        id: 'item-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        targetPrice: 5000,
        alertSent: false,
        monitoringEndDate: pastDate, // expired
        url: 'https://example.com',
        title: 'Test Product',
      };

      prisma.priceMonitorItem.findFirst.mockResolvedValue(item);

      const result = await service.refreshAndCheckAlerts('tenant-1', 'project-1', 'item-1');

      expect(result.alertTriggered).toBe(false);
      expect(priceCompare.searchPrices).not.toHaveBeenCalled();
    });
  });

  describe('listItems', () => {
    it('should list items with ativo field', async () => {
      const now = new Date();
      const futureDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      prisma.priceMonitorItem.findMany.mockResolvedValue([
        {
          id: 'item-1',
          targetPrice: 5000,
          monitoringEndDate: futureDate,
          createdAt: now,
        },
        {
          id: 'item-2',
          targetPrice: null,
          monitoringEndDate: null,
          createdAt: now,
        },
      ]);

      const result = await service.listItems('tenant-1', 'project-1');

      expect(result).toHaveLength(2);
      expect(result[0].ativo).toBe(true);
      expect(result[1].ativo).toBe(false);
    });
  });

  describe('findActiveAlerts', () => {
    it('should find only items with targetPrice and valid monitoringEndDate', async () => {
      const now = new Date();
      const futureDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      prisma.priceMonitorItem.findMany.mockResolvedValue([
        {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          id: 'item-1',
        },
      ]);

      const result = await service.findActiveAlerts();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('item-1');
    });
  });

  describe('comprarAgora', () => {
    const item = {
      id: 'item-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      title: 'Geladeira',
      isActive: true,
      lastBestPriceCents: 279_990,
      referencePriceCents: 300_000,
      lastBestStore: 'Loja A',
      lastBestLink: 'https://loja-a.example/produto',
      deletedAt: null,
    };

    it('creates a paid cash expense and closes monitoring', async () => {
      prisma.priceMonitorItem.findFirst.mockResolvedValue(item);
      expenseService.create.mockResolvedValue({ id: 'expense-1' });
      prisma.priceMonitorItem.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.comprarAgora(
        'tenant-1',
        'project-1',
        'item-1',
        { quantidade: 1, formaPagamento: 'A_VISTA' },
        'user-1',
      );

      expect(expenseService.create).toHaveBeenCalledWith(
        'tenant-1',
        'project-1',
        expect.objectContaining({
          titulo: 'Geladeira',
          valor: 2799.9,
          quantidade: 1,
          formaPagamento: 'A_VISTA',
          status: 'PAGO',
        }),
        'user-1',
      );
      expect(prisma.priceMonitorItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'item-1',
            tenantId: 'tenant-1',
            projectId: 'project-1',
            isActive: true,
          }),
          data: expect.objectContaining({ isActive: false }),
        }),
      );
      expect(result.pricePaidCents).toBe(279_990);
    });

    it('keeps purchase date separate from installment start', async () => {
      prisma.priceMonitorItem.findFirst.mockResolvedValue(item);
      expenseService.create.mockResolvedValue({ id: 'expense-2' });
      prisma.priceMonitorItem.updateMany.mockResolvedValue({ count: 1 });

      await service.comprarAgora(
        'tenant-1',
        'project-1',
        'item-1',
        {
          quantidade: 1,
          formaPagamento: 'PARCELADO',
          parcelas: 12,
          dataCompra: '2026-07-22',
          dataInicio: '2026-08-10',
        },
        'user-1',
      );

      expect(expenseService.create).toHaveBeenCalledWith(
        'tenant-1',
        'project-1',
        expect.objectContaining({
          quantidadeParcela: 12,
          dataCompra: '2026-07-22',
          dataInicioParcela: '2026-08-10',
          status: 'PLANEJADO',
        }),
        'user-1',
      );
    });

    it('converts a legacy price in reais to cents', async () => {
      prisma.priceMonitorItem.findFirst.mockResolvedValue({
        ...item,
        lastBestPriceCents: null,
        referencePriceCents: 999_900,
        lastBestPrice: 2799.9,
      });
      expenseService.create.mockResolvedValue({ id: 'expense-legacy' });
      prisma.priceMonitorItem.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.comprarAgora(
        'tenant-1',
        'project-1',
        'item-1',
        { quantidade: 1, formaPagamento: 'A_VISTA' },
        'user-1',
      );

      expect(expenseService.create).toHaveBeenCalledWith(
        'tenant-1',
        'project-1',
        expect.objectContaining({ valor: 2799.9 }),
        'user-1',
      );
      expect(result.pricePaidCents).toBe(279_990);
    });

    it('defaults the purchase date to the São Paulo calendar day', async () => {
      jest.useFakeTimers().setSystemTime(
        new Date('2026-07-23T01:00:00.000Z'),
      );
      prisma.priceMonitorItem.findFirst.mockResolvedValue(item);
      expenseService.create.mockResolvedValue({ id: 'expense-date' });
      prisma.priceMonitorItem.updateMany.mockResolvedValue({ count: 1 });

      try {
        await service.comprarAgora(
          'tenant-1',
          'project-1',
          'item-1',
          { quantidade: 1, formaPagamento: 'A_VISTA' },
          'user-1',
        );

        expect(expenseService.create).toHaveBeenCalledWith(
          'tenant-1',
          'project-1',
          expect.objectContaining({
            dataCompra: '2026-07-22T00:00:00.000Z',
          }),
          'user-1',
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('rejects an expired monitor without creating an expense', async () => {
      prisma.priceMonitorItem.findFirst.mockResolvedValue({
        ...item,
        monitoringEndDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });

      await expect(
        service.comprarAgora(
          'tenant-1',
          'project-1',
          'item-1',
          { quantidade: 1, formaPagamento: 'A_VISTA' },
          'user-1',
        ),
      ).rejects.toThrow('Este monitoramento já foi encerrado');
      expect(expenseService.create).not.toHaveBeenCalled();
    });

    it('removes the expense when closing monitoring fails', async () => {
      prisma.priceMonitorItem.findFirst.mockResolvedValue(item);
      expenseService.create.mockResolvedValue({ id: 'expense-3' });
      prisma.priceMonitorItem.updateMany.mockRejectedValue(
        new Error('database unavailable'),
      );

      await expect(
        service.comprarAgora(
          'tenant-1',
          'project-1',
          'item-1',
          { quantidade: 1, formaPagamento: 'A_VISTA' },
          'user-1',
        ),
      ).rejects.toThrow('database unavailable');
      expect(expenseService.remove).toHaveBeenCalledWith(
        'tenant-1',
        'project-1',
        'expense-3',
      );
    });

    it('waits for an in-flight price refresh before purchasing', async () => {
      let finishSearch!: (value: any[]) => void;
      const searchPending = new Promise<any[]>((resolve) => {
        finishSearch = resolve;
      });
      prisma.priceMonitorItem.findFirst.mockResolvedValue({
        ...item,
        targetPriceCents: 300_000,
        alertSent: false,
        monitoringEndDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        url: 'https://example.com',
      });
      priceCompare.searchPrices.mockReturnValue(searchPending);
      prisma.priceMonitorItem.update.mockResolvedValue(item);
      prisma.notification.create.mockResolvedValue({ id: 'notification-1' });
      expenseService.create.mockResolvedValue({ id: 'expense-4' });
      prisma.priceMonitorItem.updateMany.mockResolvedValue({ count: 1 });

      const refreshPromise = service.refreshAndCheckAlerts(
        'tenant-1',
        'project-1',
        'item-1',
      );
      await Promise.resolve();
      const purchasePromise = service.comprarAgora(
        'tenant-1',
        'project-1',
        'item-1',
        { quantidade: 1, formaPagamento: 'A_VISTA' },
        'user-1',
      );
      await Promise.resolve();

      expect(expenseService.create).not.toHaveBeenCalled();

      finishSearch([
        {
          title: 'Geladeira',
          price: 2799.9,
          currency: 'BRL',
          store: 'Loja A',
          link: 'https://loja-a.example/produto',
        },
      ]);
      await refreshPromise;
      await purchasePromise;

      expect(expenseService.create).toHaveBeenCalledTimes(1);
    });
  });
});
