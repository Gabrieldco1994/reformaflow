import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  DailySummaryScopes,
  NotificationsService,
} from './notifications.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import {
  CurrentTenant,
  CurrentUser,
} from '../common/decorators/tenant.decorator';
import {
  EXPENSE_MODULE,
  MAINTENANCE_MODULE,
  RECEIPT_MODULE,
  RECURRING_BILL_MODULE,
  REMINDER_MODULE,
  SCHEDULE_MODULE,
  resolveAccessibleProjectScope,
} from '../common/access-rules';
import { PrismaService } from '../prisma/prisma.service';

interface RequestUser {
  role: string;
  allowedProjects?: string[];
  allowedProjectTypes?: string[];
  allowedModules?: string[];
}

@ApiTags('notifications')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly service: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * O resumo agrega SEIS famílias de recurso, cada uma de um módulo diferente.
   * Um `@RequireModule` de rota não serve: o `ModulesGuard` exige TODOS os
   * slugs declarados (semântica E) e o sino é global — quem tem só `reminders`
   * continuaria precisando ver o próprio lembrete. Então o gate é POR RECURSO:
   * cada família é escopada pelo seu módulo DONO e um módulo nunca entrega as
   * linhas do outro (#484 C). Sem o módulo, `resolveAccessibleProjectScope`
   * devolve `[]` ANTES de qualquer leitura.
   *
   * O objeto é montado campo a campo de propósito: assim o compilador cobra um
   * escopo para cada recurso novo do resumo (campo esquecido = recurso sem
   * gate, que é exatamente o defeito desta issue).
   */
  private async resolveSummaryScopes(
    tenantId: string,
    user: RequestUser,
  ): Promise<DailySummaryScopes> {
    const scopeFor = (requiredModule: string) =>
      resolveAccessibleProjectScope(
        this.prisma,
        tenantId,
        user.role,
        user.allowedProjects,
        user.allowedProjectTypes,
        user.allowedModules ?? [],
        requiredModule,
      );

    const [expenses, receipts, schedule, recurringBills, reminders, maintenance] =
      await Promise.all([
        scopeFor(EXPENSE_MODULE),
        scopeFor(RECEIPT_MODULE),
        scopeFor(SCHEDULE_MODULE),
        scopeFor(RECURRING_BILL_MODULE),
        scopeFor(REMINDER_MODULE),
        scopeFor(MAINTENANCE_MODULE),
      ]);

    return { expenses, receipts, schedule, recurringBills, reminders, maintenance };
  }

  @Get('daily-summary')
  @ApiOperation({
    summary: 'Resumo do dia: gastos, recebimentos, tarefas e vencimentos',
  })
  async getDailySummary(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: RequestUser,
  ) {
    const scopes = await this.resolveSummaryScopes(tenantId, user);
    return this.service.getDailySummary(tenantId, scopes);
  }
}
