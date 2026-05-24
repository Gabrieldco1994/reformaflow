import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { MerchantClassifierService, type MerchantCategory } from './merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('merchant-categories')
export class MerchantClassifierController {
  constructor(
    private readonly svc: MerchantClassifierService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(@Query('q') q?: string) {
    return this.prisma.merchantCategory.findMany({
      where: q ? { merchantKey: { contains: q.toLowerCase() } } : undefined,
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }

  @Post('classify')
  async classify(@Body() body: { merchants: string[] }) {
    const map = await this.svc.classifyBatch(body.merchants ?? []);
    return Object.fromEntries(map);
  }

  @Post('override')
  override(@Body() body: { merchant: string; category: MerchantCategory; subcategory?: string }) {
    return this.svc.setManual(body.merchant, body.category, body.subcategory ?? null);
  }
}
