import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  AGENT_ADMISSION_CLOCK,
  type AgentAdmissionClock,
} from "./agent-admission-clock";
import { AgentDailyQuotaService } from "./agent-daily-quota.service";

@Injectable()
export class AgentDailyQuotaGuard implements CanActivate {
  private readonly quota: AgentDailyQuotaService;

  constructor(
    prisma: PrismaService,
    @Inject(AGENT_ADMISSION_CLOCK)
    clock: AgentAdmissionClock,
  ) {
    this.quota = new AgentDailyQuotaService(prisma, clock);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: { tenantId?: string } }>();
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new UnauthorizedException("Sessão inválida");

    await this.quota.consume(tenantId);
    return true;
  }
}
