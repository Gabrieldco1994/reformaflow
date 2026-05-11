import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { TenantModule } from './tenant/tenant.module';
import { ProjectModule } from './project/project.module';
import { ReceiptModule } from './receipt/receipt.module';
import { ExpenseModule } from './expense/expense.module';
import { CashFlowModule } from './cash-flow/cash-flow.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { SimulationModule } from './simulation/simulation.module';
import { NotificationsModule } from './notifications/notifications.module';
import { LinkPreviewModule } from './link-preview/link-preview.module';

@Module({
  imports: [
    PrismaModule,
    TenantModule,
    ProjectModule,
    ReceiptModule,
    ExpenseModule,
    CashFlowModule,
    DashboardModule,
    SimulationModule,
    NotificationsModule,
    LinkPreviewModule,
  ],
})
export class AppModule {}
