import {
  Controller,
  Get,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TenantFinancialService } from './tenant-financial.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@ApiTags('tenant-financial')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('tenant/financial')
export class TenantFinancialController {
  constructor(private readonly service: TenantFinancialService) {}

  @Get('overview')
  @ApiOperation({ summary: 'KPIs consolidados de todos os projetos do tenant' })
  getOverview(@CurrentTenant() tenantId: string) {
    return this.service.getOverview(tenantId);
  }

  @Get('by-project')
  @ApiOperation({ summary: 'Breakdown por projeto (gasto, planejado, saldo)' })
  getByProject(@CurrentTenant() tenantId: string) {
    return this.service.getByProject(tenantId);
  }

  @Get('cash-flow')
  @ApiOperation({ summary: 'Fluxo de caixa consolidado mês a mês' })
  getCashFlow(
    @CurrentTenant() tenantId: string,
    @Query('months') months?: string,
  ) {
    const n = Math.max(1, Math.min(36, Number(months) || 12));
    return this.service.getCashFlow(tenantId, n);
  }

  @Get('by-category')
  @ApiOperation({ summary: 'Distribuição por tipo de despesa cross-project' })
  getByCategory(@CurrentTenant() tenantId: string) {
    return this.service.getByCategory(tenantId);
  }

  @Get('upcoming')
  @ApiOperation({ summary: 'Próximos vencimentos cross-project' })
  getUpcoming(
    @CurrentTenant() tenantId: string,
    @Query('days') days?: string,
  ) {
    const n = Math.max(1, Math.min(365, Number(days) || 30));
    return this.service.getUpcoming(tenantId, n);
  }

  @Get('top-suppliers')
  @ApiOperation({ summary: 'Top fornecedores agregados cross-project' })
  getTopSuppliers(
    @CurrentTenant() tenantId: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.max(1, Math.min(50, Number(limit) || 10));
    return this.service.getTopSuppliers(tenantId, n);
  }
}
