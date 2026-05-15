import { Module } from '@nestjs/common';
import { FloorPlanController } from './floor-plan.controller';
import { FloorPlanService } from './floor-plan.service';
import { GeminiService } from './gemini.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [FloorPlanController],
  providers: [FloorPlanService, GeminiService],
})
export class FloorPlanModule {}
