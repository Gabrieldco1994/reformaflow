import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BudgetItemService } from './budget-item.service';
import { UpdateBudgetItemDto } from './dto/update-budget-item.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@ApiTags('budget-items')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('projects/:projectId/budget-items')
export class BudgetItemController {
  constructor(private readonly budgetItemService: BudgetItemService) {}

  @Get()
  @ApiOperation({ summary: 'Listar BudgetItems com Realizado calculado dinamicamente' })
  findAll(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.budgetItemService.findAllByProject(tenantId, projectId);
  }

  @Get('dashboard')
  @ApiOperation({ summary: 'Resumo do dashboard (KPIs + por Ambiente)' })
  getDashboard(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.budgetItemService.getDashboardSummary(tenantId, projectId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualizar valor Previsto de um BudgetItem' })
  updatePlanned(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateBudgetItemDto,
  ) {
    return this.budgetItemService.updatePlanned(tenantId, projectId, id, dto);
  }
}
