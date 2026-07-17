import { Test, TestingModule } from '@nestjs/testing';
import { PriceMonitorService } from './price-monitor.service';
import { PriceCompareService } from './price-compare.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PriceMonitorService', () => {
  let service: PriceMonitorService;
  let prisma: any;
  let priceCompare: any;

  beforeEach(async () => {
    prisma = {
      priceMonitorItem: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      notification: {
        create: jest.fn(),
      },
    };

    priceCompare = {
      searchPrices: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PriceMonitorService,
        { provide: PrismaService, useValue: prisma },
        { provide: PriceCompareService, useValue: priceCompare },
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
          price: 4500,
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
          price: 6000,
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
          price: 4500,
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
});
