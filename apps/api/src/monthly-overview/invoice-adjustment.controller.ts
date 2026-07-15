import { Body, Controller, Delete, Param, Post, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { MonthlyOverviewService } from './monthly-overview.service';
import { CreateInvoiceAdjustmentDto } from './dto/invoice-adjustment.dto';

@ApiTags('invoice-adjustments')
@ApiBearerAuth()
@RequireModule('creditCards')
@UseInterceptors(TenantInterceptor)
@Controller('projects/:projectId/invoice-adjustments')
export class InvoiceAdjustmentController {
  constructor(private readonly service: MonthlyOverviewService) {}

  @Post()
  @ApiOperation({
    summary: 'Cria ajuste manual de fatura (inclui quitação com resíduo declarado)',
  })
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() body: CreateInvoiceAdjustmentDto,
  ) {
    return this.service.createInvoiceAdjustment(tenantId, projectId, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove ajuste manual de fatura' })
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.deleteInvoiceAdjustment(tenantId, projectId, id);
  }
}
