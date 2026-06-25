import { Body, Controller, Post, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AgentService } from './agent.service';
import { AgentChatDto } from './dto/agent-chat.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant, CurrentUser } from '../common/decorators/tenant.decorator';
import { accessibleProjectScope } from '../common/access-rules';

@ApiTags('agent')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post('chat')
  @ApiOperation({ summary: 'Conversa com o Copiloto Financeiro (tool-calling)' })
  async chat(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { role: string; allowedProjects?: string[]; allowedModules?: string[] },
    @Body() dto: AgentChatDto,
  ) {
    return this.agent.chat({
      tenantId,
      projectId: dto.projectId ?? null,
      projectScope: accessibleProjectScope(user.role, user.allowedProjects),
      role: user.role,
      allowedModules: user.allowedModules,
      messages: dto.messages,
    });
  }
}
