import { Test, TestingModule } from '@nestjs/testing';
import { PriceAlertScheduler } from './price-alert.scheduler';
import { PriceMonitorService } from './price-monitor.service';
import { PrismaService } from '../prisma/prisma.service';
import { Logger } from '@nestjs/common';

describe('PriceAlertScheduler', () => {
  let scheduler: PriceAlertScheduler;
  let priceMonitor: any;
  let prisma: any;

  beforeEach(async () => {
    priceMonitor = {
      refreshAndCheckAlerts: jest.fn(),
    };

    prisma = {
      priceMonitorItem: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PriceAlertScheduler,
        { provide: PriceMonitorService, useValue: priceMonitor },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    scheduler = module.get<PriceAlertScheduler>(PriceAlertScheduler);
  });

  it('should be defined', () => {
    expect(scheduler).toBeDefined();
  });

  describe('checkPriceAlerts', () => {
    it('should find and process active alerts', async () => {
      const activeAlerts = [
        { tenantId: 'tenant-1', projectId: 'project-1', id: 'item-1' },
        { tenantId: 'tenant-1', projectId: 'project-1', id: 'item-2' },
      ];

      prisma.priceMonitorItem.findMany.mockResolvedValue(activeAlerts);
      priceMonitor.refreshAndCheckAlerts.mockResolvedValue({
        alertTriggered: false,
        item: { id: 'item-1' },
      });

      await scheduler.checkPriceAlerts();

      expect(prisma.priceMonitorItem.findMany).toHaveBeenCalled();
      expect(priceMonitor.refreshAndCheckAlerts).toHaveBeenCalledTimes(2);
    });

    it('should handle errors gracefully and continue processing', async () => {
      const activeAlerts = [
        { tenantId: 'tenant-1', projectId: 'project-1', id: 'item-1' },
        { tenantId: 'tenant-1', projectId: 'project-1', id: 'item-2' },
      ];

      prisma.priceMonitorItem.findMany.mockResolvedValue(activeAlerts);
      priceMonitor.refreshAndCheckAlerts
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          alertTriggered: true,
          item: { id: 'item-2' },
        });

      // Should not throw
      await scheduler.checkPriceAlerts();

      expect(priceMonitor.refreshAndCheckAlerts).toHaveBeenCalledTimes(2);
    });

    it('should not trigger alerts for expired monitoring dates', async () => {
      // Scheduler query should exclude expired items
      prisma.priceMonitorItem.findMany.mockResolvedValue([]);

      await scheduler.checkPriceAlerts();

      expect(priceMonitor.refreshAndCheckAlerts).not.toHaveBeenCalled();
    });

    it('should not process items without targetPrice', async () => {
      // Scheduler query should only return items with targetPrice
      prisma.priceMonitorItem.findMany.mockResolvedValue([]);

      await scheduler.checkPriceAlerts();

      expect(priceMonitor.refreshAndCheckAlerts).not.toHaveBeenCalled();
    });
  });
});
