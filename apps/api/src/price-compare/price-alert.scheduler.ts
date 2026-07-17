import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PriceMonitorService } from './price-monitor.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PriceAlertScheduler implements OnModuleInit {
  private readonly logger = new Logger(PriceAlertScheduler.name);

  constructor(
    private readonly priceMonitor: PriceMonitorService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.logger.log('PriceAlertScheduler initialized');
  }

  @Cron(CronExpression.EVERY_HOUR)
  async checkPriceAlerts() {
    const now = new Date();
    this.logger.debug(`[checkPriceAlerts] Running at ${now.toISOString()}`);

    try {
      // Query: active alerts only
      const items = await this.prisma.priceMonitorItem.findMany({
        where: {
          deletedAt: null,
          targetPrice: { not: null }, // only items with alert threshold
          OR: [
            { monitoringEndDate: null }, // indefinite
            { monitoringEndDate: { gt: now } }, // not yet expired
          ],
        },
        select: { tenantId: true, projectId: true, id: true },
      });

      this.logger.log(`[checkPriceAlerts] Found ${items.length} active alerts`);

      for (const item of items) {
        try {
          const result = await this.priceMonitor.refreshAndCheckAlerts(
            item.tenantId,
            item.projectId,
            item.id,
          );
          if (result.alertTriggered) {
            this.logger.log(
              `[checkPriceAlerts] Alert triggered for item ${item.id}`,
            );
          }
        } catch (err) {
          // Don't crash on single item failure; log and continue
          this.logger.error(
            `[checkPriceAlerts] Error processing item ${item.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.logger.debug(`[checkPriceAlerts] Completed`);
    } catch (err) {
      this.logger.error(
        `[checkPriceAlerts] Fatal error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
