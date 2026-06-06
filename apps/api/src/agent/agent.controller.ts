import { Body, Controller, Post, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AgentService } from './agent.service';
import { AgentChatDto } from './dto/agent-chat.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@ApiTags('agent')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post('chat')
  @ApiOperation({ summary: 'Conversa com o Copiloto Financeiro (tool-calling)' })
  async chat(@CurrentTenant() tenantId: string, @Body() dto: AgentChatDto) {
    return this.agent.chat({
      tenantId,
      projectId: dto.projectId ?? null,
      messages: dto.messages,
    });
  }
}
