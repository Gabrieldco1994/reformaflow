import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PurchasePlannerController } from './purchase-planner.controller';
import { PurchasePlannerService } from './purchase-planner.service';

@Module({
  imports: [PrismaModule],
  controllers: [PurchasePlannerController],
  providers: [PurchasePlannerService],
})
export class PurchasePlannerModule {}
