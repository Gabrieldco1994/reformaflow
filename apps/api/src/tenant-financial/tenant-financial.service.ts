import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MonthlyOverviewService } from '../monthly-overview/monthly-overview.service';
import { ExpenseTypeLabels } from '@reformaflow/domain';

type ProjectType = 'REFORMA' | 'COMPRA' | 'CASA' | 'CARRO' | 'PESSOAL';

export interface TenantFinancialOverview {
  caixaTotal: number | null;
  pagoMesAtual: number;
  pagoYTD: number;
  pagoTotal: number;
  previsao30d: number;
  previsao90d: number;
  recebimento30d: number;
  recebimento90d: number;
  saldoProjetado30d: number | null;
  saldoProjetado90d: number | null;
  totalProjetos: number;
}

export interface ProjectBreakdownRow {
  projectId: string;
  name: string;
  type: ProjectType;
  gastoTotal: number;
  planejadoRestante: number;
  recebimentoTotal: number;
  recebimentoPrevisto: number;
  saldo: number;
  progresso: number;
}

export interface ConsolidatedCashFlowPoint {
  mes: string;
  planejado: number;
  pago: number;
  recebido: number;
  previsto: number;
  saldoAcumulado: number;
  byProject: Record<string, { pago: number; planejado: number }>;
}

export interface CategoryRow {
  key: string;
  label: string;
  total: number;
}

export interface UpcomingDueRow {
  data: string;
  projectId: string;
  projectName: string;
  projectType: ProjectType;
  descricao: string;
  valor: number;
  tipo: 'DESPESA' | 'RECEBIMENTO';
  status: string;
}

export interface SupplierRow {
  fornecedor: string;
  total: number;
  count: number;
  projetos: { projectId: string; projectName: string }[];
}

@Injectable()
export class TenantFinancialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly monthly: MonthlyOverviewService,
  ) {}

  /** where parcial para restringir por projeto em agregações (null = sem filtro). */
  private scopeWhere(scope: string[] | null) {
    return scope ? { projectId: { in: scope } } : {};
  }

  private async listProjects(tenantId: string, scope: string[] | null) {
    return this.prisma.project.findMany({
      where: { tenantId, deletedAt: null, ...(scope ? { id: { in: scope } } : {}) },
      select: { id: true, name: true, type: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  private monthKey(d: Date) {
    return d.toISOString().slice(0, 7);
  }

  private startOfMonth(d: Date) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  private startOfYear(d: Date) {
    return new Date(d.getFullYear(), 0, 1);
  }

  async getOverview(tenantId: string, scope: string[] | null): Promise<TenantFinancialOverview> {
    const now = new Date();
    const startMes = this.startOfMonth(now);
    const startAno = this.startOfYear(now);
    const in30 = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
    const in90 = new Date(now.getTime() + 90 * 24 * 3600 * 1000);

    const [projects, cashFlow] = await Promise.all([
      this.listProjects(tenantId, scope),
      this.prisma.cashFlowEntry.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...this.scopeWhere(scope),
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
        select: { valor: true, tipo: true, status: true, data: true },
      }),
    ]);

    // Motor único (§10): o caixa/saldo em conta vem do projeto PESSOAL no escopo
    // (delegador `getCaixaConta`), NÃO de Σ receipts EM_CAIXA. Sem PESSOAL no
    // escopo ⇒ o KPI de caixa some (null) — o tenant não tem conta consolidada.
    const pessoal = projects.find((p) => p.type === 'PESSOAL');
    const caixaTotal = pessoal
      ? (await this.monthly.getCaixaConta(tenantId, pessoal.id)).hoje
      : null;

    let pagoMesAtual = 0;
    let pagoYTD = 0;
    let pagoTotal = 0;
    let previsao30d = 0;
    let previsao90d = 0;
    let recebimento30d = 0;
    let recebimento90d = 0;

    for (const e of cashFlow) {
      if (e.tipo === 'DESPESA') {
        if (e.status === 'PAGO') {
          pagoTotal += e.valor;
          if (e.data >= startAno) pagoYTD += e.valor;
          if (e.data >= startMes) pagoMesAtual += e.valor;
        } else if (e.status === 'PLANEJADO') {
          if (e.data <= in30 && e.data >= now) previsao30d += e.valor;
          if (e.data <= in90 && e.data >= now) previsao90d += e.valor;
        }
      } else if (e.tipo === 'RECEBIMENTO') {
        if (e.status === 'PREVISTO') {
          if (e.data <= in30 && e.data >= now) recebimento30d += e.valor;
          if (e.data <= in90 && e.data >= now) recebimento90d += e.valor;
        }
      }
    }

    return {
      caixaTotal,
      pagoMesAtual,
      pagoYTD,
      pagoTotal,
      previsao30d,
      previsao90d,
      recebimento30d,
      recebimento90d,
      saldoProjetado30d: caixaTotal === null ? null : caixaTotal + recebimento30d - previsao30d,
      saldoProjetado90d: caixaTotal === null ? null : caixaTotal + recebimento90d - previsao90d,
      totalProjetos: projects.length,
    };
  }

  async getByProject(tenantId: string, scope: string[] | null): Promise<ProjectBreakdownRow[]> {
    const projects = await this.listProjects(tenantId, scope);
    if (projects.length === 0) return [];

    const projectIds = projects.map((p) => p.id);
    const [cashFlow, receipts] = await Promise.all([
      this.prisma.cashFlowEntry.findMany({
        where: {
          tenantId,
          projectId: { in: projectIds },
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
        select: { projectId: true, tipo: true, status: true, valor: true },
      }),
      this.prisma.receipt.findMany({
        where: {
          tenantId,
          projectId: { in: projectIds },
          deletedAt: null,
          linkedReceiptId: null,
        },
        select: { projectId: true, status: true, valor: true },
      }),
    ]);

    const byProject = new Map<string, ProjectBreakdownRow>();
    for (const p of projects) {
      byProject.set(p.id, {
        projectId: p.id,
        name: p.name,
        type: p.type as ProjectType,
        gastoTotal: 0,
        planejadoRestante: 0,
        recebimentoTotal: 0,
        recebimentoPrevisto: 0,
        saldo: 0,
        progresso: 0,
      });
    }

    for (const e of cashFlow) {
      const row = byProject.get(e.projectId);
      if (!row) continue;
      if (e.tipo === 'DESPESA') {
        if (e.status === 'PAGO') row.gastoTotal += e.valor;
        else if (e.status === 'PLANEJADO') row.planejadoRestante += e.valor;
      }
    }
    for (const r of receipts) {
      const row = byProject.get(r.projectId);
      if (!row) continue;
      if (r.status === 'EM_CAIXA') row.recebimentoTotal += r.valor;
      else if (r.status === 'PREVISTO') row.recebimentoPrevisto += r.valor;
    }
    for (const row of byProject.values()) {
      row.saldo = row.recebimentoTotal - row.gastoTotal;
      const tot = row.gastoTotal + row.planejadoRestante;
      row.progresso = tot > 0 ? row.gastoTotal / tot : 0;
    }
    return Array.from(byProject.values());
  }

  async getCashFlow(tenantId: string, months: number, scope: string[] | null): Promise<ConsolidatedCashFlowPoint[]> {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

    const [cashFlow, projects] = await Promise.all([
      this.prisma.cashFlowEntry.findMany({
        where: {
          tenantId,
          deletedAt: null,
          data: { gte: from },
          ...this.scopeWhere(scope),
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
        select: { projectId: true, tipo: true, status: true, valor: true, data: true },
      }),
      this.listProjects(tenantId, scope),
    ]);

    const pointsMap = new Map<string, ConsolidatedCashFlowPoint>();
    for (let i = 0; i < months; i++) {
      const m = new Date(from.getFullYear(), from.getMonth() + i, 1);
      const key = this.monthKey(m);
      pointsMap.set(key, {
        mes: key,
        planejado: 0,
        pago: 0,
        recebido: 0,
        previsto: 0,
        saldoAcumulado: 0,
        byProject: {},
      });
    }

    const projectIdSet = new Set(projects.map((p) => p.id));

    for (const e of cashFlow) {
      if (!projectIdSet.has(e.projectId)) continue;
      const key = this.monthKey(e.data);
      let pt = pointsMap.get(key);
      if (!pt) {
        pt = {
          mes: key,
          planejado: 0,
          pago: 0,
          recebido: 0,
          previsto: 0,
          saldoAcumulado: 0,
          byProject: {},
        };
        pointsMap.set(key, pt);
      }
      if (!pt.byProject[e.projectId]) pt.byProject[e.projectId] = { pago: 0, planejado: 0 };

      if (e.tipo === 'DESPESA') {
        if (e.status === 'PAGO') {
          pt.pago += e.valor;
          pt.byProject[e.projectId].pago += e.valor;
        } else if (e.status === 'PLANEJADO') {
          pt.planejado += e.valor;
          pt.byProject[e.projectId].planejado += e.valor;
        }
      } else if (e.tipo === 'RECEBIMENTO') {
        if (e.status === 'EM_CAIXA' || e.status === 'PAGO') pt.recebido += e.valor;
        else if (e.status === 'PREVISTO') pt.previsto += e.valor;
      }
    }

    const sorted = Array.from(pointsMap.values()).sort((a, b) => a.mes.localeCompare(b.mes));
    let acc = 0;
    for (const pt of sorted) {
      acc += pt.recebido - pt.pago;
      pt.saldoAcumulado = acc;
    }
    return sorted;
  }

  async getByCategory(tenantId: string, scope: string[] | null): Promise<CategoryRow[]> {
    const expenses = await this.prisma.expense.findMany({
      where: {
        tenantId,
        deletedAt: null,
        settledByExpenseId: null,
        linkedExpenseId: null,
        ...this.scopeWhere(scope),
      },
      select: { tipoDespesa: true, valorTotal: true },
    });
    const map = new Map<string, number>();
    for (const e of expenses) {
      map.set(e.tipoDespesa, (map.get(e.tipoDespesa) ?? 0) + e.valorTotal);
    }
    return Array.from(map.entries())
      .map(([key, total]) => ({
        key,
        label: ExpenseTypeLabels[key as keyof typeof ExpenseTypeLabels] ?? key,
        total,
      }))
      .sort((a, b) => b.total - a.total);
  }

  async getUpcoming(tenantId: string, days: number, scope: string[] | null): Promise<UpcomingDueRow[]> {
    const now = new Date();
    const until = new Date(now.getTime() + days * 24 * 3600 * 1000);
    const projects = await this.listProjects(tenantId, scope);
    const projMap = new Map(projects.map((p) => [p.id, p]));

    const entries = await this.prisma.cashFlowEntry.findMany({
      where: {
        tenantId,
        deletedAt: null,
        data: { gte: now, lte: until },
        status: { in: ['PLANEJADO', 'PREVISTO'] },
        ...this.scopeWhere(scope),
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
      orderBy: { data: 'asc' },
      take: 100,
      include: {
        expense: { select: { titulo: true, fornecedor: true } },
        receipt: { select: { descricao: true, tipo: true } },
      },
    });

    return entries
      .map((e) => {
        const proj = projMap.get(e.projectId);
        if (!proj) return null;
        const descricao =
          e.expense?.titulo ||
          e.expense?.fornecedor ||
          e.receipt?.descricao ||
          e.receipt?.tipo ||
          e.categoria;
        return {
          data: e.data.toISOString(),
          projectId: e.projectId,
          projectName: proj.name,
          projectType: proj.type as ProjectType,
          descricao,
          valor: e.valor,
          tipo: e.tipo as 'DESPESA' | 'RECEBIMENTO',
          status: e.status,
        };
      })
      .filter((x): x is UpcomingDueRow => x !== null);
  }

  async getTopSuppliers(tenantId: string, limit: number, scope: string[] | null): Promise<SupplierRow[]> {
    const expenses = await this.prisma.expense.findMany({
      where: {
        tenantId,
        deletedAt: null,
        fornecedor: { not: null },
        settledByExpenseId: null,
        linkedExpenseId: null,
        ...this.scopeWhere(scope),
      },
      select: {
        fornecedor: true,
        valorTotal: true,
        projectId: true,
        project: { select: { name: true } },
      },
    });

    const map = new Map<string, SupplierRow>();
    for (const e of expenses) {
      const key = (e.fornecedor || '').trim().toUpperCase();
      if (!key) continue;
      let row = map.get(key);
      if (!row) {
        row = { fornecedor: e.fornecedor || key, total: 0, count: 0, projetos: [] };
        map.set(key, row);
      }
      row.total += e.valorTotal;
      row.count += 1;
      if (!row.projetos.some((p) => p.projectId === e.projectId)) {
        row.projetos.push({ projectId: e.projectId, projectName: e.project.name });
      }
    }
    return Array.from(map.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
  }
}
