import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BankAccountService } from './bank-account.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import {
  CurrentTenant,
  CurrentUser,
} from '../common/decorators/tenant.decorator';
import { resolveAccessibleProjectScope } from '../common/access-rules';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Lista contas do tenant inteiro (independente de projeto).
 * Útil para selectors no formulário de despesa (vínculo a conta de outro projeto).
 */
@ApiTags('bank-accounts')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('tenant/bank-accounts')
export class BankAccountTenantController {
  constructor(
    private readonly service: BankAccountService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listar todas as contas do tenant' })
  async list(
    @CurrentTenant() tenantId: string,
    @CurrentUser()
    user: {
      role: string;
      allowedProjects?: string[];
      allowedProjectTypes?: string[];
      allowedModules?: string[];
    },
  ) {
    const scope = await resolveAccessibleProjectScope(
      this.prisma,
      tenantId,
      user.role,
      user.allowedProjects,
      user.allowedProjectTypes,
      user.allowedModules ?? [],
    );
    return this.service.listAccountsTenant(tenantId, scope);
  }
}
