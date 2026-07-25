import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import type { ProjectType, ResolvedJourneyStep } from '@reformaflow/domain';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SaveJourneyDto } from './dto/save-journey.dto';
import { OnboardingJourneyService } from './onboarding-journey.service';

/**
 * Painel do admin: configura a jornada (ordem, ligado/desligado, textos,
 * obrigatória/pulável). Escopo GLOBAL — vale para todos os tenants.
 */
@Controller('admin/onboarding/journeys')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class AdminOnboardingJourneyController {
  constructor(private journeys: OnboardingJourneyService) {}

  @Get()
  list(): Promise<Record<ProjectType, ResolvedJourneyStep[]>> {
    return this.journeys.getAllJourneys();
  }

  @Put(':projectType')
  update(
    @Param('projectType') projectType: string,
    @Body() dto: SaveJourneyDto,
  ): Promise<ResolvedJourneyStep[]> {
    return this.journeys.saveJourney(
      projectType as ProjectType,
      dto,
    );
  }
}
