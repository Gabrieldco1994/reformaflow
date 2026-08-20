import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BankAccountService } from './bank-account.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import {
  CurrentTenant,
  CurrentUser,
} from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import {
  BANK_ACCOUNT_MODULE,
  resolveAccessibleProjectScope,
} from '../common/access-rules';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Lista contas do tenant inteiro (independente de projeto).
 * Útil para selectors no formulário de despesa (vínculo a conta de outro projeto).
 *
 * Duas travas para o MESMO módulo dono do recurso (#484 B) — ausência do
 * decorator é ausência de gate (`ModulesGuard` devolve `true` sem metadata):
 *  1. `@RequireModule(BANK_ACCOUNT_MODULE)`: falha rápido, antes do handler;
 *  2. `BANK_ACCOUNT_MODULE` em `resolveAccessibleProjectScope`: o escopo não
 *     admite projeto alcançado por módulo NÃO relacionado (quem chega em
 *     PESSOAL por `expenses` enumerava institution/nickname/last4 de toda conta
 *     do projeto). Vale mesmo se o guard for contornado por uma chamada interna
 *     ou por um refactor de rota.
 */
@ApiTags('bank-accounts')
@ApiBearerAuth()
@RequireModule(BANK_ACCOUNT_MODULE)
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
      BANK_ACCOUNT_MODULE,
    );
    return this.service.listAccountsTenant(tenantId, scope);
  }
}
