import { Body, Controller, Get, Param, Patch, Put, UseInterceptors } from '@nestjs/common';
import { FinancingService } from './financing.service';
import { UpsertFinancingDto, PayInstallmentDto } from './dto/financing.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@UseInterceptors(TenantInterceptor)
@RequireModule('financing')
@Controller('projects/:projectId/financing')
export class FinancingController {
  constructor(private readonly service: FinancingService) {}

  @Get()
  get(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string) {
    return this.service.get(tenantId, projectId);
  }

  @Put()
  upsert(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: UpsertFinancingDto,
  ) {
    return this.service.upsert(tenantId, projectId, dto);
  }

  @Patch('installments/:id/pay')
  pay(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: PayInstallmentDto,
  ) {
    return this.service.payInstallment(tenantId, projectId, id, dto);
  }
}
