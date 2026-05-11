import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ExpenseTypeLabels, LaborCategoryLabels } from '@reformaflow/domain';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(tenantId: string, projectId: string) {
    await this.validateProject(tenantId, projectId);

    const [receipts, cashFlowEntries, expenses] = await Promise.all([
      this.prisma.receipt.findMany({
        where: { projectId, tenantId, deletedAt: null },
      }),
      this.prisma.cashFlowEntry.findMany({
        where: { projectId, tenantId, deletedAt: null },
      }),
      this.prisma.expense.findMany({
        where: { projectId, tenantId, deletedAt: null, settledByExpenseId: null },
        include: { room: true },
      }),
    ]);

    // KPIs
    const dinheiroDisponivel = receipts
      .filter((r) => r.status === 'EM_CAIXA')
      .reduce((sum, r) => sum + r.valor, 0);

    const jaPaguei = cashFlowEntries
      .filter((e) => e.tipo === 'DESPESA' && e.status === 'PAGO')
      .reduce((sum, e) => sum + e.valor, 0);

    const previsaoGastos = cashFlowEntries
      .filter((e) => e.tipo === 'DESPESA' && e.status === 'PLANEJADO')
      .reduce((sum, e) => sum + e.valor, 0);

    const previsaoRecebimentos = receipts
      .filter((r) => r.status === 'PREVISTO')
      .reduce((sum, r) => sum + r.valor, 0);

    const previsaoSaldo = dinheiroDisponivel + previsaoRecebimentos - jaPaguei - previsaoGastos;
    const saldo = dinheiroDisponivel - jaPaguei;

    // Resumo por Ambiente
    const byRoomMap = new Map<string, { planejado: number; pago: number }>();
    for (const exp of expenses) {
      const roomName = exp.room?.name ?? 'Sem Ambiente';
      if (!byRoomMap.has(roomName)) byRoomMap.set(roomName, { planejado: 0, pago: 0 });
      const entry = byRoomMap.get(roomName)!;
      if (exp.status === 'PLANEJADO') entry.planejado += exp.valorTotal;
      else if (exp.status === 'PAGO') entry.pago += exp.valorTotal;
    }

    // Resumo por Tipo de Despesa
    const byTypeMap = new Map<string, number>();
    for (const exp of expenses) {
      const key = exp.tipoDespesa;
      byTypeMap.set(key, (byTypeMap.get(key) ?? 0) + exp.valorTotal);
    }
    const byExpenseType = Array.from(byTypeMap.entries()).map(([tipoDespesa, total]) => ({
      label: ExpenseTypeLabels[tipoDespesa as keyof typeof ExpenseTypeLabels] ?? tipoDespesa,
      total,
    }));

    // Resumo por Categoria (Mão de Obra)
    const byCatMap = new Map<string, number>();
    for (const exp of expenses) {
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

    // Saldo acumulado mensal do fluxo de caixa
    const fluxoMensalMap = new Map<string, { recebimentos: number; despesas: number }>();
    for (const entry of cashFlowEntries) {
      const mesKey = entry.data.toISOString().slice(0, 7);
      if (!fluxoMensalMap.has(mesKey)) fluxoMensalMap.set(mesKey, { recebimentos: 0, despesas: 0 });
      const bucket = fluxoMensalMap.get(mesKey)!;
      if (entry.tipo === 'RECEBIMENTO') bucket.recebimentos += entry.valor;
      else bucket.despesas += entry.valor;
    }
    // Add receipts that may not have cash flow entries (EM_CAIXA receipts generate cash flow, PREVISTO may not)
    // Cash flow already contains receipt entries, so we just use cashFlowEntries
    const sortedMonths = Array.from(fluxoMensalMap.keys()).sort();
    let acumulado = 0;
    const saldoAcumuladoMensal = sortedMonths.map((mes) => {
      const bucket = fluxoMensalMap.get(mes)!;
      acumulado += bucket.recebimentos - bucket.despesas;
      return { mes, recebimentos: bucket.recebimentos, despesas: bucket.despesas, saldoAcumulado: acumulado };
    });

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
