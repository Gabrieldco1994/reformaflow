import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  calculateRollingBalance,
  calculateRollingBalanceRealizado,
} from '@reformaflow/domain';

@Injectable()
export class CashFlowService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lista fluxo de caixa (read-only, auto-gerado) com saldo acumulado.
   * Retorna duas séries:
   * - rollingBalance: saldo projetado (inclui PLANEJADO + PREVISTO)
   * - rollingBalanceRealizado: saldo realizado (apenas PAGO + EM_CAIXA)
   */
  async findAll(tenantId: string, projectId: string) {
    const project = await this.validateProject(tenantId, projectId);
    const expenseFilter =
      project.type === 'PESSOAL'
        ? { deletedAt: null }
        : { deletedAt: null, linkedExpenseId: null };

    const entries = await this.prisma.cashFlowEntry.findMany({
      where: {
        projectId,
        deletedAt: null,
        OR: [
          { expenseId: null },
          { expense: expenseFilter },
        ],
        // também garante que receipts soft-deleted não vazem
        AND: [
          {
            OR: [
              { receiptId: null },
              { receipt: { deletedAt: null, linkedReceiptId: null } },
            ],
          },
        ],
      },
      // Desempate determinístico: data → createdAt → id.
      // Sem isso, entries do mesmo dia podem trocar de ordem entre requests
      // e o rollingBalance intermediário "muda" entre F5.
      orderBy: [
        { data: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      include: { expense: { select: { titulo: true, fornecedor: true } } },
    });

    // Contrato (#96): rollingBalance/rollingBalanceRealizado são FLUXO ORÇAMENTÁRIO
    // acumulado DESDE ZERO — não é saldo bancário e NÃO ancora no §10 (computeCaixaConta).
    // No PESSOAL o saldo real é o §10, exibido no headline; estas séries são a projeção
    // de fluxo. Rótulos de UI dizem "fluxo", nunca "saldo". Reancorar no §10 seria a
    // Entrega 3 (deliberadamente não feita — divergência é intencional).
    const projected = calculateRollingBalance(entries);
    const realized = calculateRollingBalanceRealizado(entries);

    return entries.map((entry, i) => ({
      ...entry,
      titulo: entry.expense?.titulo ?? null,
      fornecedor: entry.expense?.fornecedor ?? null,
      rollingBalance: projected[i] ?? 0,
      rollingBalanceRealizado: realized[i] ?? 0,
    }));
  }

  private async validateProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    return project;
  }
}
