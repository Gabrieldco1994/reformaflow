import { Body, Controller, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { CurrentTenant, CurrentUser } from '../common/decorators/tenant.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CompleteJourneyDto } from './dto/complete-journey.dto';
import {
  CompleteJourneyResult,
  JourneysCompletionService,
} from './journeys-completion.service';
import {
  EligibleJourneyQuery,
  EligibleJourneyView,
  JourneysEligibilityService,
} from './journeys-eligibility.service';

interface RequestUser {
  id: string;
}

/**
 * Rotas user-facing de Jornadas (#339 — Etapa B), substituem
 * `OnboardingJourneyController`: qualquer usuário autenticado roda a própria
 * elegibilidade/conclusão — sem `@Roles`, mesma razão do controller que
 * substitui.
 */
@Controller('journeys')
@UseInterceptors(TenantInterceptor)
export class JourneysController {
  constructor(
    private readonly eligibility: JourneysEligibilityService,
    private readonly completion: JourneysCompletionService,
  ) {}

  @Get('eligible')
  eligible(
    @Query() query: EligibleJourneyQuery,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<EligibleJourneyView[]> {
    return this.eligibility.getEligible(query, tenantId, user.id);
  }

  @Post(':id/complete')
  complete(
    @Param('id') id: string,
    @Body() dto: CompleteJourneyDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<CompleteJourneyResult> {
    return this.completion.complete(id, dto, tenantId, user.id);
  }
}
