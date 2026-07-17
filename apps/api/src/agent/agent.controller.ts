import {
  Body,
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AgentService } from './agent.service';
import { AgentChatDto } from './dto/agent-chat.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import {
  CurrentTenant,
  CurrentUser,
} from '../common/decorators/tenant.decorator';
import { resolveAccessibleProjectScope } from '../common/access-rules';
import { PrismaService } from '../prisma/prisma.service';
import { AgentChatThrottleGuard } from './agent-chat-throttle.guard';
import { AgentDailyQuotaGuard } from './agent-daily-quota.guard';

@ApiTags('agent')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('agent')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('chat')
  @UseGuards(AgentChatThrottleGuard, AgentDailyQuotaGuard)
  @ApiOperation({
    summary: 'Conversa com o Copiloto Financeiro (tool-calling)',
  })
  async chat(
    @CurrentTenant() tenantId: string,
    @CurrentUser()
    user: {
      role: string;
      allowedProjects?: string[];
      allowedProjectTypes?: string[];
      allowedModules?: string[];
    },
    @Body() dto: AgentChatDto,
  ) {
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
      projectScope,
      role: user.role,
      allowedModules: user.allowedModules,
      messages: dto.messages,
    });
  }
}
