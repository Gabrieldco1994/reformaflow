import { Module } from '@nestjs/common';
import { TenantFinancialService } from './tenant-financial.service';
import { TenantFinancialController } from './tenant-financial.controller';

@Module({
  controllers: [TenantFinancialController],
  providers: [TenantFinancialService],
  exports: [TenantFinancialService],
})
export class TenantFinancialModule {}
