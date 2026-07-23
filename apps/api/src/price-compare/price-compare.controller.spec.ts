import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PriceCompareController } from './price-compare.controller';
import { PriceCompareService } from './price-compare.service';
import { PriceMonitorService } from './price-monitor.service';

describe('PriceCompareController', () => {
  let controller: PriceCompareController;
  let priceMonitorService: any;

  beforeEach(async () => {
    priceMonitorService = {
      refreshAndCheckAlerts: jest.fn(),
      refreshAll: jest.fn(),
      getHistory: jest.fn(),
      isMonitoringActive: jest.fn().mockReturnValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PriceCompareController],
      providers: [
        { provide: PriceCompareService, useValue: {} },
        { provide: PriceMonitorService, useValue: priceMonitorService },
      ],
    }).compile();

    controller = module.get(PriceCompareController);
  });

  describe('refreshMonitorItem (fix: rota morta desde #160 — front chamava e recebia 404)', () => {
    it('returns the refreshed item on success', async () => {
      const now = new Date();
      priceMonitorService.refreshAndCheckAlerts.mockResolvedValue({
        item: {
          id: 'item-1',
          title: 'Produto',
          alertSent: false,
          lastBestPrice: 45,
          lastBestPriceCents: 4500,
          createdAt: now,
          updatedAt: now,
        },
        alertTriggered: false,
        newPrice: 4500,
      });

      const result = await controller.refreshMonitorItem(
        'tenant-1',
        'project-1',
        'item-1',
      );

      expect(priceMonitorService.refreshAndCheckAlerts).toHaveBeenCalledWith(
        'tenant-1',
        'project-1',
        'item-1',
      );
      expect(result.lastBestPriceCents).toBe(4500);
    });

    it('throws NotFoundException when the item does not exist', async () => {
      priceMonitorService.refreshAndCheckAlerts.mockResolvedValue({
        item: null,
        alertTriggered: false,
        newPrice: null,
      });

      await expect(
        controller.refreshMonitorItem('tenant-1', 'project-1', 'missing'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('refreshAllMonitorItems (fix: rota morta desde #160)', () => {
    it('returns the count of refreshed items', async () => {
      priceMonitorService.refreshAll.mockResolvedValue([{}, {}, {}]);

      const result = await controller.refreshAllMonitorItems(
        'tenant-1',
        'project-1',
      );

      expect(result).toEqual({ refreshedCount: 3 });
    });
  });

  describe('getMonitorItemHistory (issue a: PricePoint)', () => {
    it('maps PricePoint entities to the response DTO', async () => {
      const checkedAt = new Date('2026-07-01T12:00:00Z');
      priceMonitorService.getHistory.mockResolvedValue([
        {
          id: 'pp-1',
          priceCents: 4500,
          store: 'Store A',
          link: 'https://store-a.com',
          checkedAt,
        },
      ]);

      const result = await controller.getMonitorItemHistory(
        'tenant-1',
        'project-1',
        'item-1',
      );

      expect(result).toEqual([
        {
          id: 'pp-1',
          priceCents: 4500,
          store: 'Store A',
          link: 'https://store-a.com',
          checkedAt: checkedAt.toISOString(),
        },
      ]);
    });
  });
});
