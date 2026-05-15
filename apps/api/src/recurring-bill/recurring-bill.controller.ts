import { Controller, Get, Post, Patch, Delete, Param, Body, Headers } from '@nestjs/common';
import { RecurringBillService } from './recurring-bill.service';
import { CreateRecurringBillDto, UpdateRecurringBillDto } from './dto/recurring-bill.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';

@RequireModule('recurringBills')
@Controller('projects/:projectId/recurring-bills')
export class RecurringBillController {
  constructor(private readonly service: RecurringBillService) {}

  @Get()
  findAll(@Headers('x-tenant-id') tenantId: string, @Param('projectId') projectId: string) {
    return this.service.findAll(tenantId, projectId);
  }

  @Get(':id')
  findOne(@Headers('x-tenant-id') tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.findById(tenantId, projectId, id);
  }

  @Post()
  create(@Headers('x-tenant-id') tenantId: string, @Param('projectId') projectId: string, @Body() dto: CreateRecurringBillDto) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Patch(':id')
  update(@Headers('x-tenant-id') tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string, @Body() dto: UpdateRecurringBillDto) {
    return this.service.update(tenantId, projectId, id, dto);
  }

  @Delete(':id')
  remove(@Headers('x-tenant-id') tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.remove(tenantId, projectId, id);
  }
}
