import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConciliacaoModule } from '../conciliacao/conciliacao.module';
import { CreditCardController } from './credit-card.controller';
import { CreditCardTenantController } from './credit-card-tenant.controller';
import { CreditCardService } from './credit-card.service';
import { CardInvoiceSettlementService } from './card-invoice-settlement.service';
import { MerchantClassifierModule } from '../merchant-classifier/merchant-classifier.module';

@Module({
  imports: [PrismaModule, ConciliacaoModule, MerchantClassifierModule],
  controllers: [CreditCardController, CreditCardTenantController],
  providers: [CreditCardService, CardInvoiceSettlementService],
  exports: [CardInvoiceSettlementService, CreditCardService],
})
export class CreditCardModule {}
