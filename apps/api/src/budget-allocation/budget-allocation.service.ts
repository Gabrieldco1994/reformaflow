import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isNeutralExpenseType } from '@reformaflow/domain';
import {
  BUDGET_ALLOCATION_MODULE,
  resolveAccessibleProjectScope,
  userCanAccessProject,
} from '../common/access-rules';
import {
  redactCrossTenantRelation,
  redactCrossTenantRelations,
} from './budget-allocation-redaction';

export interface RequestUser {
  role: string;
  isGuest?: boolean;
  allowedProjects?: string[];
  allowedProjectTypes?: string[];
  allowedModules?: string[];
}

/**
 * `tenantId` entra no select só para a comparação de redação e sai antes da
 * resposta (`redactCrossTenantRelation`), então o payload de uma relação do
 * próprio tenant continua com exatamente as mesmas chaves de sempre.
 */
const PROJECT_RELATION_SELECT = {
  id: true,
  name: true,
  type: true,
  tenantId: true,
} as const;

const RECEIPT_RELATION_SELECT = {
  id: true,
  valor: true,
  tipo: true,
  data: true,
  tenantId: true,
} as const;

/** Balde único onde caem os alvos legados de outro tenant no resumo. */
const REDACTED_TARGET_KEY = '__redacted__';

export interface AllocationSummaryRow {
  projectId: string | null;
  projectName: string | null;
  projectType: string | null;
  total: number;
}

/**
 * #449 B2 — histórico administrativo somente leitura.
 *
 * Este service NÃO tem `create`, `update` nem `remove`: o congelamento é por
 * construção, não por guard. Em particular, o antigo `update` gravava
 * `dto.targetProjectId` sem validar o tenant do alvo (ao contrário do `create`)
 * — era a via viva de fabricação das relações cross-tenant que hoje só existem
 * como legado e são redigidas na leitura.
 */
@Injectable()
export class BudgetAllocationService {
  constructor(private prisma: PrismaService) {}

  /**
   * Escopo de projetos que o requisitante alcança.
   * - `null` → sem restrição (ADMIN/OWNER ou grant vazio);
   * - `[]`   → nada visível (inclusive quando não há requisitante: fail-closed,
   *   porque `findAll` aceita chamada sem projeto e o `ProjectAccessGuard` só
   *   morde quando há projeto em params/query/body).
   */
  private async resolveRequesterScope(
    tenantId: string,
    user?: RequestUser,
  ): Promise<string[] | null> {
    if (!user) return [];
    return resolveAccessibleProjectScope(
      this.prisma,
      tenantId,
      user.role,
      user.allowedProjects,
      user.allowedProjectTypes,
      user.allowedModules ?? [],
      BUDGET_ALLOCATION_MODULE,
    );
  }

  async findAll(
    tenantId: string,
    filters?: { sourceProjectId?: string; targetProjectId?: string; mes?: string },
    user?: RequestUser,
  ) {
    const scope = await this.resolveRequesterScope(tenantId, user);
    if (scope !== null && scope.length === 0) return [];

    const allocations = await this.prisma.budgetAllocation.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters?.sourceProjectId && { sourceProjectId: filters.sourceProjectId }),
        ...(filters?.targetProjectId && { targetProjectId: filters.targetProjectId }),
        ...(filters?.mes && { mes: filters.mes }),
        // `AND` (e não spread) porque os filtros acima usam as MESMAS chaves:
        // o escopo precisa somar à consulta, nunca substituí-la.
        ...(scope !== null && {
          AND: [{ sourceProjectId: { in: scope } }, { targetProjectId: { in: scope } }],
        }),
      },
      include: {
        sourceProject: { select: PROJECT_RELATION_SELECT },
        targetProject: { select: PROJECT_RELATION_SELECT },
        sourceReceipt: { select: RECEIPT_RELATION_SELECT },
      },
      orderBy: { dataAlocacao: 'desc' },
    });

    return allocations.map((allocation) => ({
      ...allocation,
      sourceProject: redactCrossTenantRelation(allocation.sourceProject, tenantId),
      targetProject: redactCrossTenantRelation(allocation.targetProject, tenantId),
      sourceReceipt: redactCrossTenantRelation(allocation.sourceReceipt, tenantId),
    }));
  }

  async findOne(id: string, tenantId: string, user?: RequestUser) {
    const allocation = await this.prisma.budgetAllocation.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        sourceProject: { select: PROJECT_RELATION_SELECT },
        targetProject: { select: PROJECT_RELATION_SELECT },
        sourceReceipt: { select: RECEIPT_RELATION_SELECT },
        cashFlowEntries: true,
      },
    });

    if (!allocation) {
      throw new NotFoundException('Budget allocation not found');
    }

    // ACL por projeto: a rota usa o id do recurso, então o ProjectAccessGuard
    // (que só checa projectId/source/target em params/query/body) não cobre.
    // Sem requisitante, fail-closed — pelo mesmo motivo de `findAll`: uma
    // leitura que ninguém provou alcançar não pode passar por falta de dado.
    if (!user) {
      throw new ForbiddenException('Sem permissão para acessar esta alocação');
    }
    const canSource = userCanAccessProject(user.role, user.allowedProjects, allocation.sourceProjectId);
    const canTarget = userCanAccessProject(user.role, user.allowedProjects, allocation.targetProjectId);
    if (!canSource || !canTarget) {
      throw new ForbiddenException('Sem permissão para acessar esta alocação');
    }

    return {
      ...allocation,
      sourceProject: redactCrossTenantRelation(allocation.sourceProject, tenantId),
      targetProject: redactCrossTenantRelation(allocation.targetProject, tenantId),
      sourceReceipt: redactCrossTenantRelation(allocation.sourceReceipt, tenantId),
      cashFlowEntries: redactCrossTenantRelations(allocation.cashFlowEntries, tenantId),
    };
  }

  async getSummary(projectId: string, tenantId: string) {
    // Get project to check if it's PESSOAL (source) or other (target)
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId, deletedAt: null },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    if (project.type === 'PESSOAL') {
      // Summary of allocations FROM this project
      const allocations = await this.prisma.budgetAllocation.findMany({
        where: { sourceProjectId: projectId, tenantId, deletedAt: null },
        include: {
          targetProject: { select: PROJECT_RELATION_SELECT },
        },
      });

      const totalAllocated = allocations.reduce((sum, a) => sum + a.valor, 0);
      // Redigir NÃO move dinheiro: o valor alocado é do tenant dono e continua
      // no total. O que some é a IDENTIDADE do alvo legado de outro tenant —
      // todos eles caem num único balde anônimo, de modo que a soma das linhas
      // continua batendo com `totalAllocated`.
      const byTargetProject = allocations.reduce((acc, a) => {
        const target = redactCrossTenantRelation(a.targetProject, tenantId);
        const key = target ? target.id : REDACTED_TARGET_KEY;
        if (!acc[key]) {
          acc[key] = {
            projectId: target?.id ?? null,
            projectName: target?.name ?? null,
            projectType: target?.type ?? null,
            total: 0,
          };
        }
        acc[key].total += a.valor;
        return acc;
      }, {} as Record<string, AllocationSummaryRow>);

      const available = await this.calculateAvailableBudget(projectId, tenantId);
      const totalExpenses = await this.sumOwnCommittedExpenses(projectId, tenantId);

      // Recebimentos EM_CAIXA (não-linkados) — permite distinguir "não há recebimentos"
      // de "recebimentos já comprometidos por despesas + alocações" na mensagem da UI.
      const receipts = await this.prisma.receipt.findMany({
        where: {
          projectId,
          tenantId,
          deletedAt: null,
          status: 'EM_CAIXA',
          linkedReceiptId: null,
        },
        select: { valor: true },
      });
      const totalReceipts = receipts.reduce((sum, r) => sum + r.valor, 0);

      return {
        totalAllocated,
        available,
        totalExpenses,
        totalReceipts,
        allocations: Object.values(byTargetProject),
      };
    } else {
      // Summary of allocations TO this project
      const allocations = await this.prisma.budgetAllocation.findMany({
        where: { targetProjectId: projectId, tenantId, deletedAt: null },
        include: {
          sourceProject: { select: PROJECT_RELATION_SELECT },
        },
      });

      const totalReceived = allocations.reduce((sum, a) => sum + a.valor, 0);

      // Get expenses to calculate spent
      const expenses = await this.prisma.cashFlowEntry.findMany({
        where: {
          projectId,
          tenantId,
          deletedAt: null,
          tipo: 'DESPESA',
          status: 'PAGO',
        },
      });

      const totalSpent = expenses.reduce((sum, e) => sum + e.valor, 0);

      return {
        totalReceived,
        totalSpent,
        remaining: totalReceived - totalSpent,
        allocations: allocations.map(a => ({
          id: a.id,
          valor: a.valor,
          mes: a.mes,
          descricao: a.descricao,
          sourceProject: redactCrossTenantRelation(a.sourceProject, tenantId),
        })),
      };
    }
  }

  async calculateAvailableBudget(sourceProjectId: string, tenantId: string): Promise<number> {
    // Total receipts EM_CAIXA in source project
    // IMPORTANT: exclude linked receipts to avoid double-counting
    const receipts = await this.prisma.receipt.findMany({
      where: {
        projectId: sourceProjectId,
        tenantId,
        deletedAt: null,
        status: 'EM_CAIXA',
        linkedReceiptId: null, // Only count non-linked receipts
      },
    });

    const totalReceipts = receipts.reduce((sum, r) => sum + r.valor, 0);

    // Total allocated FROM this project
    const allocations = await this.prisma.budgetAllocation.findMany({
      where: {
        sourceProjectId,
        tenantId,
        deletedAt: null,
      },
    });

    const totalAllocated = allocations.reduce((sum, a) => sum + a.valor, 0);

    // Despesas do PRÓPRIO projeto PESSOAL (pagas + planejadas) — dinheiro já gasto
    // ou comprometido, que não pode ser alocado para outros projetos.
    const totalExpenses = await this.sumOwnCommittedExpenses(sourceProjectId, tenantId);

    const available = totalReceipts - totalAllocated - totalExpenses;

    // Debug log
    console.log('[BudgetAllocation] calculateAvailableBudget:', {
      projectId: sourceProjectId,
      totalReceipts,
      totalReceiptsReais: totalReceipts / 100,
      totalAllocated,
      totalAllocatedReais: totalAllocated / 100,
      totalExpenses,
      totalExpensesReais: totalExpenses / 100,
      available,
      availableReais: available / 100,
    });

    // Ensure we never return negative values
    return Math.max(0, available);
  }

  /**
   * Soma as despesas do próprio projeto (pagas + planejadas) que comprometem o caixa:
   * - settledByExpenseId: null → não conta a planejada que já virou paga (clone), evitando dupla contagem
   * - linkedExpenseId: null → não conta despesa "espelho" de outro projeto
   * - tipos neutros (transferência entre contas / pagto de fatura) não representam consumo real
   */
  private async sumOwnCommittedExpenses(projectId: string, tenantId: string): Promise<number> {
    const expenses = await this.prisma.expense.findMany({
      where: {
        projectId,
        tenantId,
        deletedAt: null,
        settledByExpenseId: null,
        linkedExpenseId: null,
      },
      select: { valorTotal: true, tipoDespesa: true },
    });

    return expenses
      .filter((e) => !isNeutralExpenseType(e.tipoDespesa))
      .reduce((sum, e) => sum + e.valorTotal, 0);
  }
}
