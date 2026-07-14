import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DAILY_LIMIT = 30;

@Injectable()
export class AgentDailyQuotaGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ user?: { tenantId?: string } }>();
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new UnauthorizedException('Sessão inválida');

    await this.consumeDailyQuota(tenantId);
    return true;
  }

  private async consumeDailyQuota(tenantId: string): Promise<void> {
    const dayKey = new Date().toISOString().slice(0, 10);

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
      // corrida de criação concorrente; tenta incrementar de novo
    }

    const retry = await this.prisma.agentDailyQuota.updateMany({
      where: { tenantId, dayKey, deletedAt: null, count: { lt: DAILY_LIMIT } },
      data: { count: { increment: 1 } },
    });
    if (retry.count === 1) return;

    throw new HttpException(
      'Limite diário da Maria atingido para este tenant (30).',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
