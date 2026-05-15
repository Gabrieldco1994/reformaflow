import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ExpenseService } from './expense.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
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
  @ApiOperation({ summary: 'Listar despesas do projeto' })
  findAll(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.findAll(tenantId, projectId);
  }

  @Get('planned')
  @ApiOperation({ summary: 'Listar despesas planejadas (para liquidação)' })
  findPlanned(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.findPlanned(tenantId, projectId);
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

  @Delete(':id')
  @ApiOperation({ summary: 'Remover despesa (soft delete)' })
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.remove(tenantId, projectId, id);
  }
}
