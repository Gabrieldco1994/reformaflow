import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join, isAbsolute } from 'path';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ModulesGuard } from './common/guards/modules.guard';
import { ProjectAccessGuard } from './common/guards/project-access.guard';
import { TenantModule } from './tenant/tenant.module';
import { ProjectModule } from './project/project.module';
import { ReceiptModule } from './receipt/receipt.module';
import { ExpenseModule } from './expense/expense.module';
import { CashFlowModule } from './cash-flow/cash-flow.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MonthlyOverviewModule } from './monthly-overview/monthly-overview.module';
import { SimulationModule } from './simulation/simulation.module';
import { NotificationsModule } from './notifications/notifications.module';
import { LinkPreviewModule } from './link-preview/link-preview.module';
import { PriceCompareModule } from './price-compare/price-compare.module';
import { FloorPlanModule } from './floor-plan/floor-plan.module';
import { RecurringBillModule } from './recurring-bill/recurring-bill.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { ReminderModule } from './reminder/reminder.module';
import { PendenciaModule } from './pendencia/pendencia.module';
import { CarInfoModule } from './car-info/car-info.module';
import { ScheduleModule } from './schedule/schedule.module';
import { CreditCardModule } from './credit-card/credit-card.module';
import { BankAccountModule } from './bank-account/bank-account.module';
import { MerchantClassifierModule } from './merchant-classifier/merchant-classifier.module';
import { TenantFinancialModule } from './tenant-financial/tenant-financial.module';
import { BudgetAllocationModule } from './budget-allocation/budget-allocation.module';
import { CategoryBudgetModule } from './category-budget/category-budget.module';
import { AgentModule } from './agent/agent.module';
import { TtsModule } from './tts/tts.module';
import { PlantsAiModule } from './plants-ai/plants-ai.module';
import { PlantModule } from './plant/plant.module';

const UPLOADS_DIR = (() => {
  const raw = process.env['UPLOADS_DIR'];
  if (!raw) return join(process.cwd(), 'uploads');
  return isAbsolute(raw) ? raw : join(process.cwd(), raw);
})();

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: UPLOADS_DIR,
      serveRoot: '/uploads',
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    TenantModule,
    ProjectModule,
    ReceiptModule,
    ExpenseModule,
    CashFlowModule,
    DashboardModule,
    MonthlyOverviewModule,
    SimulationModule,
    NotificationsModule,
    LinkPreviewModule,
    PriceCompareModule,
    FloorPlanModule,
    RecurringBillModule,
    MaintenanceModule,
    ReminderModule,
    PendenciaModule,
    CarInfoModule,
    ScheduleModule,
    CreditCardModule,
    BankAccountModule,
    MerchantClassifierModule,
    TenantFinancialModule,
    BudgetAllocationModule,
    CategoryBudgetModule,
    AgentModule,
    TtsModule,
    PlantsAiModule,
    PlantModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ModulesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ProjectAccessGuard,
    },
  ],
})
export class AppModule {}
