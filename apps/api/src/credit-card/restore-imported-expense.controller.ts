import { Body, Controller, Param, Post, UseInterceptors } from "@nestjs/common";
import { RequireModule } from "../common/decorators/require-module.decorator";
import {
  CurrentTenant,
  CurrentUser,
} from "../common/decorators/tenant.decorator";
import { TenantInterceptor } from "../common/interceptors/tenant.interceptor";
import { RateioRequester } from "../expense/rateio.types";
import { RestoreImportedExpenseService } from "./restore-imported-expense.service";

@RequireModule("creditCards", "expenses")
@UseInterceptors(TenantInterceptor)
@Controller(
  "projects/:ownerProjectId/credit-cards/:cardId/imports/:importId/expenses/:expenseId",
)
export class RestoreImportedExpenseController {
  constructor(private readonly service: RestoreImportedExpenseService) {}

  @Post("restore")
  restore(
    @CurrentTenant() tenantId: string,
    @CurrentUser() requester: RateioRequester,
    @Param("ownerProjectId") projectId: string,
    @Param("cardId") cardId: string,
    @Param("importId") importId: string,
    @Param("expenseId") expenseId: string,
    @Body() body: unknown,
  ) {
    return this.service.restore(
      { tenantId, projectId, cardId, importId, expenseId },
      requester,
      body,
    );
  }
}
