import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SimulationService } from './simulation.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';

@ApiTags('simulation')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@RequireModule('simulation')
@Controller('projects/:projectId/simulation')
export class SimulationController {
  constructor(private readonly service: SimulationService) {}

  @Get()
  @ApiOperation({ summary: 'Dados para simulação financeira' })
  getData(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Query('scenarioId') scenarioId?: string,
  ) {
    return this.service.getData(tenantId, projectId, scenarioId);
  }

  /* ───── Scenarios CRUD ───── */

  @Get('scenarios')
  @ApiOperation({ summary: 'Listar cenários de simulação' })
  listScenarios(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.listScenarios(tenantId, projectId);
  }

  @Post('scenarios')
  @ApiOperation({ summary: 'Criar cenário de simulação' })
  createScenario(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() body: { name: string },
  ) {
    return this.service.createScenario(tenantId, projectId, body.name);
  }

  @Patch('scenarios/:scenarioId')
  @ApiOperation({ summary: 'Renomear cenário' })
  renameScenario(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('scenarioId') scenarioId: string,
    @Body() body: { name: string },
  ) {
    return this.service.renameScenario(tenantId, projectId, scenarioId, body.name);
  }

  @Delete('scenarios/:scenarioId')
  @ApiOperation({ summary: 'Excluir cenário' })
  deleteScenario(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('scenarioId') scenarioId: string,
  ) {
    return this.service.deleteScenario(tenantId, projectId, scenarioId);
  }

  @Post('scenarios/:scenarioId/duplicate')
  @ApiOperation({ summary: 'Duplicar cenário' })
  duplicateScenario(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('scenarioId') scenarioId: string,
    @Body() body: { name?: string },
  ) {
    return this.service.duplicateScenario(tenantId, projectId, scenarioId, body?.name);
  }

  @Put('scenarios/:scenarioId/values')
  @ApiOperation({ summary: 'Salvar valores simulados de um cenário' })
  saveValues(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('scenarioId') scenarioId: string,
    @Body() body: { values: Record<string, string> },
  ) {
    return this.service.saveValues(tenantId, projectId, scenarioId, body.values);
  }

  @Get('compare')
  @ApiOperation({ summary: 'Comparar cenários' })
  compareScenarios(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Query('scenarios') scenarioIds: string,
  ) {
    const ids = scenarioIds.split(',').filter(Boolean);
    return this.service.compareScenarios(tenantId, projectId, ids);
  }
}
