import { Module } from '@nestjs/common';
import { ExportService } from './export.service';
import { ExportController } from './export.controller';
import { BudgetItemModule } from '../budget-item/budget-item.module';

@Module({
  imports: [BudgetItemModule],
  controllers: [ExportController],
  providers: [ExportService],
})
export class ExportModule {}
