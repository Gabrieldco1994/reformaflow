import { Module } from '@nestjs/common';
import { RecurrenceService } from './recurrence.service';
import { RecurrenceController } from './recurrence.controller';
import { ExpenseModule } from '../expense/expense.module';

@Module({
  imports: [ExpenseModule],
  controllers: [RecurrenceController],
  providers: [RecurrenceService],
  exports: [RecurrenceService],
})
export class RecurrenceModule {}
