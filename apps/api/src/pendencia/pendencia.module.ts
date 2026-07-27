import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PendenciaController } from './pendencia.controller';
import { PendenciaService } from './pendencia.service';
import { MonthlyOverviewModule } from '../monthly-overview/monthly-overview.module';
import { MerchantClassifierModule } from '../merchant-classifier/merchant-classifier.module';
import { BankAccountModule } from '../bank-account/bank-account.module';

@Module({
  imports: [PrismaModule, MonthlyOverviewModule, MerchantClassifierModule, BankAccountModule],
  controllers: [PendenciaController],
  providers: [PendenciaService],
})
export class PendenciaModule {}
