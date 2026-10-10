import {
  Body,
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  Inject,
  Req,
  Injectable,
  forwardRef,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AgentService } from "./agent.service";
import { AgentChatDto } from "./dto/agent-chat.dto";
import { TenantInterceptor } from "../common/interceptors/tenant.interceptor";
import {
  CurrentTenant,
  CurrentUser,
} from "../common/decorators/tenant.decorator";
import { resolveAccessibleProjectScope } from "../common/access-rules";
import { PrismaService } from "../prisma/prisma.service";
import { AgentChatThrottleGuard } from "./agent-chat-throttle.guard";
import { AgentDailyQuotaGuard } from "./agent-daily-quota.guard";
import { ImportChatGuard } from "../imports/import-session/import-chat.guard";
import { ImportChatBridge } from "../imports/import-session/import-chat.bridge";
import type { Request } from "express";

// Route enhancers are instantiated in AgentModule. Delegate to the exported
// guard instance so its auth/UI dependencies remain inside ImportSessionModule.
@Injectable()
class AgentImportChatGuard implements CanActivate {
  constructor(
    @Inject(forwardRef(() => ImportChatGuard))
    private readonly boundary: ImportChatGuard,
  ) {}
  canActivate(context: ExecutionContext): boolean {
    return this.boundary.canActivate(context);
  }
}

@ApiTags("agent")
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller("agent")
export class AgentController {
  @Inject(ImportChatBridge) private readonly importChat!: ImportChatBridge;
  constructor(
    private readonly agent: AgentService,
    private readonly prisma: PrismaService,
  ) {}

  @Post("chat")
  @UseGuards(AgentImportChatGuard, AgentChatThrottleGuard, AgentDailyQuotaGuard)
  @ApiOperation({
    summary: "Conversa com o Copiloto Financeiro (tool-calling)",
  })
  async chat(
    @CurrentTenant() tenantId: string,
    @CurrentUser()
    user: {
      id: string;
      role: string;
      allowedProjects?: string[];
      allowedProjectTypes?: string[];
      allowedModules?: string[];
    },
    @Body() dto: AgentChatDto,
    @Req() request: Request,
  ) {
    const admission = this.importChat.contextForRequest(request);
    if (admission) {
      try {
        return await this.agent.chat({
          tenantId,
          userId: user.id,
          messages: dto.messages,
          importAdmission: admission,
        });
      } finally {
        this.importChat.release(admission);
      }
    }
    const projectScope = await resolveAccessibleProjectScope(
      this.prisma,
      tenantId,
      user.role,
      user.allowedProjects,
      user.allowedProjectTypes,
      user.allowedModules ?? [],
    );
    return this.agent.chat({
      tenantId,
      projectId: dto.projectId ?? null,
      // Escopo AMPLO de projeto (visibilidade). NÃO autoriza recurso financeiro:
      // as tools derivam a lente POR MÓDULO a partir da ACL bruta abaixo (#483).
      projectScope,
      role: user.role,
      allowedProjects: user.allowedProjects,
      allowedProjectTypes: user.allowedProjectTypes,
      allowedModules: user.allowedModules,
      userId: user.id,
      messages: dto.messages,
    });
  }
}
