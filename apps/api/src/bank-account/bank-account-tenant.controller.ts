import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BankAccountService } from './bank-account.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant, CurrentUser } from '../common/decorators/tenant.decorator';
import { accessibleProjectScope } from '../common/access-rules';

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
  list(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { role: string; allowedProjects?: string[] },
  ) {
    return this.service.listAccountsTenant(
      tenantId,
      accessibleProjectScope(user.role, user.allowedProjects),
    );
  }
}
