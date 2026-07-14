import "reflect-metadata";
import { INTERCEPTORS_METADATA } from "@nestjs/common/constants";
import { TenantInterceptor } from "./interceptors/tenant.interceptor";
import { PendenciaController } from "../pendencia/pendencia.controller";
import { ReminderController } from "../reminder/reminder.controller";
import { MaintenanceController } from "../maintenance/maintenance.controller";
import { RecurringBillController } from "../recurring-bill/recurring-bill.controller";
import { CarInfoController } from "../car-info/car-info.controller";
import { ScheduleController } from "../schedule/schedule.controller";
import { FloorPlanController } from "../floor-plan/floor-plan.controller";
import { PlantController } from "../plant/plant.controller";
import { PlantsAiController } from "../plants-ai/plants-ai.controller";
import { CreditCardController } from "../credit-card/credit-card.controller";
import { BankAccountController } from "../bank-account/bank-account.controller";
import { IS_PUBLIC_KEY } from "./decorators/public.decorator";

/**
 * Regression guard for tenant wiring in project-scoped controllers.
 */
describe("tenant resolution contract (project-scoped controllers)", () => {
  const controllers = [
    ["PendenciaController", PendenciaController],
    ["ReminderController", ReminderController],
    ["MaintenanceController", MaintenanceController],
    ["RecurringBillController", RecurringBillController],
    ["CarInfoController", CarInfoController],
    ["ScheduleController", ScheduleController],
    ["FloorPlanController", FloorPlanController],
    ["PlantController", PlantController],
    ["PlantsAiController", PlantsAiController],
    ["CreditCardController", CreditCardController],
    ["BankAccountController", BankAccountController],
  ] as const;

  it.each(controllers)("%s applies TenantInterceptor", (_name, controller) => {
    const interceptors: unknown[] =
      Reflect.getMetadata(INTERCEPTORS_METADATA, controller) ?? [];
    const names = interceptors.map((i) =>
      typeof i === "function" ? i.name : (i as object)?.constructor?.name,
    );
    expect(names).toContain(TenantInterceptor.name);
  });

  it.each(controllers)("%s is not @Public", (_name, controller) => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, controller)).toBeUndefined();
  });
});
