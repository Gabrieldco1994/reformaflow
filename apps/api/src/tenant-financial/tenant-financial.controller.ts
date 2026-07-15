import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TenantFinancialService } from './tenant-financial.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import {
  CurrentTenant,
  CurrentUser,
} from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import {
  accessibleProjectScope,
  resolveAccessibleProjectScope,
} from '../common/access-rules';
import { PrismaService } from '../prisma/prisma.service';

interface RequestUser {
  role: string;
  allowedProjects?: string[];
  allowedProjectTypes?: string[];
  allowedModules?: string[];
}

@ApiTags('tenant-financial')
@ApiBearerAuth()
@RequireModule('financialDashboard')
@UseInterceptors(TenantInterceptor)
@Controller('tenant/financial')
export class TenantFinancialController {
  constructor(
    private readonly service: TenantFinancialService,
    private readonly prisma?: PrismaService,
  ) {}

  private withScope<T>(
    tenantId: string,
    user: RequestUser,
    run: (scope: string[] | null) => T,
  ): T | Promise<T> {
    if (!this.prisma) {
      return run(accessibleProjectScope(user.role, user.allowedProjects));
    }
    return resolveAccessibleProjectScope(
      this.prisma,
      tenantId,
      user.role,
      user.allowedProjects,
      user.allowedProjectTypes,
      user.allowedModules ?? [],
    ).then(run);
  }

  @Get('overview')
  @ApiOperation({ summary: 'KPIs consolidados de todos os projetos do tenant' })
  getOverview(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.withScope(tenantId, user, (scope) =>
      this.service.getOverview(tenantId, scope),
    );
  }

  @Get('by-project')
  @ApiOperation({ summary: 'Breakdown por projeto (gasto, planejado, saldo)' })
  getByProject(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.withScope(tenantId, user, (scope) =>
      this.service.getByProject(tenantId, scope),
    );
  }

  @Get('cash-flow')
  @ApiOperation({ summary: 'Fluxo de caixa consolidado mês a mês' })
  getCashFlow(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: RequestUser,
    @Query('months') months?: string,
  ) {
    const n = Math.max(1, Math.min(36, Number(months) || 12));
    return this.withScope(tenantId, user, (scope) =>
      this.service.getCashFlow(tenantId, n, scope),
    );
  }

  @Get('by-category')
  @ApiOperation({ summary: 'Distribuição por tipo de despesa cross-project' })
  getByCategory(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.withScope(tenantId, user, (scope) =>
      this.service.getByCategory(tenantId, scope),
    );
  }

  @Get('upcoming')
  @ApiOperation({ summary: 'Próximos vencimentos cross-project' })
  getUpcoming(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: RequestUser,
    @Query('days') days?: string,
  ) {
    const n = Math.max(1, Math.min(365, Number(days) || 30));
    return this.withScope(tenantId, user, (scope) =>
      this.service.getUpcoming(tenantId, n, scope),
    );
  }

  @Get('top-suppliers')
  @ApiOperation({ summary: 'Top fornecedores agregados cross-project' })
  getTopSuppliers(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
  ) {
    const n = Math.max(1, Math.min(50, Number(limit) || 10));
    return this.withScope(tenantId, user, (scope) =>
      this.service.getTopSuppliers(tenantId, n, scope),
    );
  }
}
