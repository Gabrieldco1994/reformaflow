import { Module } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PaidOriginsService } from './paid-origins.service';
import { ExpenseController } from './expense.controller';
import { ConciliacaoModule } from '../conciliacao/conciliacao.module';
import { RefundPurposeService } from './refund-purpose.service';

@Module({
  imports: [ConciliacaoModule],
  controllers: [ExpenseController],
  providers: [ExpenseService, PaidOriginsService, RefundPurposeService],
  exports: [ExpenseService],
})
export class ExpenseModule {}
