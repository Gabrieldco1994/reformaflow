import { Module } from '@nestjs/common';
import { TenantFinancialService } from './tenant-financial.service';
import { MonthlyOverviewModule } from '../monthly-overview/monthly-overview.module';

@Module({
  imports: [MonthlyOverviewModule],
  providers: [TenantFinancialService],
  exports: [TenantFinancialService],
})
export class TenantFinancialModule {}
