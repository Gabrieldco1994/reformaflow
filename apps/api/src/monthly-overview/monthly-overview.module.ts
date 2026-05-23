import { Module } from '@nestjs/common';
import { MonthlyOverviewService } from './monthly-overview.service';
import { MonthlyOverviewController } from './monthly-overview.controller';

@Module({
  controllers: [MonthlyOverviewController],
  providers: [MonthlyOverviewService],
})
export class MonthlyOverviewModule {}
