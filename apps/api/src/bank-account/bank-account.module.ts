import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BankAccountController } from './bank-account.controller';
import { BankAccountService } from './bank-account.service';
import { MerchantClassifierModule } from '../merchant-classifier/merchant-classifier.module';

@Module({
  imports: [PrismaModule, MerchantClassifierModule],
  controllers: [BankAccountController],
  providers: [BankAccountService],
})
export class BankAccountModule {}
