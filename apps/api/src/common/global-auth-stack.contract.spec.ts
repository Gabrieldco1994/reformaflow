import "reflect-metadata";
import { IS_PUBLIC_KEY } from "./decorators/public.decorator";
import { MonthlyOverviewController } from "../monthly-overview/monthly-overview.controller";
import { PendenciaController } from "../pendencia/pendencia.controller";

/**
 * Cheap static contract: the 7 monthly-overview GETs and the pendencias
 * financeiras queue must never carry `@Public()` (class or handler level),
 * so they stay behind the global `JwtAuthGuard` (see `jwt-auth.guard.ts`,
 * which skips real JWT validation only when `IS_PUBLIC_KEY` resolves truthy).
 * Route-level 401-without-session behavior is the global auth stack's job —
 * verified at API/browser runtime, not re-asserted here as a fake unit test
 * around `TenantInterceptor` (which only resolves an ALREADY-authenticated
 * request's tenant; it is not the auth boundary itself).
 */
describe("global auth stack — monthly-overview + pendencias financeiras stay non-public", () => {
  const MONTHLY_GETS = [
    "getOverview",
    "getAccountView",
    "getAccountViewYearly",
    "getCardInvoicesYearly",
    "getDreOverview",
    "getOriginItemsYearly",
    "getNeutros",
  ] as const;

  it("MonthlyOverviewController class is not @Public", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, MonthlyOverviewController)).toBeUndefined();
  });

  it.each(MONTHLY_GETS)("MonthlyOverviewController.%s is not @Public", (method) => {
    const handler = (MonthlyOverviewController.prototype as any)[method];
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
  });

  it("PendenciaController.findFinancialQueue is not @Public", () => {
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        PendenciaController.prototype.findFinancialQueue,
      ),
    ).toBeUndefined();
  });
});
