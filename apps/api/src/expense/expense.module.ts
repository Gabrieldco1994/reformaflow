import { Module } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PaidOriginsService } from './paid-origins.service';
import { ExpenseController } from './expense.controller';
import { ConciliacaoModule } from '../conciliacao/conciliacao.module';

@Module({
  imports: [ConciliacaoModule],
  controllers: [ExpenseController],
  providers: [ExpenseService, PaidOriginsService],
  exports: [ExpenseService],
})
export class ExpenseModule {}
