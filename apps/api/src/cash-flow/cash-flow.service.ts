import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CashFlowType, computeCashFlowEntries } from '@reformaflow/domain';

@Injectable()
export class CashFlowService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lista fluxo de caixa (read-only, auto-gerado) com saldo acumulado
   */
  async findAll(tenantId: string, projectId: string) {
    await this.validateProject(tenantId, projectId);

    const entries = await this.prisma.cashFlowEntry.findMany({
      where: {
        projectId,
        deletedAt: null,
        OR: [
          { expenseId: null },
          { expense: { deletedAt: null } },
        ],
      },
      orderBy: { data: 'asc' },
      include: { expense: { select: { titulo: true, fornecedor: true } } },
    });

    // Compute rolling balance
    const balances: number[] = [];
    let running = 0;
    for (const entry of entries) {
      if (entry.tipo === 'RECEBIMENTO') {
        running += entry.valor;
      } else {
        running -= entry.valor;
      }
      balances.push(running);
    }

    return entries.map((entry, i) => ({
      ...entry,
      titulo: entry.expense?.titulo ?? null,
      fornecedor: entry.expense?.fornecedor ?? null,
      rollingBalance: balances[i],
    }));
  }

  private async validateProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
  }
}
