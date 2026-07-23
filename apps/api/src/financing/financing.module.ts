import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ExpenseModule } from '../expense/expense.module';
import { FinancingController } from './financing.controller';
import { FinancingService } from './financing.service';

@Module({
  imports: [PrismaModule, ExpenseModule],
  controllers: [FinancingController],
  providers: [FinancingService],
})
export class FinancingModule {}
