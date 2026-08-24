import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  isNeutralExpenseType,
  buildInstallments,
  buildRecurringOccurrences,
  isSinglePaymentForm,
  localDateUtc,
  type InstallmentInput,
} from '@reformaflow/domain';
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

    // Buscar todas as despesas da categoria (sem filtro de data)
    // para poder expandir parcelas e recorrências corretamente
    const expenses = await this.prisma.expense.findMany({
      where: {
        tenantId,
        projectId,
        deletedAt: null,
        settledByExpenseId: null,
        tipoDespesa: { in: Array.from(resolvedBudgets.keys()) },
      },
      select: {
        id: true,
        tipoDespesa: true,
        valorTotal: true,
        formaPagamento: true,
        dataPagamento: true,
        quantidadeParcela: true,
        dataInicioParcela: true,
        installmentDateOverrides: true,
        paidParcelas: true,
        status: true,
        recorrente: true,
        recorrenciaFim: true,
        createdAt: true,
      },
    });

    // Calcular o mês em BRT (não UTC)
    const { startBrt, endBrt } = monthRangeBrt(mes);

    // Expandir despesas em parcelas e ocorrências, depois contar gasto no mês
    const spentByType = new Map<string, number>();

    for (const expense of expenses) {
      if (isNeutralExpenseType(expense.tipoDespesa)) continue;

      // Recorrência: expande em múltiplas ocorrências (uma por mês)
      if (expense.recorrente && isSinglePaymentForm(expense.formaPagamento)) {
        const startDate = expense.dataPagamento || expense.dataInicioParcela || expense.createdAt;
        if (!startDate) continue;

        const recurringOccurrences = buildRecurringOccurrences({
          valorTotal: expense.valorTotal,
          dataInicio: startDate,
          recorrenciaFim: expense.recorrenciaFim,
          horizonEnd: endBrt,
        });

        for (const occ of recurringOccurrences) {
          // Verificar se a ocorrência cai no mês solicitado (em BRT)
          const occDateBrt = localDateUtc(occ.data, 'America/Sao_Paulo');
          if (occDateBrt >= startBrt && occDateBrt < endBrt) {
            spentByType.set(
              expense.tipoDespesa,
              (spentByType.get(expense.tipoDespesa) ?? 0) + occ.valor,
            );
          }
        }
        continue;
      }

      // Parcelamento: expande em múltiplas parcelas
      const installments = buildInstallments({
        valorTotal: expense.valorTotal,
        formaPagamento: expense.formaPagamento,
        dataPagamento: expense.dataPagamento,
        quantidadeParcela: expense.quantidadeParcela,
        dataInicioParcela: expense.dataInicioParcela,
        installmentDateOverrides: expense.installmentDateOverrides,
      } as InstallmentInput);

      const paidSet = this.parsePaidParcelas(expense.paidParcelas, installments.length);
      const fullyPaid = expense.status === 'PAGO';

      for (let i = 0; i < installments.length; i++) {
        const inst = installments[i];
        const instDateBrt = localDateUtc(inst.data, 'America/Sao_Paulo');

        // Verificar se a parcela cai no mês solicitado (em BRT)
        if (instDateBrt >= startBrt && instDateBrt < endBrt) {
          spentByType.set(
            expense.tipoDespesa,
            (spentByType.get(expense.tipoDespesa) ?? 0) + inst.valor,
          );
        }
      }
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

  private parsePaidParcelas(raw: string | null | undefined, n: number): Set<number> {
    if (!raw) return new Set();
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Set();
      const s = new Set<number>();
      for (const v of arr) {
        const i = Number(v);
        if (Number.isInteger(i) && i >= 0 && i < n) s.add(i);
      }
      return s;
    } catch {
      return new Set();
    }
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

/**
 * Calcula o intervalo de um mês em BRT (America/Sao_Paulo).
 * Retorna datas em UTC que representam meia-noite BRT dos limites.
 *
 * Exemplo: '2026-08' retorna:
 * - startBrt: 2026-08-01T00:00:00Z (meia-noite BRT do dia 1 = 03:00 UTC)
 * - endBrt: 2026-09-01T00:00:00Z (meia-noite BRT do dia 1 de setembro)
 */
function monthRangeBrt(mes: string) {
  const [yearRaw, monthRaw] = mes.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new BadRequestException('Mês deve estar no formato YYYY-MM');
  }

  // Criar datas "de calendário" em BRT (meia-noite BRT = Date.UTC)
  // Ex.: 2026-08-01 em BRT é representado como 2026-08-01T00:00:00Z
  const startBrt = new Date(Date.UTC(year, month - 1, 1));
  const endBrt = new Date(Date.UTC(year, month, 1));

  return { startBrt, endBrt };
}
