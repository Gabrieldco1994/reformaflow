import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreditCardService } from './credit-card.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import {
  CurrentTenant,
  CurrentUser,
} from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import {
  CREDIT_CARD_MODULE,
  resolveAccessibleProjectScope,
} from '../common/access-rules';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Lista cartões do tenant inteiro (independente de projeto).
 * Útil para selectors no formulário de despesa (vínculo a cartão de outro projeto).
 *
 * Duas travas para o MESMO módulo dono do recurso (#484 A) — ausência do
 * decorator é ausência de gate (`ModulesGuard` devolve `true` sem metadata):
 *  1. `@RequireModule(CREDIT_CARD_MODULE)`: falha rápido, antes do handler;
 *  2. `CREDIT_CARD_MODULE` em `resolveAccessibleProjectScope`: o escopo não
 *     admite projeto alcançado por módulo NÃO relacionado (quem chega em
 *     PESSOAL por `expenses` enumerava nickname/last4/brand/limites de todo
 *     cartão do projeto). Vale mesmo se o guard for contornado por uma chamada
 *     interna ou por um refactor de rota.
 */
@ApiTags('credit-cards')
@ApiBearerAuth()
@RequireModule(CREDIT_CARD_MODULE)
@UseInterceptors(TenantInterceptor)
@Controller('tenant/credit-cards')
export class CreditCardTenantController {
  constructor(
    private readonly service: CreditCardService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listar todos os cartões do tenant' })
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
      CREDIT_CARD_MODULE,
    );
    return this.service.listCardsTenant(tenantId, scope);
  }
}
