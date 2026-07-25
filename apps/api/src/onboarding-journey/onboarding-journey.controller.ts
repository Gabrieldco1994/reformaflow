import { Controller, Get, Param } from '@nestjs/common';
import type { ProjectType, ResolvedJourneyStep } from '@reformaflow/domain';
import { OnboardingJourneyService } from './onboarding-journey.service';

/**
 * Leitura da jornada pelo wizard de onboarding — qualquer usuário autenticado.
 * (O `JwtAuthGuard` global já garante a autenticação; não há `@Roles` aqui de
 * propósito: quem está fazendo o onboarding é um USER comum.)
 */
@Controller('onboarding/journey')
export class OnboardingJourneyController {
  constructor(private journeys: OnboardingJourneyService) {}

  @Get(':projectType')
  get(@Param('projectType') projectType: string): Promise<ResolvedJourneyStep[]> {
    return this.journeys.getJourney(
      projectType as ProjectType,
    );
  }
}
