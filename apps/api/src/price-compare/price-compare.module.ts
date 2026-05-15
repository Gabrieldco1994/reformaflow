import { Module } from '@nestjs/common';
import { PriceCompareService } from './price-compare.service';
import { PriceCompareController } from './price-compare.controller';

@Module({
  controllers: [PriceCompareController],
  providers: [PriceCompareService],
})
export class PriceCompareModule {}
