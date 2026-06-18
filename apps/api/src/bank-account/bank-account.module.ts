import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BankAccountController } from './bank-account.controller';
import { BankAccountTenantController } from './bank-account-tenant.controller';
import { BankAccountService } from './bank-account.service';
import { MerchantClassifierModule } from '../merchant-classifier/merchant-classifier.module';
import { ConciliacaoModule } from '../conciliacao/conciliacao.module';
import { CreditCardModule } from '../credit-card/credit-card.module';

@Module({
  imports: [PrismaModule, MerchantClassifierModule, ConciliacaoModule, CreditCardModule],
  controllers: [BankAccountController, BankAccountTenantController],
  providers: [BankAccountService],
})
export class BankAccountModule {}
