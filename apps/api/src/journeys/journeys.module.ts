import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { JourneyBootstrapService } from './journey-bootstrap.service';

@Module({
  imports: [PrismaModule],
  providers: [JourneyBootstrapService],
  exports: [JourneyBootstrapService],
})
export class JourneysModule {}
