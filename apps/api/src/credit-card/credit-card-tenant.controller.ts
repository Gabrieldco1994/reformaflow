import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreditCardService } from './credit-card.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import {
  CurrentTenant,
  CurrentUser,
} from '../common/decorators/tenant.decorator';
import { resolveAccessibleProjectScope } from '../common/access-rules';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Lista cartões do tenant inteiro (independente de projeto).
 * Útil para selectors no formulário de despesa (vínculo a cartão de outro projeto).
 */
@ApiTags('credit-cards')
@ApiBearerAuth()
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
    );
    return this.service.listCardsTenant(tenantId, scope);
  }
}
