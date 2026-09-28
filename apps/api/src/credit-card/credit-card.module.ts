import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ConciliacaoModule } from "../conciliacao/conciliacao.module";
import { CreditCardController } from "./credit-card.controller";
import { CreditCardTenantController } from "./credit-card-tenant.controller";
import { CreditCardService } from "./credit-card.service";
import { CardInvoiceSettlementService } from "./card-invoice-settlement.service";
import { MerchantClassifierModule } from "../merchant-classifier/merchant-classifier.module";
import { RestoreInstallmentLabelsController } from "./restore-installment-labels.controller";
import { RestoreInstallmentLabelsService } from "./restore-installment-labels.service";
import { DocumentedScheduleController } from "./documented-schedule.controller";
import { DocumentedScheduleService } from "./documented-schedule.service";
import { RestoreImportedExpenseController } from "./restore-imported-expense.controller";
import { RestoreImportedExpenseService } from "./restore-imported-expense.service";

@Module({
  imports: [PrismaModule, ConciliacaoModule, MerchantClassifierModule],
  controllers: [
    CreditCardController,
    CreditCardTenantController,
    RestoreInstallmentLabelsController,
    DocumentedScheduleController,
    RestoreImportedExpenseController,
  ],
  providers: [
    CreditCardService,
    CardInvoiceSettlementService,
    RestoreInstallmentLabelsService,
    DocumentedScheduleService,
    RestoreImportedExpenseService,
  ],
  exports: [CardInvoiceSettlementService, CreditCardService],
})
export class CreditCardModule {}
