import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { BankAccountController } from "./bank-account.controller";
import { BankAccountTenantController } from "./bank-account-tenant.controller";
import { BankAccountService } from "./bank-account.service";
import { MerchantClassifierModule } from "../merchant-classifier/merchant-classifier.module";
import { ConciliacaoModule } from "../conciliacao/conciliacao.module";
import { CreditCardModule } from "../credit-card/credit-card.module";
import { RestoreImportedExpensesController } from "./restore-imported-expenses.controller";
import { RestoreImportedExpensesService } from "./restore-imported-expenses.service";

@Module({
  imports: [
    PrismaModule,
    MerchantClassifierModule,
    ConciliacaoModule,
    CreditCardModule,
  ],
  controllers: [
    BankAccountController,
    BankAccountTenantController,
    RestoreImportedExpensesController,
  ],
  providers: [BankAccountService, RestoreImportedExpensesService],
  exports: [BankAccountService],
})
export class BankAccountModule {}
