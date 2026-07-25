import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminOnboardingJourneyController } from './admin-onboarding-journey.controller';
import { OnboardingJourneyController } from './onboarding-journey.controller';
import { OnboardingJourneyService } from './onboarding-journey.service';

@Module({
  imports: [PrismaModule],
  controllers: [OnboardingJourneyController, AdminOnboardingJourneyController],
  providers: [OnboardingJourneyService],
  exports: [OnboardingJourneyService],
})
export class OnboardingJourneyModule {}
