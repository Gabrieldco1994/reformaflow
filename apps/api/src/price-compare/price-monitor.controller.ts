import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { PriceMonitorService } from './price-monitor.service';
import {
  CreatePriceMonitorItemDto,
  UpdatePriceMonitorItemDto,
} from './dto/price-monitor-item.dto';

@UseInterceptors(TenantInterceptor)
@RequireModule('priceCompare')
@Controller('projects/:projectId/price-monitor')
export class PriceMonitorController {
  constructor(private readonly service: PriceMonitorService) {}

  @Get('items')
  list(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.list(tenantId, projectId);
  }

  @Post('items')
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreatePriceMonitorItemDto,
  ) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Patch('items/:itemId')
  update(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdatePriceMonitorItemDto,
  ) {
    return this.service.update(tenantId, projectId, itemId, dto);
  }

  @Delete('items/:itemId')
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.service.remove(tenantId, projectId, itemId);
  }

  @Post('items/:itemId/refresh')
  refreshItem(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.service.refreshItem(tenantId, projectId, itemId);
  }

  @Post('refresh')
  refreshAll(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Number(limit);
    return this.service.refreshAll(
      tenantId,
      projectId,
      Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    );
  }
}
