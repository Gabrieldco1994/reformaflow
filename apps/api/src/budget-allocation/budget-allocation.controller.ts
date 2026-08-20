import { Controller, Get, Param, Query, UseGuards, Req } from '@nestjs/common';
import { BudgetAllocationService } from './budget-allocation.service';
import { BudgetAllocationAdminGuard } from './budget-allocation-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireModule } from '../common/decorators/require-module.decorator';

/**
 * #449 B2 — Budget Allocation congelado: histórico administrativo, só GET.
 *
 * Não existe rota mutável aqui, para papel nenhum. Não é "escondido": o handler
 * não existe, então POST/PATCH/DELETE não têm rota. Fechar a escrita por
 * construção também elimina a única via viva de fabricação de relação
 * cross-tenant (o antigo `PATCH` gravava `targetProjectId` sem validar tenant).
 *
 * `@RequireModule` fecha #487 — o controller não tinha decorator nenhum, e
 * `ModulesGuard` devolve `true` quando não há metadado (ausência de decorator =
 * ausência de gate). O gate administrativo de verdade é o
 * `BudgetAllocationAdminGuard`; `@RequireModule` é a camada declarativa que
 * valida projeto/tipo nas rotas com `:projectId`.
 */
@Controller('budget-allocations')
@UseGuards(JwtAuthGuard, BudgetAllocationAdminGuard)
@RequireModule('dashboard')
export class BudgetAllocationController {
  constructor(private readonly budgetAllocationService: BudgetAllocationService) {}

  @Get()
  findAll(
    @Query('sourceProjectId') sourceProjectId: string,
    @Query('targetProjectId') targetProjectId: string,
    @Query('mes') mes: string,
    @Req() req: any,
  ) {
    const tenantId = req.user.tenantId;
    return this.budgetAllocationService.findAll(
      tenantId,
      { sourceProjectId, targetProjectId, mes },
      req.user,
    );
  }

  @Get('summary/:projectId')
  getSummary(@Param('projectId') projectId: string, @Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.budgetAllocationService.getSummary(projectId, tenantId);
  }

  @Get('available/:projectId')
  getAvailable(@Param('projectId') projectId: string, @Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.budgetAllocationService.calculateAvailableBudget(projectId, tenantId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.budgetAllocationService.findOne(id, tenantId, req.user);
  }
}
