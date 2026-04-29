import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ChangeOrderService } from './change-order.service';
import { CreateChangeOrderDto } from './dto/create-change-order.dto';
import { ApproveChangeOrderDto } from './dto/approve-change-order.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@ApiTags('change-orders')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('projects/:projectId/change-orders')
export class ChangeOrderController {
  constructor(private readonly service: ChangeOrderService) {}

  @Post()
  @ApiOperation({ summary: 'Criar pendência/aditivo de escopo' })
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateChangeOrderDto,
  ) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar aditivos do projeto' })
  findAll(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.findAllByProject(tenantId, projectId);
  }

  @Patch(':id/approve')
  @ApiOperation({ summary: 'Aprovar aditivo (soma ao Previsto do BudgetItem)' })
  approve(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: ApproveChangeOrderDto,
  ) {
    return this.service.approve(tenantId, projectId, id, dto);
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: 'Rejeitar aditivo' })
  reject(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.reject(tenantId, projectId, id);
  }
}
