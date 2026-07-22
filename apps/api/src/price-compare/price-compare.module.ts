import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PriceCompareService } from './price-compare.service';
import { PriceCompareController } from './price-compare.controller';
import { PriceMonitorService } from './price-monitor.service';
import { PriceAlertScheduler } from './price-alert.scheduler';
import { PrismaModule } from '../prisma/prisma.module';
import { ExpenseModule } from '../expense/expense.module';

@Module({
  imports: [ScheduleModule.forRoot(), PrismaModule, ExpenseModule],
  controllers: [PriceCompareController],
  providers: [PriceCompareService, PriceMonitorService, PriceAlertScheduler],
  exports: [PriceMonitorService],
})
export class PriceCompareModule {}
