import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RecurringBillController } from './recurring-bill.controller';
import { RecurringBillService } from './recurring-bill.service';

@Module({
  imports: [PrismaModule],
  controllers: [RecurringBillController],
  providers: [RecurringBillService],
})
export class RecurringBillModule {}
