import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CashFlowService } from './cash-flow.service';
import { CreateCashFlowDto } from './dto/create-cash-flow.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@ApiTags('cash-flow')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('projects/:projectId/cash-flow')
export class CashFlowController {
  constructor(private readonly service: CashFlowService) {}

  @Post()
  @ApiOperation({ summary: 'Criar entrada no fluxo de caixa' })
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateCashFlowDto,
  ) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar fluxo de caixa com saldo acumulado' })
  findAll(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.findAllWithBalance(tenantId, projectId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remover entrada (soft delete)' })
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.remove(tenantId, projectId, id);
  }
}
