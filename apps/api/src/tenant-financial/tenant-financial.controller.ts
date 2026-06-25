import {
  Controller,
  Get,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TenantFinancialService } from './tenant-financial.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant, CurrentUser } from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { accessibleProjectScope } from '../common/access-rules';

interface RequestUser {
  role: string;
  allowedProjects?: string[];
}

@ApiTags('tenant-financial')
@ApiBearerAuth()
@RequireModule('financialDashboard')
@UseInterceptors(TenantInterceptor)
@Controller('tenant/financial')
export class TenantFinancialController {
  constructor(private readonly service: TenantFinancialService) {}

  @Get('overview')
  @ApiOperation({ summary: 'KPIs consolidados de todos os projetos do tenant' })
  getOverview(@CurrentTenant() tenantId: string, @CurrentUser() user: RequestUser) {
    return this.service.getOverview(tenantId, accessibleProjectScope(user.role, user.allowedProjects));
  }

  @Get('by-project')
  @ApiOperation({ summary: 'Breakdown por projeto (gasto, planejado, saldo)' })
  getByProject(@CurrentTenant() tenantId: string, @CurrentUser() user: RequestUser) {
    return this.service.getByProject(tenantId, accessibleProjectScope(user.role, user.allowedProjects));
  }

  @Get('cash-flow')
  @ApiOperation({ summary: 'Fluxo de caixa consolidado mês a mês' })
  getCashFlow(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: RequestUser,
    @Query('months') months?: string,
  ) {
    const n = Math.max(1, Math.min(36, Number(months) || 12));
    return this.service.getCashFlow(tenantId, n, accessibleProjectScope(user.role, user.allowedProjects));
  }

  @Get('by-category')
  @ApiOperation({ summary: 'Distribuição por tipo de despesa cross-project' })
  getByCategory(@CurrentTenant() tenantId: string, @CurrentUser() user: RequestUser) {
    return this.service.getByCategory(tenantId, accessibleProjectScope(user.role, user.allowedProjects));
  }

  @Get('upcoming')
  @ApiOperation({ summary: 'Próximos vencimentos cross-project' })
  getUpcoming(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: RequestUser,
    @Query('days') days?: string,
  ) {
    const n = Math.max(1, Math.min(365, Number(days) || 30));
    return this.service.getUpcoming(tenantId, n, accessibleProjectScope(user.role, user.allowedProjects));
  }

  @Get('top-suppliers')
  @ApiOperation({ summary: 'Top fornecedores agregados cross-project' })
  getTopSuppliers(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
  ) {
    const n = Math.max(1, Math.min(50, Number(limit) || 10));
    return this.service.getTopSuppliers(tenantId, n, accessibleProjectScope(user.role, user.allowedProjects));
  }
}
