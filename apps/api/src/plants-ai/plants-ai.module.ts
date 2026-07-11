import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PlantModule } from '../plant/plant.module';
import { PlantsAiController } from './plants-ai.controller';
import { PlantsAiService } from './plants-ai.service';

@Module({
  imports: [PrismaModule, PlantModule],
  controllers: [PlantsAiController],
  providers: [PlantsAiService],
})
export class PlantsAiModule {}

