import { Module } from '@nestjs/common';
import { TenantFinancialService } from './tenant-financial.service';
import { TenantFinancialController } from './tenant-financial.controller';
import { MonthlyOverviewModule } from '../monthly-overview/monthly-overview.module';

@Module({
  imports: [MonthlyOverviewModule],
  controllers: [TenantFinancialController],
  providers: [TenantFinancialService],
  exports: [TenantFinancialService],
})
export class TenantFinancialModule {}
