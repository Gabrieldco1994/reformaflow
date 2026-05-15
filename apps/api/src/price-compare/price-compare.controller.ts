import { Controller, Get, Query } from '@nestjs/common';
import { PriceCompareService, PriceResult } from './price-compare.service';

@Controller('price-compare')
export class PriceCompareController {
  constructor(private readonly priceCompareService: PriceCompareService) {}

  @Get()
  async compare(@Query('q') query: string): Promise<PriceResult[]> {
    if (!query || query.trim().length < 3) {
      return [];
    }
    return this.priceCompareService.searchPrices(query);
  }
}
