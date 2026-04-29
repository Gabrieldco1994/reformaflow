import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { TenantModule } from './tenant/tenant.module';
import { ProjectModule } from './project/project.module';
import { BudgetItemModule } from './budget-item/budget-item.module';
import { MaterialPurchaseModule } from './material-purchase/material-purchase.module';
import { ContractorModule } from './contractor/contractor.module';
import { CashFlowModule } from './cash-flow/cash-flow.module';
import { ChangeOrderModule } from './change-order/change-order.module';

@Module({
  imports: [
    PrismaModule,
    TenantModule,
    ProjectModule,
    BudgetItemModule,
    MaterialPurchaseModule,
    ContractorModule,
    CashFlowModule,
    ChangeOrderModule,
  ],
})
export class AppModule {}
