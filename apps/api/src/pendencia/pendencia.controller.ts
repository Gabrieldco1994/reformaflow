import { Controller, Get, Post, Patch, Delete, Param, Body, Headers } from '@nestjs/common';
import { PendenciaService } from './pendencia.service';
import { CreatePendenciaDto, UpdatePendenciaDto, MovePendenciaDto } from './dto/pendencia.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';

@RequireModule('pendencias')
@Controller('projects/:projectId/pendencias')
export class PendenciaController {
  constructor(private readonly service: PendenciaService) {}

  @Get()
  findAll(@Headers('x-tenant-id') tenantId: string, @Param('projectId') projectId: string) {
    return this.service.findAll(tenantId, projectId);
  }

  @Post()
  create(
    @Headers('x-tenant-id') tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreatePendenciaDto,
  ) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Patch(':id')
  update(
    @Headers('x-tenant-id') tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePendenciaDto,
  ) {
    return this.service.update(tenantId, projectId, id, dto);
  }

  @Patch(':id/move')
  move(
    @Headers('x-tenant-id') tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: MovePendenciaDto,
  ) {
    return this.service.move(tenantId, projectId, id, dto);
  }

  @Delete(':id')
  remove(
    @Headers('x-tenant-id') tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.remove(tenantId, projectId, id);
  }
}
