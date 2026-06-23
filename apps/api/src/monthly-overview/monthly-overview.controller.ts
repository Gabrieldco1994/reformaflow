import { Controller, Get, Param, Query, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MonthlyOverviewService } from './monthly-overview.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@ApiTags('monthly-overview')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('projects/:projectId/monthly-overview')
export class MonthlyOverviewController {
  constructor(private readonly service: MonthlyOverviewService) {}

  @Get()
  @ApiOperation({
    summary: 'Visão consolidada mensal (cross-project) para projetos PESSOAL',
  })
  getOverview(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.getOverview(tenantId, projectId);
  }

  @Get('account-view')
  @ApiOperation({
    summary: 'Visão Conta real (caixa) do mês selecionado para projetos PESSOAL',
  })
  getAccountView(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Query('month') month?: string,
  ) {
    return this.service.getAccountView(tenantId, projectId, month);
  }
}
