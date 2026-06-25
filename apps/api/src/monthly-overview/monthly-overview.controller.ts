import { Body, Controller, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
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

  @Get('card-invoices-yearly')
  @ApiOperation({
    summary: 'Faturas de cada cartão por mês de vencimento ao longo do ano (PESSOAL)',
  })
  getCardInvoicesYearly(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Query('year') year?: string,
  ) {
    return this.service.getCardInvoicesYearly(tenantId, projectId, year);
  }

  @Get('dre-overview')
  @ApiOperation({
    summary: 'DRE pessoal (visão mensal + anual) para projetos PESSOAL',
  })
  getDreOverview(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
  ): Promise<unknown> {
    return this.service.getDreOverview(tenantId, projectId, { month, year });
  }

  @Get('origin-items-yearly')
  @ApiOperation({
    summary: 'Despesas relacionadas a uma origem (cartão/conta) no ano (PESSOAL)',
  })
  getOriginItemsYearly(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Query('year') year?: string,
    @Query('kind') kind?: string,
    @Query('last4') last4?: string,
  ) {
    return this.service.getOriginItemsYearly(tenantId, projectId, { year, kind, last4 });
  }

  @Post('pay-invoice')
  @ApiOperation({
    summary: 'Pagar fatura de cartão (gera despesa neutra + liquida o ciclo)',
  })
  payInvoice(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body()
    body: {
      cardLast4?: string;
      month?: string;
      amountCents?: number;
      bankLast4?: string;
      paymentDate?: string;
    },
  ) {
    return this.service.payInvoice(tenantId, projectId, body);
  }
}
