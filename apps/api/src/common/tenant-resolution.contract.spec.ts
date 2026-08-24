import "reflect-metadata";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  INTERCEPTORS_METADATA,
  ROUTE_ARGS_METADATA,
} from "@nestjs/common/constants";
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
import { MerchantClassifierController } from "../merchant-classifier/merchant-classifier.controller";
import { IS_PUBLIC_KEY } from "./decorators/public.decorator";
import { currentTenantFactory } from "./decorators/tenant.decorator";

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
    ["MerchantClassifierController", MerchantClassifierController],
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

/**
 * Guarda SISTÊMICA (#589).
 *
 * A lista enumerada acima é mantida à mão — foi exatamente por isso que o
 * MerchantClassifierController passou despercebido: ele usava `@CurrentTenant()`
 * sem `@UseInterceptors(TenantInterceptor)` e nenhum teste cobria essa combinação.
 *
 * Esta varredura lê o código-fonte e vale para QUALQUER controller, inclusive os
 * que ainda não existem. Um controller novo que use `@CurrentTenant()` e esqueça
 * o interceptor falha aqui, sem precisar que alguém lembre de editar uma lista.
 */
describe("tenant resolution contract (varredura de todos os controllers)", () => {
  const CONTROLLERS_ROOT = path.join(__dirname, "..");

  const listControllerFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listControllerFiles(full);
      return entry.isFile() && entry.name.endsWith(".controller.ts")
        ? [full]
        : [];
    });

  const files = listControllerFiles(CONTROLLERS_ROOT);

  it("encontra controllers para varrer (a varredura em si não pode silenciar)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  const hasTenantInterceptor = (target: object): boolean => {
    const interceptors: unknown[] =
      Reflect.getMetadata(INTERCEPTORS_METADATA, target) ?? [];
    return interceptors
      .map((i) =>
        typeof i === "function" ? i.name : (i as object)?.constructor?.name,
      )
      .includes(TenantInterceptor.name);
  };

  it("todo método que usa @CurrentTenant() é coberto pelo TenantInterceptor", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      // O fonte só DESCOBRE candidatos; a asserção é por reflexão. Casar texto
      // ("inclui TenantInterceptor") daria falso verde, porque o `import`
      // sozinho satisfaria a busca mesmo sem o `@UseInterceptors()`.
      if (!source.includes("@CurrentTenant(")) continue;

      const relative = path.relative(CONTROLLERS_ROOT, file);
      const moduleExports = require(file.replace(/\.ts$/, ""));

      for (const exported of Object.values(moduleExports)) {
        if (typeof exported !== "function") continue;
        const controller = exported as new (...args: unknown[]) => unknown;
        if (!/Controller$/.test(controller.name ?? "")) continue;

        // Cobertura na classe vale para todos os métodos.
        const classCovered = hasTenantInterceptor(controller);
        const proto = controller.prototype as Record<string, unknown>;

        for (const methodName of Object.getOwnPropertyNames(proto)) {
          if (methodName === "constructor") continue;

          // ROUTE_ARGS_METADATA fica na CLASSE mas chaveado por MÉTODO.
          const args: Record<string, { factory?: unknown }> =
            Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, methodName) ??
            {};
          const usesCurrentTenant = Object.values(args).some(
            (arg) => arg?.factory === currentTenantFactory,
          );
          if (!usesCurrentTenant) continue;

          const handler = proto[methodName];
          // TenantController aplica o interceptor por MÉTODO — legítimo.
          const methodCovered =
            typeof handler === "function" &&
            hasTenantInterceptor(handler as object);

          if (!classCovered && !methodCovered) {
            offenders.push(`${relative} :: ${controller.name}.${methodName}()`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
