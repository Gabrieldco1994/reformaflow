import { Controller, Get, Put, Body, Param, UseInterceptors } from '@nestjs/common';
import { CarInfoService } from './car-info.service';
import { UpsertCarInfoDto } from './dto/car-info.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@UseInterceptors(TenantInterceptor)
@RequireModule('carInfo')
@Controller('projects/:projectId/car-info')
export class CarInfoController {
  constructor(private readonly service: CarInfoService) {}

  @Get()
  get(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.get(tenantId, projectId);
  }

  @Put()
  upsert(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: UpsertCarInfoDto,
  ) {
    return this.service.upsert(tenantId, projectId, dto);
  }
}
