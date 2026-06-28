import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ExpenseService } from './expense.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { SetParcelaStatusDto } from './dto/set-parcela-status.dto';
import { RatearDto } from './dto/ratear.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';

@ApiTags('expenses')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@RequireModule('expenses')
@Controller('projects/:projectId/expenses')
export class ExpenseController {
  constructor(private readonly service: ExpenseService) {}

  @Post()
  @ApiOperation({ summary: 'Criar despesa' })
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateExpenseDto,
  ) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar despesas do projeto (paginado)' })
  findAll(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.findAll(tenantId, projectId, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('planned')
  @ApiOperation({ summary: 'Listar despesas planejadas (para liquidação)' })
  findPlanned(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.findPlanned(tenantId, projectId);
  }

  @Get('cross-project')
  @ApiOperation({ summary: 'Listar despesas de outros projetos do tenant (para vínculo)' })
  findCrossProject(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Query('search') search?: string,
    @Query('targetProjectId') targetProjectId?: string,
    @Query('status') status?: 'PLANEJADO' | 'PAGO',
    @Query('limit') limit?: string,
  ) {
    return this.service.findCrossProject(tenantId, projectId, {
      search,
      projectId: targetProjectId,
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Buscar despesa por ID' })
  findById(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.findById(tenantId, projectId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualizar despesa' })
  update(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateExpenseDto,
  ) {
    return this.service.update(tenantId, projectId, id, dto);
  }

  @Patch(':id/parcela')
  @ApiOperation({ summary: 'Marcar/desmarcar uma parcela específica como paga' })
  setParcelaStatus(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: SetParcelaStatusDto,
  ) {
    return this.service.setParcelaStatus(tenantId, projectId, id, dto.parcela, dto.paid);
  }

  @Post(':id/pay')
  @ApiOperation({ summary: 'Liquidar despesa planejada' })
  payPlanned(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateExpenseDto,
  ) {
    return this.service.payPlanned(tenantId, projectId, id, dto);
  }

  @Post(':id/link')
  @ApiOperation({ summary: 'Vincular esta despesa a uma despesa de outro projeto' })
  link(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: { targetExpenseId: string },
  ) {
    return this.service.linkCrossProject(tenantId, projectId, id, body.targetExpenseId);
  }

  @Delete(':id/link')
  @ApiOperation({ summary: 'Remover vínculo cross-project desta despesa' })
  unlink(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.unlinkCrossProject(tenantId, projectId, id);
  }

  @Post(':id/conciliar-parcela')
  @ApiOperation({ summary: 'Concilia esta despesa com UMA parcela de despesa de outro projeto (Fase 6)' })
  conciliarParcela(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: { targetExpenseId: string; parcelaIndex?: number; realValor?: number },
  ) {
    return this.service.conciliarParcela(tenantId, projectId, id, {
      targetExpenseId: body.targetExpenseId,
      parcelaIndex: body.parcelaIndex,
      realValor: body.realValor,
    });
  }

  @Delete(':id/conciliar-parcela')
  @ApiOperation({ summary: 'Desfaz a conciliação por parcela desta despesa (reversível)' })
  desconciliar(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.desconciliar(tenantId, projectId, id);
  }

  @Post(':id/ratear')
  @ApiOperation({ summary: 'Rateia esta compra entre várias planejadas de outro projeto' })
  ratear(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: RatearDto,
  ) {
    return this.service.ratear(tenantId, projectId, id, dto.allocations);
  }

  @Delete(':id/ratear')
  @ApiOperation({ summary: 'Desfaz o rateio desta compra (reversível)' })
  desratear(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.desratear(tenantId, projectId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remover despesa (soft delete)' })
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.remove(tenantId, projectId, id);
  }

  @Post('reclassify')
  @ApiOperation({
    summary: 'Reclassifica despesas existentes via fastClassify (corrige imports antigos)',
  })
  reclassify(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Query('dryRun') dryRun?: string,
    @Query('onlyGeneric') onlyGeneric?: string,
  ) {
    return this.service.reclassifyByMerchant(tenantId, projectId, {
      dryRun: dryRun === 'true' || dryRun === '1',
      onlyGeneric: onlyGeneric !== 'false' && onlyGeneric !== '0',
    });
  }
}
