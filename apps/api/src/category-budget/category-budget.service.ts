import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isNeutralExpenseType } from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertCategoryBudgetDto } from './dto/category-budget.dto';

export interface CategoryBudgetProgress {
  tipoDespesa: string;
  limiteCents: number;
  gastoCents: number;
  pct: number;
}

@Injectable()
export class CategoryBudgetService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string, projectId: string, mes?: string) {
    await this.validatePersonalProject(tenantId, projectId);
    this.validateMes(mes, false);

    return this.prisma.categoryBudget.findMany({
      where: {
        tenantId,
        projectId,
        ...(mes ? { OR: [{ mes }, { mes: null }] } : {}),
      },
      orderBy: [{ mes: 'asc' }, { tipoDespesa: 'asc' }],
    });
  }

  async upsert(tenantId: string, projectId: string, dto: UpsertCategoryBudgetDto) {
    await this.validatePersonalProject(tenantId, projectId);
    const mes = dto.mes ?? null;
    this.validateMes(mes, false);

    if (isNeutralExpenseType(dto.tipoDespesa)) {
      throw new BadRequestException('Categorias neutras não aceitam meta');
    }

    const existing = await this.prisma.categoryBudget.findFirst({
      where: { tenantId, projectId, tipoDespesa: dto.tipoDespesa, mes },
    });

    if (existing) {
      return this.prisma.categoryBudget.update({
        where: { id: existing.id },
        data: { valorLimiteCents: dto.valorLimiteCents },
      });
    }

    return this.prisma.categoryBudget.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: dto.tipoDespesa,
        mes,
        valorLimiteCents: dto.valorLimiteCents,
      },
    });
  }

  async remove(tenantId: string, projectId: string, id: string) {
    await this.validatePersonalProject(tenantId, projectId);
    const budget = await this.prisma.categoryBudget.findFirst({
      where: { id, tenantId, projectId },
    });
    if (!budget) throw new NotFoundException('Meta não encontrada');
    await this.prisma.categoryBudget.delete({ where: { id } });
    return { deleted: true };
  }

  async progress(tenantId: string, projectId: string, mes: string): Promise<CategoryBudgetProgress[]> {
    await this.validatePersonalProject(tenantId, projectId);
    this.validateMes(mes, true);

    const budgets = await this.prisma.categoryBudget.findMany({
      where: { tenantId, projectId, OR: [{ mes }, { mes: null }] },
      orderBy: [{ mes: 'desc' }, { tipoDespesa: 'asc' }],
    });

    const resolvedBudgets = new Map<string, { tipoDespesa: string; valorLimiteCents: number }>();
    for (const budget of budgets) {
      if (resolvedBudgets.has(budget.tipoDespesa)) continue;
      if (isNeutralExpenseType(budget.tipoDespesa)) continue;
      resolvedBudgets.set(budget.tipoDespesa, {
        tipoDespesa: budget.tipoDespesa,
        valorLimiteCents: budget.valorLimiteCents,
      });
    }

    if (resolvedBudgets.size === 0) return [];

    const { start, end } = monthRangeUtc(mes);
    const expenses = await this.prisma.expense.findMany({
      where: {
        tenantId,
        projectId,
        deletedAt: null,
        settledByExpenseId: null,
        tipoDespesa: { in: Array.from(resolvedBudgets.keys()) },
        OR: [
          { dataPagamento: { gte: start, lt: end } },
          { dataPagamento: null, dataInicioParcela: { gte: start, lt: end } },
          { dataPagamento: null, dataInicioParcela: null, createdAt: { gte: start, lt: end } },
        ],
      },
      select: { tipoDespesa: true, valorTotal: true },
    });

    const spentByType = new Map<string, number>();
    for (const expense of expenses) {
      if (isNeutralExpenseType(expense.tipoDespesa)) continue;
      spentByType.set(
        expense.tipoDespesa,
        (spentByType.get(expense.tipoDespesa) ?? 0) + expense.valorTotal,
      );
    }

    return Array.from(resolvedBudgets.values()).map((budget) => {
      const gastoCents = spentByType.get(budget.tipoDespesa) ?? 0;
      return {
        tipoDespesa: budget.tipoDespesa,
        limiteCents: budget.valorLimiteCents,
        gastoCents,
        pct: budget.valorLimiteCents > 0 ? Math.round((gastoCents / budget.valorLimiteCents) * 100) : 0,
      };
    });
  }

  private async validatePersonalProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId, deletedAt: null },
      select: { type: true },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    if (project.type !== 'PESSOAL') {
      throw new BadRequestException('Metas por categoria estão disponíveis apenas no PESSOAL');
    }
  }

  private validateMes(mes: string | null | undefined, required: boolean) {
    if (required && !mes) throw new BadRequestException('Parâmetro mes é obrigatório');
    if (mes && !/^\d{4}-\d{2}$/.test(mes)) {
      throw new BadRequestException('Mês deve estar no formato YYYY-MM');
    }
  }
}

function monthRangeUtc(mes: string) {
  const [yearRaw, monthRaw] = mes.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new BadRequestException('Mês deve estar no formato YYYY-MM');
  }
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}
