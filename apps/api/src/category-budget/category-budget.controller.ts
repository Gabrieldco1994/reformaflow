import { Body, Controller, Delete, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentTenant } from '../common/decorators/tenant.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CategoryBudgetService } from './category-budget.service';
import { UpsertCategoryBudgetDto } from './dto/category-budget.dto';

@ApiTags('category-budgets')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@RequireModule('expenses')
@Controller('projects/:projectId/category-budgets')
export class CategoryBudgetController {
  constructor(private readonly service: CategoryBudgetService) {}

  @Get()
  @ApiOperation({ summary: 'Listar metas por categoria do projeto' })
  findAll(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Query('mes') mes?: string,
  ) {
    return this.service.findAll(tenantId, projectId, mes);
  }

  @Get('progress')
  @ApiOperation({ summary: 'Progresso mensal das metas por categoria' })
  progress(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Query('mes') mes: string,
  ) {
    return this.service.progress(tenantId, projectId, mes);
  }

  @Post()
  @ApiOperation({ summary: 'Criar ou atualizar meta por categoria' })
  upsert(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: UpsertCategoryBudgetDto,
  ) {
    return this.service.upsert(tenantId, projectId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remover meta por categoria' })
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.remove(tenantId, projectId, id);
  }
}
