import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseInterceptors } from '@nestjs/common';
import { PendenciaService } from './pendencia.service';
import { CreatePendenciaDto, UpdatePendenciaDto, MovePendenciaDto } from './dto/pendencia.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@UseInterceptors(TenantInterceptor)
@RequireModule('pendencias')
@Controller('projects/:projectId/pendencias')
export class PendenciaController {
  constructor(private readonly service: PendenciaService) {}

  @Get()
  findAll(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string) {
    return this.service.findAll(tenantId, projectId);
  }

  @Get('financeiras')
  findFinancialQueue(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Query('month') month?: string,
  ) {
    return this.service.findFinancialQueue(tenantId, projectId, month);
  }

  @Post()
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreatePendenciaDto,
  ) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Patch(':id')
  update(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePendenciaDto,
  ) {
    return this.service.update(tenantId, projectId, id, dto);
  }

  @Patch(':id/move')
  move(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: MovePendenciaDto,
  ) {
    return this.service.move(tenantId, projectId, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.remove(tenantId, projectId, id);
  }
}
