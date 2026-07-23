import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { PurchasePlannerService } from './purchase-planner.service';
import {
  CreateScenarioDto,
  UpdateScenarioDto,
  CreateScenarioItemDto,
  UpdateScenarioItemDto,
} from './dto/purchase-planner.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

// Mesmo módulo do Cockpit PESSOAL — TYPE_MODULES só concede 'monthlyOverview'
// para o tipo PESSOAL, então este guard já barra CASA/CARRO/COMPRA/REFORMA
// com 403 automaticamente (nenhuma checagem extra de tipo necessária aqui).
@UseInterceptors(TenantInterceptor)
@RequireModule('monthlyOverview')
@Controller('projects/:projectId/planejador')
export class PurchasePlannerController {
  constructor(private readonly service: PurchasePlannerService) {}

  @Get()
  findAll(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string) {
    return this.service.findAllScenarios(tenantId, projectId);
  }

  @Get(':id')
  findOne(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.findScenarioById(tenantId, projectId, id);
  }

  @Post()
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateScenarioDto,
  ) {
    return this.service.createScenario(tenantId, projectId, dto);
  }

  @Patch(':id')
  update(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateScenarioDto,
  ) {
    return this.service.updateScenario(tenantId, projectId, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.removeScenario(tenantId, projectId, id);
  }

  @Post(':id/itens')
  createItem(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') scenarioId: string,
    @Body() dto: CreateScenarioItemDto,
  ) {
    return this.service.createItem(tenantId, projectId, scenarioId, dto);
  }

  @Patch(':id/itens/:itemId')
  updateItem(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') scenarioId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateScenarioItemDto,
  ) {
    return this.service.updateItem(tenantId, projectId, scenarioId, itemId, dto);
  }

  @Delete(':id/itens/:itemId')
  removeItem(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') scenarioId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.service.removeItem(tenantId, projectId, scenarioId, itemId);
  }
}
