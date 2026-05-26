import { Module } from '@nestjs/common';
import { BudgetAllocationService } from './budget-allocation.service';
import { BudgetAllocationController } from './budget-allocation.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [BudgetAllocationController],
  providers: [BudgetAllocationService],
  exports: [BudgetAllocationService],
})
export class BudgetAllocationModule {}
