import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FinancingController } from './financing.controller';
import { FinancingService } from './financing.service';

@Module({
  imports: [PrismaModule],
  controllers: [FinancingController],
  providers: [FinancingService],
})
export class FinancingModule {}
