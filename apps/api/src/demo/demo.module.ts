import { Module } from '@nestjs/common';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectModule } from '../project/project.module';
import { ReceiptModule } from '../receipt/receipt.module';
import { ExpenseModule } from '../expense/expense.module';

@Module({
  imports: [PrismaModule, ProjectModule, ReceiptModule, ExpenseModule],
  controllers: [DemoController],
  providers: [DemoService],
})
export class DemoModule {}
