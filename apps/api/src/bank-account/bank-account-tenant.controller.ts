import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BankAccountService } from './bank-account.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

/**
 * Lista contas do tenant inteiro (independente de projeto).
 * Útil para selectors no formulário de despesa (vínculo a conta de outro projeto).
 */
@ApiTags('bank-accounts')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('tenant/bank-accounts')
export class BankAccountTenantController {
  constructor(private readonly service: BankAccountService) {}

  @Get()
  @ApiOperation({ summary: 'Listar todas as contas do tenant' })
  list(@CurrentTenant() tenantId: string) {
    return this.service.listAccountsTenant(tenantId);
  }
}
