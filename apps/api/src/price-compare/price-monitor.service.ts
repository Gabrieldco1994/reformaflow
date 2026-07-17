import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PriceCompareService, PriceResult } from './price-compare.service';

export interface PriceMonitorItem {
  id: string;
  tenantId: string;
  projectId: string;
  title: string;
  url?: string;
  query?: string;
  notes?: string;
  targetPrice?: number;
  alertSent: boolean;
  monitoringEndDate?: Date;
  lastCheckedAt?: Date;
  lastBestPrice?: number;
  lastBestStore?: string;
  lastBestLink?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

export interface PriceRefreshResult {
  item: PriceMonitorItem;
  alertTriggered: boolean;
  newPrice: number | null;
}

@Injectable()
export class PriceMonitorService {
  private readonly logger = new Logger(PriceMonitorService.name);
  private mutexMap = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceCompare: PriceCompareService,
  ) {}

  /**
   * Create a price monitor item with optional alert threshold and monitoring period
   */
  async createItem(
    tenantId: string,
    projectId: string,
    title: string,
    url: string,
    targetPrice?: number,
    diasMonitoramento: number = 30,
  ): Promise<PriceMonitorItem> {
    const monitoringEndDate = new Date();
    monitoringEndDate.setTime(monitoringEndDate.getTime() + diasMonitoramento * 24 * 60 * 60 * 1000);

    const item = await this.prisma.priceMonitorItem.create({
      data: {
        tenantId,
        projectId,
        title,
        url,
        targetPrice: targetPrice || null,
        alertSent: false,
        monitoringEndDate: targetPrice ? monitoringEndDate : null,
      },
    });

    return item as PriceMonitorItem;
  }

  /**
   * Update a price monitor item
   * If targetPrice/title/url/notes changes: reset alertSent to false
   * If monitoringEndDate changes: keep alertSent (extending period, not resetting)
   */
  async updateItem(
    tenantId: string,
    itemId: string,
    updates: Partial<PriceMonitorItem>,
  ): Promise<PriceMonitorItem> {
    // Get current item to check if we need to reset alertSent
    const current = await this.prisma.priceMonitorItem.findFirst({
      where: { id: itemId, tenantId, deletedAt: null },
    });

    if (!current) {
      throw new Error(`Item ${itemId} not found`);
    }

    const shouldResetAlert =
      (updates.targetPrice !== undefined && updates.targetPrice !== current.targetPrice) ||
      (updates.title !== undefined && updates.title !== current.title) ||
      (updates.url !== undefined && updates.url !== current.url) ||
      (updates.notes !== undefined && updates.notes !== current.notes);

    const updateData: any = {
      ...updates,
    };

    if (shouldResetAlert) {
      updateData.alertSent = false;
    }

    const updated = await this.prisma.priceMonitorItem.update({
      where: { id: itemId },
      data: updateData,
    });

    return updated as PriceMonitorItem;
  }

  /**
   * Check if monitoring is active for an item
   */
  isMonitoringActive(item: PriceMonitorItem | any): boolean {
    if (!item.targetPrice) return false;
    if (item.monitoringEndDate === null || item.monitoringEndDate === undefined) return true;
    return new Date(item.monitoringEndDate) > new Date();
  }

  /**
   * Refresh price and check if alert should be sent
   * Uses mutex to prevent concurrent access to the same item
   */
  async refreshAndCheckAlerts(
    tenantId: string,
    projectId: string,
    itemId: string,
  ): Promise<PriceRefreshResult> {
    // Use mutex to prevent concurrent access to the same item
    const mutexKey = `${tenantId}:${itemId}`;
    if (!this.mutexMap.has(mutexKey)) {
      this.mutexMap.set(mutexKey, Promise.resolve());
    }

    const previousPromise = this.mutexMap.get(mutexKey)!;
    let resolveCurrentPromise: () => void;

    const currentPromise = new Promise<void>((resolve) => {
      resolveCurrentPromise = resolve;
    });

    this.mutexMap.set(mutexKey, currentPromise);

    try {
      await previousPromise;

      // Get fresh item data inside critical section
      let item = await this.prisma.priceMonitorItem.findFirst({
        where: {
          id: itemId,
          tenantId,
          projectId,
          deletedAt: null,
        },
      });

      if (!item) {
        return {
          item: null as any,
          alertTriggered: false,
          newPrice: null,
        };
      }

      // Check if monitoring is still active
      const isActive = this.isMonitoringActive(item);
      if (!isActive) {
        return {
          item: item as PriceMonitorItem,
          alertTriggered: false,
          newPrice: null,
        };
      }

      // Search for prices
      const searchQuery = item.url || item.query || item.title;
      let prices: PriceResult[] = [];

      try {
        prices = await this.priceCompare.searchPrices(searchQuery);
      } catch (err) {
        this.logger.error(`Failed to search prices for item ${itemId}: ${err}`);
        prices = [];
      }

      // Find best price
      let bestPrice: number | null = null;
      let bestStore: string | null = null;
      let bestLink: string | null = null;

      if (prices.length > 0) {
        let minPrice: number | null = prices[0].price;
        let minIdx = 0;

        for (let i = 1; i < prices.length; i++) {
          const currentPrice = prices[i].price;
          if (currentPrice !== null && (minPrice === null || currentPrice < minPrice)) {
            minPrice = currentPrice;
            minIdx = i;
          }
        }

        if (minPrice !== null) {
          bestPrice = minPrice;
          bestStore = prices[minIdx].store || null;
          bestLink = prices[minIdx].link || null;
        }
      }

      // Check if alert should be triggered
      let alertTriggered = false;
      const itemTargetPrice = (item as any).targetPrice;
      const itemAlertSent = (item as any).alertSent;
      const itemUrl = (item as any).url;

      if (
        bestPrice !== null &&
        itemTargetPrice !== null &&
        itemTargetPrice !== undefined &&
        bestPrice <= itemTargetPrice &&
        !itemAlertSent
      ) {
        // Create notification
        await (this.prisma as any).notification.create({
          data: {
            tenantId,
            projectId,
            type: 'PRICE_ALERT',
            title: `${item.title} agora custa R$ ${(bestPrice / 100).toFixed(2)}`,
            body: `Seu preço-alvo era R$ ${(itemTargetPrice / 100).toFixed(2)}`,
            link: `/projects/${projectId}/price-compare`,
            data: JSON.stringify({
              itemId,
              currentPrice: bestPrice,
              targetPrice: itemTargetPrice,
              url: itemUrl,
              store: bestStore,
            }),
          },
        });

        alertTriggered = true;
      }

      // Update item with last check info and alert status
      const updatedItem = await this.prisma.priceMonitorItem.update({
        where: { id: itemId },
        data: {
          lastCheckedAt: new Date(),
          lastBestPrice: bestPrice,
          lastBestStore: bestStore,
          lastBestLink: bestLink,
          alertSent: alertTriggered ? true : itemAlertSent,
        },
      });

      return {
        item: updatedItem as any as PriceMonitorItem,
        alertTriggered,
        newPrice: bestPrice,
      };
    } finally {
      resolveCurrentPromise!();
    }
  }

  /**
   * List price monitor items for a project
   */
  async listItems(tenantId: string, projectId: string): Promise<(PriceMonitorItem & { ativo: boolean })[]> {
    const items = await this.prisma.priceMonitorItem.findMany({
      where: {
        tenantId,
        projectId,
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return items.map((item: any) => ({
      ...item,
      ativo: this.isMonitoringActive(item),
    }));
  }

  /**
   * Find all items that need to be checked (active alerts)
   */
  async findActiveAlerts(): Promise<Array<{ tenantId: string; projectId: string; id: string }>> {
    const now = new Date();

    const items = await this.prisma.priceMonitorItem.findMany({
      where: {
        deletedAt: null,
        targetPrice: { not: null },
        OR: [
          { monitoringEndDate: null },
          { monitoringEndDate: { gt: now } }
        ],
      },
      select: {
        tenantId: true,
        projectId: true,
        id: true,
      },
    });

    return items;
  }

  /**
   * Soft delete an item
   */
  async deleteItem(tenantId: string, itemId: string): Promise<void> {
    await this.prisma.priceMonitorItem.delete({
      where: { id: itemId },
    });
  }

  /**
   * Legacy method: list items by multiple projects (for agent tools)
   */
  async listByProjects(tenantId: string, projectIds: string[], limit: number = 20): Promise<any[]> {
    const items = await this.prisma.priceMonitorItem.findMany({
      where: {
        tenantId,
        projectId: { in: projectIds },
        deletedAt: null,
      },
      include: {
        project: { select: { id: true, name: true, type: true } },
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return items;
  }

  /**
   * Legacy method: find item by ID in specific projects (for agent tools)
   */
  async findByIdInProjects(tenantId: string, projectIds: string[], itemId: string): Promise<any | null> {
    return await this.prisma.priceMonitorItem.findFirst({
      where: {
        id: itemId,
        tenantId,
        projectId: { in: projectIds },
        deletedAt: null,
      },
      include: {
        project: { select: { id: true, name: true, type: true } },
      },
    });
  }

  /**
   * Legacy method: find first item matching query in specific projects (for agent tools)
   */
  async findFirstByQuery(tenantId: string, projectIds: string[], query: string): Promise<any | null> {
    return await this.prisma.priceMonitorItem.findFirst({
      where: {
        tenantId,
        projectId: { in: projectIds },
        deletedAt: null,
        OR: [
          { title: { contains: query } },
          { query: { contains: query } },
        ],
      },
      include: {
        project: { select: { id: true, name: true, type: true } },
      },
    });
  }

  /**
   * Legacy method: refresh item and return formatted result (for agent tools)
   * Uses the new refreshAndCheckAlerts internally
   */
  async refreshItem(tenantId: string, projectId: string, itemId: string): Promise<any> {
    return await this.refreshAndCheckAlerts(tenantId, projectId, itemId);
  }

  /**
   * Legacy method: search prices (for agent tools)
   * Delegates to PriceCompareService
   */
  async searchPrices(query: string, _reference?: number | null): Promise<any> {
    return await this.priceCompare.searchPrices(query);
  }
}
