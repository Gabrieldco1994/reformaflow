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
    //
    // ATENÇÃO (vínculo cross-project / espelhos): NÃO excluímos mais espelhos
    // (expense.linkedExpenseId != null) no nível da query. O PESSOAL é o controlador
    // universal do caixa: o espelho representa dinheiro que saiu da conta pessoal e
    // PRECISA aparecer nos KPIs PESSOAL-only ("Em caixa"/"Projetado"). A deduplicação
    // (para o consolidado e para as linhas mês-a-mês) é feita adiante via flag
    // `isEspelho`, mantendo o alvo do projeto como canônico no consolidado.
    const entries = await this.prisma.cashFlowEntry.findMany({
      where: {
        tenantId,
        projectId: { in: projectIds },
        deletedAt: null,
        budgetAllocationId: null,
        OR: [{ expenseId: null }, { expense: { deletedAt: null } }],
        AND: [
          {
            OR: [{ receiptId: null }, { receipt: { deletedAt: null, linkedReceiptId: null } }],
          },
        ],
      },
      include: { expense: { select: { linkedExpenseId: true, cardLast4: true } } },
      orderBy: [{ data: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });

    // Espelho = despesa PESSOAL vinculada a uma despesa de outro projeto.
    const isEspelho = (e: (typeof entries)[number]) => !!e.expense?.linkedExpenseId;

    // Adapta para o helper do domain (acrescenta projectOrigin e label de categoria).
    // Linhas mês-a-mês são consolidadas → excluem espelhos (o alvo do projeto é o canônico),
    // mantendo os totais idênticos ao comportamento anterior.
    const adapted: MonthlyOverviewEntry[] = entries
      .filter((e) => !isEspelho(e))
      .map((e) => ({
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
    // `isEspelho` permite que o cockpit conte o espelho no PESSOAL-only e o deduplique
    // no consolidado (ver derive.ts).
    const enrich = (e: (typeof entries)[number]) => ({
      id: e.id,
      data: e.data,
      tipo: e.tipo,
      status: e.status,
      valor: e.valor,
      categoria: e.categoria
        ? ExpenseTypeLabels[e.categoria as keyof typeof ExpenseTypeLabels] ?? e.categoria
        : null,
      categoriaCodigo: e.categoria ?? null,
      subcategoria: e.subcategoria,
      formaPagamento: e.formaPagamento,
      projectId: e.projectId,
      projectName: projectNameById.get(e.projectId) ?? '',
      projectType: projectTypeById.get(e.projectId) ?? 'OUTROS',
      cardLast4: e.expense?.cardLast4 ?? null,
      isEspelho: isEspelho(e),
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

    const caixa = await this.computeCaixaConta(tenantId, pessoalProjectId);

    // Cartões do tenant (closingDay/dueDay) para derivar o "mês de caixa" das
    // faturas no cockpit (eixo caixa). Aditivo: não altera meses/caixa existentes.
    const cardRows = await this.prisma.creditCard.findMany({
      where: { tenantId, projectId: { in: projectIds }, deletedAt: null },
      select: { last4: true, nickname: true, closingDay: true, dueDay: true },
    });
    const seenLast4 = new Set<string>();
    const cards = cardRows.filter((c) => {
      if (seenLast4.has(c.last4)) return false;
      seenLast4.add(c.last4);
      return true;
    });

    return {
      mesAtual: currentKey,
      meses: rows,
      comparativo: comparison,
      mesAtualEntries: currentMonthEntries,
      entries: allEntries,
      projetos: contributingProjects,
      caixa,
      cards,
    };
  }

  /**
   * Caixa real da conta corrente — reconciliação §10 do consolidado financeiro:
   *
   *   saldo hoje = saldo inicial (das contas) + Σ lançamentos REALIZADOS da conta
   *
   * "Lançamento da conta" = qualquer Expense/Receipt com `bankLast4` preenchido
   * (extrato, aplicações/resgates e pagamentos de fatura debitados na conta).
   * Itens de cartão (cardLast4, sem bankLast4) NÃO entram — eles estão na fatura,
   * não na conta. Lançamentos futuros (PLANEJADO, ex.: seguros agendados) ficam de
   * fora porque ainda não foram debitados — exatamente o que a §10 manda descontar.
   *
   * Diferente de "caixaAgora" do cockpit (fluxo realizado conta+cartão): este bate
   * com o saldo do app do banco quando o saldo inicial está cadastrado.
   */
  private async computeCaixaConta(tenantId: string, projectId: string) {
    const [accounts, expenses, receipts] = await Promise.all([
      this.prisma.bankAccount.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: { openingBalanceCents: true, openingBalanceDate: true },
      }),
      this.prisma.expense.findMany({
        where: { tenantId, projectId, deletedAt: null, bankLast4: { not: null } },
        select: { valorTotal: true, status: true, dataPagamento: true, createdAt: true },
      }),
      this.prisma.receipt.findMany({
        where: { tenantId, projectId, deletedAt: null, bankLast4: { not: null } },
        select: { valor: true, status: true, data: true },
      }),
    ]);
    return computeCaixaConta(accounts, expenses, receipts);
  }
}

/** YYYY-MM em UTC (datas do banco são gravadas em UTC, sem deslocar timezone). */
function monthKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface CaixaContaAccount {
  openingBalanceCents: number;
  openingBalanceDate: Date | null;
}
export interface CaixaContaExpense {
  valorTotal: number;
  status: string;
  dataPagamento: Date | null;
  createdAt: Date;
}
export interface CaixaContaReceipt {
  valor: number;
  status: string;
  data: Date;
}

/**
 * Reconciliação §10 (função pura, testável): saldo da conta hoje =
 * saldo inicial + Σ lançamentos REALIZADOS da conta. Espera apenas lançamentos
 * com `bankLast4` (filtrados pelo chamador). Cartão (sem bankLast4) e futuros
 * (status ≠ PAGO/EM_CAIXA) ficam de fora.
 */
export function computeCaixaConta(
  accounts: CaixaContaAccount[],
  expenses: CaixaContaExpense[],
  receipts: CaixaContaReceipt[],
) {
  const saldoInicial = accounts.reduce((s, a) => s + a.openingBalanceCents, 0);
  const temSaldoInicial = accounts.some(
    (a) => a.openingBalanceCents !== 0 || a.openingBalanceDate != null,
  );

  // Lançamentos realizados com sinal (despesa −, recebimento +) e mês de referência.
  const movs: Array<{ mes: string; valor: number }> = [];
  for (const e of expenses) {
    if (e.status !== 'PAGO') continue; // só realizados afetam o caixa
    const d = e.dataPagamento ?? e.createdAt;
    movs.push({ mes: monthKeyOf(d), valor: -e.valorTotal });
  }
  for (const r of receipts) {
    if (r.status !== 'EM_CAIXA') continue;
    movs.push({ mes: monthKeyOf(r.data), valor: r.valor });
  }

  const netRealizado = movs.reduce((s, m) => s + m.valor, 0);

  // Série mensal acumulada (saldo ao fim de cada mês) para o sparkline.
  const porMesMap = new Map<string, number>();
  for (const m of movs) porMesMap.set(m.mes, (porMesMap.get(m.mes) ?? 0) + m.valor);
  const porMes: Array<{ mes: string; caixa: number }> = [];
  let acc = saldoInicial;
  for (const mes of Array.from(porMesMap.keys()).sort()) {
    acc += porMesMap.get(mes) ?? 0;
    porMes.push({ mes, caixa: acc });
  }

  return { hoje: saldoInicial + netRealizado, saldoInicial, temSaldoInicial, porMes };
}
