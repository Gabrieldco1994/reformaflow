import { Body, Controller, Param, Post, UseInterceptors } from '@nestjs/common';
import { RequireModule } from '../common/decorators/require-module.decorator';
import {
  CurrentTenant,
  CurrentUser,
} from '../common/decorators/tenant.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { RateioRequester } from '../expense/rateio.types';
import { DocumentedScheduleService } from './documented-schedule.service';

@RequireModule('creditCards', 'expenses')
@UseInterceptors(TenantInterceptor)
@Controller('projects/:ownerProjectId/credit-cards/:cardId')
export class DocumentedScheduleController {
  constructor(private readonly service: DocumentedScheduleService) {}

  @Post('imports/:importId/expenses/:expenseId/documented-schedule')
  correct(
    @CurrentTenant() tenantId: string,
    @CurrentUser() requester: RateioRequester,
    @Param('ownerProjectId') projectId: string,
    @Param('cardId') cardId: string,
    @Param('importId') importId: string,
    @Param('expenseId') expenseId: string,
    @Body() body: unknown,
  ) {
    return this.service.correct(
      { tenantId, projectId, cardId, importId, expenseId },
      requester,
      body,
    );
  }

  @Post('expenses/:expenseId/documented-schedule/assisted')
  correctAssisted(
    @CurrentTenant() tenantId: string,
    @CurrentUser() requester: RateioRequester,
    @Param('ownerProjectId') projectId: string,
    @Param('cardId') cardId: string,
    @Param('expenseId') expenseId: string,
    @Body() body: unknown,
  ): ReturnType<DocumentedScheduleService['correctAssisted']> {
    return this.service.correctAssisted(
      { tenantId, projectId, cardId, expenseId },
      requester,
      body,
    );
  }
}
