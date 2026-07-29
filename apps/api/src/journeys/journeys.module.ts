import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminJourneysController } from './admin-journeys.controller';
import { JourneyBootstrapService } from './journey-bootstrap.service';
import { JourneysAdminService } from './journeys-admin.service';
import { JourneysCompletionService } from './journeys-completion.service';
import { JourneysController } from './journeys.controller';
import { JourneysEligibilityService } from './journeys-eligibility.service';

@Module({
  imports: [PrismaModule],
  controllers: [AdminJourneysController, JourneysController],
  providers: [
    JourneyBootstrapService,
    JourneysAdminService,
    JourneysEligibilityService,
    JourneysCompletionService,
  ],
  exports: [JourneyBootstrapService],
})
export class JourneysModule {}
