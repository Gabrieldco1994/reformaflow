import { Controller, Get, Post, Patch, Delete, Param, Body, UseInterceptors } from '@nestjs/common';
import { ReminderService } from './reminder.service';
import { CreateReminderDto, UpdateReminderDto } from './dto/reminder.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@UseInterceptors(TenantInterceptor)
@RequireModule('reminders')
@Controller('projects/:projectId/reminders')
export class ReminderController {
  constructor(private readonly service: ReminderService) {}

  @Get()
  findAll(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string) {
    return this.service.findAll(tenantId, projectId);
  }

  @Get(':id')
  findOne(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.findById(tenantId, projectId, id);
  }

  @Post()
  create(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string, @Body() dto: CreateReminderDto) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Patch(':id')
  update(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string, @Body() dto: UpdateReminderDto) {
    return this.service.update(tenantId, projectId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.remove(tenantId, projectId, id);
  }
}
