import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { OnboardingService } from './onboarding.service';

@Controller('onboarding')
export class OnboardingController {
  constructor(private onboarding: OnboardingService) {}

  @Public()
  @Get('journey/:projectType')
  async getJourney(@Param('projectType') projectType: string) {
    return this.onboarding.getJourneyCatalog(projectType);
  }
}
