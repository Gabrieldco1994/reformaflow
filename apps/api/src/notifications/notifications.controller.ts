import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import {
  CurrentTenant,
  CurrentUser,
} from '../common/decorators/tenant.decorator';
import { resolveAccessibleProjectScope } from '../common/access-rules';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('notifications')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly service: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('daily-summary')
  @ApiOperation({
    summary: 'Resumo do dia: gastos, recebimentos, tarefas e vencimentos',
  })
  async getDailySummary(
    @CurrentTenant() tenantId: string,
    @CurrentUser()
    user: {
      role: string;
      allowedProjects?: string[];
      allowedProjectTypes?: string[];
      allowedModules?: string[];
    },
  ) {
    const scope = await resolveAccessibleProjectScope(
      this.prisma,
      tenantId,
      user.role,
      user.allowedProjects,
      user.allowedProjectTypes,
      user.allowedModules ?? [],
    );
    return this.service.getDailySummary(tenantId, scope);
  }
}
