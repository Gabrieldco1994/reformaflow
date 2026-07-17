import { Module } from '@nestjs/common';
import { MonthlyOverviewService } from './monthly-overview.service';
import { MonthlyOverviewController } from './monthly-overview.controller';
import { CreditCardModule } from '../credit-card/credit-card.module';
import { InvoiceAdjustmentController } from './invoice-adjustment.controller';

@Module({
  imports: [CreditCardModule],
  controllers: [MonthlyOverviewController, InvoiceAdjustmentController],
  providers: [MonthlyOverviewService],
  exports: [MonthlyOverviewService],
})
export class MonthlyOverviewModule {}
