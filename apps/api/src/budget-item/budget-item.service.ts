import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateBudgetItemDto } from './dto/update-budget-item.dto';
import {
  calculateBalance,
  calculatePercentConsumed,
  calculateBudgetStatus,
  calculateActual,
} from '@reformaflow/domain';
import type { BudgetItemComputed } from '@reformaflow/domain';

@Injectable()
export class BudgetItemService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Busca todos os BudgetItems do projeto com Realizado calculado dinamicamente.
   * Regra: Realizado = soma(MaterialPurchases por Room+WorkType) + soma(Milestones pagos)
   */
  async findAllByProject(tenantId: string, projectId: string): Promise<BudgetItemComputed[]> {
    // Valida que o projeto pertence ao tenant
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');

    const budgetItems = await this.prisma.budgetItem.findMany({
      where: { projectId },
      include: { room: true, workType: true },
      orderBy: [{ room: { order: 'asc' } }, { workType: { name: 'asc' } }],
    });

    // Buscar totais de compras agrupados por room+workType
    const purchaseTotals = await this.prisma.materialPurchase.groupBy({
      by: ['roomId', 'workTypeId'],
      where: { projectId, deletedAt: null },
      _sum: { totalAmount: true },
    });

    // Buscar totais de milestones pagos (alocados em Geral/Mão de obra)
    const paidMilestones = await this.prisma.contractorMilestone.findMany({
      where: {
        contractor: { projectId },
        paymentStatus: 'PAID',
        deletedAt: null,
      },
      include: { contractor: true },
    });
    const totalPaidMilestones = paidMilestones.reduce(
      (sum, m) => sum + m.contractor.contractedAmount * m.percentage,
      0,
    );

    // Mapear purchases por room+workType para lookup rápido
    const purchaseMap = new Map<string, number>();
    for (const p of purchaseTotals) {
      const key = `${p.roomId}:${p.workTypeId}`;
      purchaseMap.set(key, p._sum.totalAmount ?? 0);
    }

    // Encontrar o BudgetItem "Geral / Mão de obra" para alocar milestones
    const laborItem = budgetItems.find(
      (bi) => bi.room.name === 'Geral (casa toda)' && bi.workType.category === 'LABOR',
    );

    return budgetItems.map((bi) => {
      const purchaseTotal = purchaseMap.get(`${bi.roomId}:${bi.workTypeId}`) ?? 0;

      // Milestones pagos vão para o BudgetItem de Mão de obra
      const milestonesForItem = laborItem && bi.id === laborItem.id ? totalPaidMilestones : 0;

      const actual = calculateActual(purchaseTotal, milestonesForItem);
      const balance = calculateBalance(bi.planned, actual);
      const percentConsumed = calculatePercentConsumed(bi.planned, actual);
      const status = calculateBudgetStatus(bi.planned, actual);

      return {
        id: bi.id,
        roomName: bi.room.name,
        workTypeName: bi.workType.name,
        planned: bi.planned,
        actual,
        balance,
        percentConsumed,
        status,
      };
    });
  }

  /**
   * Resumo por ambiente (para o Dashboard)
   * Equivalente ao SUMIF da planilha Dashboard
   */
  async getDashboardSummary(tenantId: string, projectId: string) {
    const items = await this.findAllByProject(tenantId, projectId);

    // Agrupar por ambiente
    const byRoom = new Map<string, { planned: number; actual: number }>();
    for (const item of items) {
      const current = byRoom.get(item.roomName) ?? { planned: 0, actual: 0 };
      current.planned += item.planned;
      current.actual += item.actual;
      byRoom.set(item.roomName, current);
    }

    const roomSummary = Array.from(byRoom.entries()).map(([roomName, totals]) => ({
      roomName,
      planned: totals.planned,
      actual: totals.actual,
      balance: calculateBalance(totals.planned, totals.actual),
      percentConsumed: calculatePercentConsumed(totals.planned, totals.actual),
      status: calculateBudgetStatus(totals.planned, totals.actual),
    }));

    // Totais gerais
    const totalPlanned = items.reduce((s, i) => s + i.planned, 0);
    const totalActual = items.reduce((s, i) => s + i.actual, 0);

    return {
      totalPlanned,
      totalActual,
      totalBalance: calculateBalance(totalPlanned, totalActual),
      percentConsumed: calculatePercentConsumed(totalPlanned, totalActual),
      status: calculateBudgetStatus(totalPlanned, totalActual),
      byRoom: roomSummary,
    };
  }

  async updatePlanned(tenantId: string, projectId: string, id: string, dto: UpdateBudgetItemDto) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');

    return this.prisma.budgetItem.update({
      where: { id },
      data: { planned: dto.planned },
    });
  }
}
