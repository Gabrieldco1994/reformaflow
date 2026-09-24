import { Controller, Post, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentTenant, CurrentUser } from '../common/decorators/tenant.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { DemoService } from './demo.service';
import type { RateioRequester } from '../expense/rateio.types';

@ApiTags('demo')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('demo')
export class DemoController {
  constructor(private readonly demoService: DemoService) {}

  @Post('seed')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Seed idempotente do tenant demo (PESSOAL + REFORMA)' })
  seed(@CurrentTenant() tenantId: string, @CurrentUser() requester: RateioRequester) {
    return this.demoService.seedTenant(tenantId, requester);
  }
}
