import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildMonthlyOverview,
  compareMonths,
  ExpenseTypeLabels,
  type MonthlyOverviewEntry,
} from '@reformaflow/domain';

@Injectable()
export class MonthlyOverviewService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(tenantId: string, pessoalProjectId: string) {
    const pessoal = await this.prisma.project.findFirst({
      where: { id: pessoalProjectId, tenantId, deletedAt: null },
    });
    if (!pessoal) throw new NotFoundException('Projeto não encontrado');
    if (pessoal.type !== 'PESSOAL') {
      throw new BadRequestException(
        'Visão consolidada disponível apenas para projetos do tipo PESSOAL',
      );
    }

    // Todos os projetos não-deletados do tenant (PESSOAL + REFORMA + CASA + CARRO + ...)
    const projects = await this.prisma.project.findMany({
      where: { tenantId, deletedAt: null },
    });
    const projectIds = projects.map((p) => p.id);
    const projectTypeById = new Map(projects.map((p) => [p.id, p.type] as const));
    const projectNameById = new Map(projects.map((p) => [p.id, p.name] as const));

    // Cash flow entries de todos os projetos (soft-deleted excluídos, e entries de
    // despesas/receipts soft-deleted também excluídos para consistência).
    // Entries de alocação de orçamento (budgetAllocationId) são transferências
    // internas entre projetos do mesmo tenant: o recebimento original já é contado
    // na origem, então o espelho na reforma contaria em dobro no consolidado.
    const entries = await this.prisma.cashFlowEntry.findMany({
      where: {
        tenantId,
        projectId: { in: projectIds },
        deletedAt: null,
        budgetAllocationId: null,
        OR: [{ expenseId: null }, { expense: { deletedAt: null, linkedExpenseId: null } }],
        AND: [
          {
            OR: [{ receiptId: null }, { receipt: { deletedAt: null, linkedReceiptId: null } }],
          },
        ],
      },
      orderBy: [{ data: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });

    // Adapta para o helper do domain (acrescenta projectOrigin e label de categoria)
    const adapted: MonthlyOverviewEntry[] = entries.map((e) => ({
      tipo: e.tipo,
      valor: e.valor,
      status: e.status,
      data: e.data,
      categoria:
        e.categoria
          ? ExpenseTypeLabels[e.categoria as keyof typeof ExpenseTypeLabels] ?? e.categoria
          : null,
      projectOrigin: projectTypeById.get(e.projectId) ?? 'OUTROS',
    }));

    const rows = buildMonthlyOverview(adapted, { topCategorias: 6 });

    const today = new Date();
    const currentKey = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
    const comparison = compareMonths(rows, currentKey);

    // Entries enriquecidas com origem (project name + type) para a tabela / cockpit.
    const enrich = (e: (typeof entries)[number]) => ({
      id: e.id,
      data: e.data,
      tipo: e.tipo,
      status: e.status,
      valor: e.valor,
      categoria: e.categoria
        ? ExpenseTypeLabels[e.categoria as keyof typeof ExpenseTypeLabels] ?? e.categoria
        : null,
      subcategoria: e.subcategoria,
      formaPagamento: e.formaPagamento,
      projectId: e.projectId,
      projectName: projectNameById.get(e.projectId) ?? '',
      projectType: projectTypeById.get(e.projectId) ?? 'OUTROS',
    });

    // Todas as entries (todos os meses) para permitir navegação de mês no cockpit.
    const allEntries = entries.map(enrich);

    // Entries do mês corrente (mantido para compatibilidade).
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    const currentMonthEntries = allEntries.filter(
      (e) => e.data >= monthStart && e.data < monthEnd,
    );

    // Lista de projetos contribuintes (para legenda do gráfico)
    const contributingProjects = projects
      .filter((p) => p.id !== pessoalProjectId)
      .map((p) => ({ id: p.id, name: p.name, type: p.type }));

    return {
      mesAtual: currentKey,
      meses: rows,
      comparativo: comparison,
      mesAtualEntries: currentMonthEntries,
      entries: allEntries,
      projetos: contributingProjects,
    };
  }
}
