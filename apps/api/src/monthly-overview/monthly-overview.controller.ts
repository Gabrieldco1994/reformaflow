import { Body, Controller, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  MonthlyOverviewService,
  MonthlyOverviewRequester,
  MonthlyOverviewMutationRequester,
} from './monthly-overview.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant, CurrentUser } from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';

@ApiTags('monthly-overview')
@ApiBearerAuth()
@RequireModule('monthlyOverview')
@UseInterceptors(TenantInterceptor)
// Route param renamed to `pessoalProjectId` (URL itself is UNCHANGED — Nest
// binds by the token declared here, not by a string in the client's URL).
// The rename is deliberate: `ModulesGuard`/`ProjectAccessGuard` key their
// pre-resolution off `request.params.projectId` specifically. Keeping that
// name would make them short-circuit with a blanket 403 (or silently allow
// any project type) BEFORE the service's own anchor resolution ever runs —
// which is what has to own the 404/403/400 distinction (#447 §6):
// absent/deleted/cross-tenant ⇒ 404, same-tenant-but-out-of-scope ⇒ 403,
// authorized-but-not-PESSOAL ⇒ 400. See `MonthlyOverviewService.resolveHub`.
@Controller('projects/:pessoalProjectId/monthly-overview')
export class MonthlyOverviewController {
  constructor(private readonly service: MonthlyOverviewService) {}

  @Get()
  @ApiOperation({
    summary: 'Visão consolidada mensal (cross-project) para projetos PESSOAL',
  })
  getOverview(
    @CurrentTenant() tenantId: string,
    @Param('pessoalProjectId') pessoalProjectId: string,
    @Query('month') month?: string,
    @CurrentUser() requester?: MonthlyOverviewRequester,
  ) {
    return this.service.getOverview(tenantId, pessoalProjectId, month, requester);
  }

  @Get('account-view')
  @ApiOperation({
    summary: 'Visão Conta real (caixa) do mês selecionado para projetos PESSOAL',
  })
  getAccountView(
    @CurrentTenant() tenantId: string,
    @Param('pessoalProjectId') pessoalProjectId: string,
    @Query('month') month?: string,
    @CurrentUser() requester?: MonthlyOverviewRequester,
  ) {
    return this.service.getAccountView(tenantId, pessoalProjectId, month, requester);
  }

  @Get('account-view-yearly')
  @ApiOperation({
    summary: 'Visão Conta real (caixa) consolidada para o ano inteiro — 12 meses agregados (PESSOAL)',
  })
  getAccountViewYearly(
    @CurrentTenant() tenantId: string,
    @Param('pessoalProjectId') pessoalProjectId: string,
    @Query('year') year?: string,
    @CurrentUser() requester?: MonthlyOverviewRequester,
  ) {
    return this.service.getAccountViewYearly(tenantId, pessoalProjectId, year, requester);
  }

  @Get('card-invoices-yearly')
  @ApiOperation({
    summary: 'Faturas de cada cartão por mês de vencimento ao longo do ano (PESSOAL)',
  })
  getCardInvoicesYearly(
    @CurrentTenant() tenantId: string,
    @Param('pessoalProjectId') pessoalProjectId: string,
    @Query('year') year?: string,
    @CurrentUser() requester?: MonthlyOverviewRequester,
  ) {
    return this.service.getCardInvoicesYearly(tenantId, pessoalProjectId, year, requester);
  }

  @Get('dre-overview')
  @ApiOperation({
    summary: 'DRE pessoal (visão mensal + anual) para projetos PESSOAL',
  })
  getDreOverview(
    @CurrentTenant() tenantId: string,
    @Param('pessoalProjectId') pessoalProjectId: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
    @CurrentUser() requester?: MonthlyOverviewRequester,
  ): Promise<unknown> {
    return this.service.getDreOverview(tenantId, pessoalProjectId, { month, year }, requester);
  }

  @Get('origin-items-yearly')
  @ApiOperation({
    summary: 'Despesas relacionadas a uma origem (cartão/conta) no ano (PESSOAL)',
  })
  getOriginItemsYearly(
    @CurrentTenant() tenantId: string,
    @Param('pessoalProjectId') pessoalProjectId: string,
    @Query('year') year?: string,
    @Query('kind') kind?: string,
    @Query('last4') last4?: string,
    @CurrentUser() requester?: MonthlyOverviewRequester,
  ) {
    return this.service.getOriginItemsYearly(
      tenantId,
      pessoalProjectId,
      { year, kind, last4 },
      requester,
    );
  }

  @Get('neutros')
  @ApiOperation({
    summary: 'Lançamentos neutros (entradas + saídas) do ano para projetos PESSOAL',
  })
  getNeutros(
    @CurrentTenant() tenantId: string,
    @Param('pessoalProjectId') pessoalProjectId: string,
    @Query('year') year?: string,
    @CurrentUser() requester?: MonthlyOverviewRequester,
  ) {
    return this.service.getNeutros(tenantId, pessoalProjectId, year, requester);
  }

  @Post('pay-invoice')
  @ApiOperation({
    summary: 'Pagar fatura de cartão (gera despesa neutra + liquida o ciclo)',
  })
  payInvoice(
    @CurrentTenant() tenantId: string,
    @CurrentUser() requester: MonthlyOverviewMutationRequester,
    @Param('pessoalProjectId') pessoalProjectId: string,
    @Body()
    body: {
      cardLast4?: string;
      month?: string;
      amountCents?: number;
      bankLast4?: string;
      paymentDate?: string;
    },
  ) {
    // O requester vai INTEIRO: é a credencial de scope do anchor (o param
    // renomeado tira `ProjectAccessGuard` do caminho, então só `resolveAnchor`
    // no service consegue barrar um anchor fora do escopo) e, pelo `id`, a
    // autoria auditada da despesa gerada.
    return this.service.payInvoice(tenantId, pessoalProjectId, body, requester);
  }

  @Post('undo-invoice-payment')
  @ApiOperation({
    summary: 'Desfazer pagamento manual de fatura de cartão (reverte pay-invoice)',
  })
  undoInvoicePayment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() requester: MonthlyOverviewMutationRequester,
    @Param('pessoalProjectId') pessoalProjectId: string,
    @Body()
    body: {
      cardLast4?: string;
      dueMonth?: string;
    },
  ) {
    return this.service.undoInvoicePayment(tenantId, pessoalProjectId, body, requester);
  }
}
