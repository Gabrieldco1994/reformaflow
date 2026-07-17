import { Module } from '@nestjs/common';
import { PriceCompareService } from './price-compare.service';
import { PriceCompareController } from './price-compare.controller';
import { PriceMonitorService } from './price-monitor.service';
import { PriceMonitorController } from './price-monitor.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PriceCompareController, PriceMonitorController],
  providers: [PriceCompareService, PriceMonitorService],
  exports: [PriceCompareService, PriceMonitorService],
})
export class PriceCompareModule {}
