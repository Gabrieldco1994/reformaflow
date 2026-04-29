import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { BudgetItemModule } from '../budget-item/budget-item.module';

@Module({
  imports: [BudgetItemModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
