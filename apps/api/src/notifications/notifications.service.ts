import { Injectable, Logger } from '@nestjs/common';
import { BudgetItemService } from '../budget-item/budget-item.service';
import { BudgetStatus } from '@reformaflow/domain';

export interface BudgetAlert {
  roomName: string;
  workTypeName: string;
  status: BudgetStatus;
  percentConsumed: number;
  planned: number;
  actual: number;
}

/**
 * Serviço de notificações para alertas de estouro de orçamento.
 * 
 * Em produção: integrar com serviço de email (SendGrid/SES) e Web Push.
 * Por enquanto: loga alertas e expõe método para checagem sob demanda.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly budgetItemService: BudgetItemService) {}

  /**
   * Verifica todos os BudgetItems e retorna alertas para itens em WARNING ou OVER_BUDGET.
   * Pode ser chamado via cron job ou após cada operação de compra/milestone.
   */
  async checkBudgetAlerts(tenantId: string, projectId: string): Promise<BudgetAlert[]> {
    const items = await this.budgetItemService.findAllByProject(tenantId, projectId);

    const alerts: BudgetAlert[] = items
      .filter((item) => item.status === BudgetStatus.WARNING || item.status === BudgetStatus.OVER_BUDGET)
      .map((item) => ({
        roomName: item.roomName,
        workTypeName: item.workTypeName,
        status: item.status as BudgetStatus,
        percentConsumed: item.percentConsumed,
        planned: item.planned,
        actual: item.actual,
      }));

    if (alerts.length > 0) {
      this.logger.warn(
        `[Projeto ${projectId}] ${alerts.length} alerta(s) de orçamento:`,
      );
      for (const alert of alerts) {
        const emoji = alert.status === BudgetStatus.OVER_BUDGET ? '🚨' : '⚠️';
        this.logger.warn(
          `  ${emoji} ${alert.roomName} / ${alert.workTypeName}: ${(alert.percentConsumed * 100).toFixed(1)}% consumido`,
        );
      }
    }

    return alerts;
  }

  /**
   * Dispara notificações (placeholder para integração futura com email/push)
   */
  async sendAlertNotifications(tenantId: string, projectId: string): Promise<{ sent: number }> {
    const alerts = await this.checkBudgetAlerts(tenantId, projectId);

    if (alerts.length === 0) {
      return { sent: 0 };
    }

    // TODO: Integrar com SendGrid/SES para email
    // TODO: Integrar com Web Push API para notificações push
    // TODO: Salvar notificações no banco para histórico

    this.logger.log(
      `[Projeto ${projectId}] Enviaria ${alerts.length} notificação(ões) de alerta`,
    );

    return { sent: alerts.length };
  }
}
