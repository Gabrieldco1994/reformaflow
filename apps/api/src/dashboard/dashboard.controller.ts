import {
  Controller,
  Get,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@ApiTags('dashboard')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('projects/:projectId/dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get()
  @ApiOperation({ summary: 'Dashboard com KPIs e resumos por ambiente/tipo/categoria' })
  getDashboard(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.getDashboard(tenantId, projectId);
  }
}
