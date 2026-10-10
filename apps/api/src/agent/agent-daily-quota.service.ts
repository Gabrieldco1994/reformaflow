import { HttpException, HttpStatus } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";

const DAILY_LIMIT = 30;

/** Shared quota primitive. Call only after an idempotency reservation wins. */
export class AgentDailyQuotaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: { now(): Date },
  ) {}

  async consume(tenantId: string): Promise<void> {
    const dayKey = this.clock.now().toISOString().slice(0, 10);
    const bumped = await this.prisma.agentDailyQuota.updateMany({
      where: { tenantId, dayKey, deletedAt: null, count: { lt: DAILY_LIMIT } },
      data: { count: { increment: 1 } },
    });
    if (bumped.count === 1) return;
    try {
      await this.prisma.agentDailyQuota.create({
        data: { tenantId, dayKey, count: 1 },
      });
      return;
    } catch {
      // A concurrent create won; the conditional increment below owns the decision.
    }
    const retry = await this.prisma.agentDailyQuota.updateMany({
      where: { tenantId, dayKey, deletedAt: null, count: { lt: DAILY_LIMIT } },
      data: { count: { increment: 1 } },
    });
    if (retry.count === 1) return;
    throw new HttpException(
      "Limite diário da Maria atingido para este tenant (30).",
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
