import { Body, Controller, Param, Post, UseInterceptors } from "@nestjs/common";
import { RequireModule } from "../common/decorators/require-module.decorator";
import {
  CurrentTenant,
  CurrentUser,
} from "../common/decorators/tenant.decorator";
import { TenantInterceptor } from "../common/interceptors/tenant.interceptor";
import { RateioRequester } from "../expense/rateio.types";
import { RestoreImportedExpensesService } from "./restore-imported-expenses.service";

@RequireModule("bankAccounts", "expenses")
@UseInterceptors(TenantInterceptor)
@Controller("projects/:ownerProjectId/bank-accounts/:accountId")
export class RestoreImportedExpensesController {
  constructor(private readonly service: RestoreImportedExpensesService) {}

  @Post("restore-imported-expenses")
  restore(
    @CurrentTenant() tenantId: string,
    @CurrentUser() requester: RateioRequester,
    @Param("ownerProjectId") projectId: string,
    @Param("accountId") accountId: string,
    @Body() body: unknown,
  ) {
    return this.service.restore(
      { tenantId, projectId, accountId },
      requester,
      body,
    );
  }
}
