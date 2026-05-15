import {
  Controller,
  Get,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CashFlowService } from './cash-flow.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';

@ApiTags('cash-flow')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@RequireModule('cashFlow')
@Controller('projects/:projectId/cash-flow')
export class CashFlowController {
  constructor(private readonly service: CashFlowService) {}

  @Get()
  @ApiOperation({ summary: 'Listar fluxo de caixa (read-only, auto-gerado) com saldo acumulado' })
  findAll(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.findAll(tenantId, projectId);
  }
}
