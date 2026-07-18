import { Module } from '@nestjs/common';
import { FeedbackController } from './feedback.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [FeedbackController],
})
export class FeedbackModule {}
