import { Controller, Get, Put, Body, Param, Headers } from '@nestjs/common';
import { CarInfoService } from './car-info.service';
import { UpsertCarInfoDto } from './dto/car-info.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';

@RequireModule('carInfo')
@Controller('projects/:projectId/car-info')
export class CarInfoController {
  constructor(private readonly service: CarInfoService) {}

  @Get()
  get(
    @Headers('x-tenant-id') tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.get(tenantId, projectId);
  }

  @Put()
  upsert(
    @Headers('x-tenant-id') tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: UpsertCarInfoDto,
  ) {
    return this.service.upsert(tenantId, projectId, dto);
  }
}
