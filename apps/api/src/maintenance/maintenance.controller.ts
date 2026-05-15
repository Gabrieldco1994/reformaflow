import { Controller, Get, Post, Patch, Delete, Param, Body, Headers } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';
import { CreateMaintenanceLogDto, UpdateMaintenanceLogDto } from './dto/maintenance.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';

@RequireModule('maintenance')
@Controller('projects/:projectId/maintenance-logs')
export class MaintenanceController {
  constructor(private readonly service: MaintenanceService) {}

  @Get()
  findAll(@Headers('x-tenant-id') tenantId: string, @Param('projectId') projectId: string) {
    return this.service.findAll(tenantId, projectId);
  }

  @Get(':id')
  findOne(@Headers('x-tenant-id') tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.findById(tenantId, projectId, id);
  }

  @Post()
  create(@Headers('x-tenant-id') tenantId: string, @Param('projectId') projectId: string, @Body() dto: CreateMaintenanceLogDto) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Patch(':id')
  update(@Headers('x-tenant-id') tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string, @Body() dto: UpdateMaintenanceLogDto) {
    return this.service.update(tenantId, projectId, id, dto);
  }

  @Delete(':id')
  remove(@Headers('x-tenant-id') tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.remove(tenantId, projectId, id);
  }
}
