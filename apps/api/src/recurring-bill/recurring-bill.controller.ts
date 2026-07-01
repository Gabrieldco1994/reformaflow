import { Controller, Get, Post, Patch, Delete, Param, Body, UseInterceptors } from '@nestjs/common';
import { RecurringBillService } from './recurring-bill.service';
import { CreateRecurringBillDto, UpdateRecurringBillDto } from './dto/recurring-bill.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@UseInterceptors(TenantInterceptor)
@RequireModule('recurringBills')
@Controller('projects/:projectId/recurring-bills')
export class RecurringBillController {
  constructor(private readonly service: RecurringBillService) {}

  @Get()
  findAll(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string) {
    return this.service.findAll(tenantId, projectId);
  }

  @Get(':id')
  findOne(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.findById(tenantId, projectId, id);
  }

  @Post()
  create(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string, @Body() dto: CreateRecurringBillDto) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Patch(':id')
  update(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string, @Body() dto: UpdateRecurringBillDto) {
    return this.service.update(tenantId, projectId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.remove(tenantId, projectId, id);
  }
}
