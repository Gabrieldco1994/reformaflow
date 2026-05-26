import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreditCardService } from './credit-card.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

/**
 * Lista cartões do tenant inteiro (independente de projeto).
 * Útil para selectors no formulário de despesa (vínculo a cartão de outro projeto).
 */
@ApiTags('credit-cards')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('tenant/credit-cards')
export class CreditCardTenantController {
  constructor(private readonly service: CreditCardService) {}

  @Get()
  @ApiOperation({ summary: 'Listar todos os cartões do tenant' })
  list(@CurrentTenant() tenantId: string) {
    return this.service.listCardsTenant(tenantId);
  }
}
