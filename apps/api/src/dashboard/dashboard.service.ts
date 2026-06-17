import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ExpenseTypeLabels,
  LaborCategoryLabels,
  allocateEmpreiteiroExpenses,
  buildMonthlyAccumulated,
  effectiveValorTotal,
} from '@reformaflow/domain';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(tenantId: string, projectId: string) {
    await this.validateProject(tenantId, projectId);

    // Check if project has budget allocations (replace logic)
    const budgetAllocations = await this.prisma.budgetAllocation.findMany({
      where: { targetProjectId: projectId, tenantId, deletedAt: null },
    });

    const hasBudgetAllocations = budgetAllocations.length > 0;

    const [receipts, cashFlowEntries, expenses] = await Promise.all([
      // Only fetch receipts if NO budget allocations (replace logic)
      hasBudgetAllocations
        ? Promise.resolve([])
        : this.prisma.receipt.findMany({
            where: { projectId, tenantId, deletedAt: null, linkedReceiptId: null },
          }),
      // IMPORTANTE: filtra entries cuja despesa OU receipt vinculado foi soft-deleted.
      // Sem esses filtros o dashboard contabilizava entries fantasma cujo recurso
      // original já tinha sido excluído, distorcendo o saldo acumulado.
      this.prisma.cashFlowEntry.findMany({
        where: {
          projectId,
          tenantId,
          deletedAt: null,
          OR: [
            { expenseId: null },
            { expense: { deletedAt: null, linkedExpenseId: null } },
          ],
          AND: [
            {
              OR: [
                { receiptId: null },
                { receipt: { deletedAt: null, linkedReceiptId: null } },
              ],
            },
          ],
        },
      }),
      this.prisma.expense.findMany({
        where: { projectId, tenantId, deletedAt: null, settledByExpenseId: null },
        include: { room: true },
      }),
    ]);

    // Calculate budget received (if using budget allocations)
    const budgetRecebido = hasBudgetAllocations
      ? budgetAllocations.reduce((sum, b) => sum + b.valor, 0)
      : 0;

    // KPIs
    const dinheiroDisponivel = hasBudgetAllocations
      ? budgetRecebido // Budget allocated is considered "available"
      : receipts
          .filter((r) => r.status === 'EM_CAIXA')
          .reduce((sum, r) => sum + r.valor, 0);

    const jaPaguei = cashFlowEntries
      .filter((e) => e.tipo === 'DESPESA' && e.status === 'PAGO')
      .reduce((sum, e) => sum + e.valor, 0);

    const previsaoGastos = cashFlowEntries
      .filter((e) => e.tipo === 'DESPESA' && e.status === 'PLANEJADO')
      .reduce((sum, e) => sum + e.valor, 0);

    const previsaoRecebimentos = hasBudgetAllocations
      ? 0 // No future receipts when using budget allocations
      : receipts
          .filter((r) => r.status === 'PREVISTO')
          .reduce((sum, r) => sum + r.valor, 0);

    const previsaoSaldo = dinheiroDisponivel + previsaoRecebimentos - jaPaguei - previsaoGastos;
    const saldo = dinheiroDisponivel - jaPaguei;

    // Conciliação cross-project: quando uma parcela do alvo (REFORMA) foi
    // liquidada pelo valor REAL (cartão/conta pessoal), os resumos por
    // valorTotal devem refletir o efetivo (planejado + Σ(real − planejado)).
    // Sem vínculos ativos, Σ delta = 0 (no-op) — zero impacto nos números atuais.
    const expenseIds = expenses.map((e) => e.id);
    const settlements = expenseIds.length
      ? await this.prisma.crossProjectSettlement.findMany({
          where: { targetExpenseId: { in: expenseIds } },
        })
      : [];
    const settlementsByTarget = new Map<string, { realValor: number; plannedValor: number }[]>();
    for (const s of settlements) {
      const arr = settlementsByTarget.get(s.targetExpenseId) ?? [];
      arr.push({ realValor: s.realValor, plannedValor: s.plannedValor });
      settlementsByTarget.set(s.targetExpenseId, arr);
    }
    const expensesEff = expenses.map((e) => ({
      ...e,
      valorTotal: effectiveValorTotal(e.valorTotal, settlementsByTarget.get(e.id) ?? []),
    }));

    // Resumo por Ambiente
    // Aplica rateio: despesas de MAO_DE_OBRA / EMPREITEIRO sem ambiente são
    // distribuídas proporcionalmente entre os ambientes com valor > 0.
    const expensesForRoomBreakdown = allocateEmpreiteiroExpenses(expensesEff);
    const byRoomMap = new Map<string, { planejado: number; pago: number }>();
    for (const exp of expensesForRoomBreakdown) {
      const roomName = exp.room?.name ?? 'Sem Ambiente';
      if (!byRoomMap.has(roomName)) byRoomMap.set(roomName, { planejado: 0, pago: 0 });
      const entry = byRoomMap.get(roomName)!;
      if (exp.status === 'PLANEJADO') entry.planejado += exp.valorTotal;
      else if (exp.status === 'PAGO') entry.pago += exp.valorTotal;
    }

    // Resumo por Tipo de Despesa
    const byTypeMap = new Map<string, number>();
    for (const exp of expensesEff) {
      const key = exp.tipoDespesa;
      byTypeMap.set(key, (byTypeMap.get(key) ?? 0) + exp.valorTotal);
    }
    const byExpenseType = Array.from(byTypeMap.entries()).map(([tipoDespesa, total]) => ({
      label: ExpenseTypeLabels[tipoDespesa as keyof typeof ExpenseTypeLabels] ?? tipoDespesa,
      total,
    }));

    // Resumo por Categoria (Mão de Obra)
    const byCatMap = new Map<string, number>();
    for (const exp of expensesEff) {
      if (exp.categoriaMaoDeObra) {
        const key = exp.categoriaMaoDeObra;
        byCatMap.set(key, (byCatMap.get(key) ?? 0) + exp.valorTotal);
      }
    }
    const byExpenseCategory = Array.from(byCatMap.entries()).map(([categoria, total]) => ({
      label: LaborCategoryLabels[categoria as keyof typeof LaborCategoryLabels] ?? categoria,
      total,
    }));

    // Despesas mensais (planejado vs pago) — baseado nas datas do fluxo de caixa
    const despesasMensalMap = new Map<string, { planejado: number; pago: number }>();
    for (const entry of cashFlowEntries) {
      if (entry.tipo !== 'DESPESA') continue;
      const mesKey = entry.data.toISOString().slice(0, 7);
      if (!despesasMensalMap.has(mesKey)) despesasMensalMap.set(mesKey, { planejado: 0, pago: 0 });
      const bucket = despesasMensalMap.get(mesKey)!;
      if (entry.status === 'PAGO') bucket.pago += entry.valor;
      else if (entry.status === 'PLANEJADO') bucket.planejado += entry.valor;
    }
    const despesasMensal = Array.from(despesasMensalMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mes, vals]) => ({ mes, planejado: vals.planejado, pago: vals.pago }));

    // Saldo acumulado mensal — usa helper do domain que:
    // (1) preenche meses vazios entre o primeiro e o último mês com entries
    //     (evita "saltos" na linha do gráfico),
    // (2) calcula duas séries: projetado (tudo) e realizado (só PAGO+EM_CAIXA),
    //     permitindo o frontend exibir as duas para diferenciar com clareza.
    const saldoAcumuladoMensal = buildMonthlyAccumulated(cashFlowEntries);

    return {
      kpis: {
        dinheiroDisponivel,
        jaPaguei,
        previsaoGastos,
        previsaoRecebimentos,
        previsaoSaldo,
        saldo,
      },
      resumoPorAmbiente: Array.from(byRoomMap.entries()).map(([roomName, data]) => ({
        roomName,
        planned: data.planejado,
        actual: data.pago,
      })),
      resumoPorTipoDespesa: byExpenseType,
      resumoPorCategoria: byExpenseCategory,
      despesasMensal,
      saldoAcumuladoMensal,
    };
  }

  private async validateProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
  }
}
