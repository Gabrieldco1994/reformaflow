import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@ApiTags('notifications')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get('daily-summary')
  @ApiOperation({
    summary: 'Resumo do dia: gastos, recebimentos, tarefas e vencimentos',
  })
  getDailySummary(@CurrentTenant() tenantId: string) {
    return this.service.getDailySummary(tenantId);
  }
}
