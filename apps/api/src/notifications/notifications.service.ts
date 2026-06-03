import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isNeutralExpenseType } from '@reformaflow/domain';

export interface SummaryItem {
  id: string;
  projectId: string;
  projectName: string;
  projectType: string;
  titulo: string;
  valor?: number;
  data: string;
  meta?: string;
}

export interface DailySummary {
  data: string; // ISO date (yyyy-mm-dd) referente a "hoje"
  hoje: {
    gastos: { total: number; count: number; items: SummaryItem[] };
    recebimentos: { total: number; count: number; items: SummaryItem[] };
    tarefasAtivas: SummaryItem[];
    vencendoHoje: SummaryItem[];
  };
  proximos7Dias: {
    vencimentos: SummaryItem[];
    tarefasComecando: SummaryItem[];
    lembretes: SummaryItem[];
    manutencoes: SummaryItem[];
    contasRecorrentes: SummaryItem[];
  };
  totalBadge: number;
}

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async getDailySummary(tenantId: string): Promise<DailySummary> {
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
      0,
    );
    const endOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999,
    );
    const endOfWeek = new Date(startOfToday);
    endOfWeek.setDate(endOfWeek.getDate() + 7);
    endOfWeek.setHours(23, 59, 59, 999);

    const projects = await this.prisma.project.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, name: true, type: true },
    });
    const projectMap = new Map(projects.map((p) => [p.id, p]));

    const cashFlowHoje = await this.prisma.cashFlowEntry.findMany({
      where: {
        tenantId,
        deletedAt: null,
        data: { gte: startOfToday, lte: endOfToday },
      },
      include: { expense: { select: { tipoDespesa: true, titulo: true } } },
      orderBy: { data: 'asc' },
    });

    const gastosItems: SummaryItem[] = [];
    const recebimentosItems: SummaryItem[] = [];
    let gastosTotal = 0;
    let recebimentosTotal = 0;

    for (const c of cashFlowHoje) {
      const proj = projectMap.get(c.projectId);
      if (!proj) continue;
      if (c.expense && isNeutralExpenseType(c.expense.tipoDespesa)) continue;

      const item: SummaryItem = {
        id: c.id,
        projectId: c.projectId,
        projectName: proj.name,
        projectType: proj.type,
        titulo: c.expense?.titulo || c.categoria,
        valor: c.valor,
        data: c.data.toISOString(),
        meta: c.status,
      };

      if (c.tipo === 'DESPESA') {
        gastosTotal += c.valor;
        gastosItems.push(item);
      } else if (c.tipo === 'RECEBIMENTO') {
        recebimentosTotal += c.valor;
        recebimentosItems.push(item);
      }
    }

    const cashFlowProximos = await this.prisma.cashFlowEntry.findMany({
      where: {
        tenantId,
        deletedAt: null,
        data: { gt: endOfToday, lte: endOfWeek },
        status: { in: ['PLANEJADO', 'PREVISTO'] },
      },
      include: { expense: { select: { tipoDespesa: true, titulo: true } } },
      orderBy: { data: 'asc' },
      take: 50,
    });
    const vencimentosItems: SummaryItem[] = cashFlowProximos
      .filter(
        (c) => !(c.expense && isNeutralExpenseType(c.expense.tipoDespesa)),
      )
      .map((c) => {
        const proj = projectMap.get(c.projectId);
        return {
          id: c.id,
          projectId: c.projectId,
          projectName: proj?.name ?? '',
          projectType: proj?.type ?? '',
          titulo: c.expense?.titulo || c.categoria,
          valor: c.valor,
          data: c.data.toISOString(),
          meta: c.tipo,
        };
      });

    const tasks = await this.prisma.scheduleTask.findMany({
      where: {
        tenantId,
        deletedAt: null,
        OR: [
          {
            dataInicio: { lte: endOfToday },
            dataTermino: { gte: startOfToday },
            percentualConcluido: { lt: 100 },
          },
          {
            dataInicio: { gt: endOfToday, lte: endOfWeek },
          },
        ],
      },
      orderBy: { dataInicio: 'asc' },
    });

    const tarefasAtivas: SummaryItem[] = [];
    const tarefasComecando: SummaryItem[] = [];
    for (const t of tasks) {
      const proj = projectMap.get(t.projectId);
      if (!proj || !t.dataInicio) continue;
      const item: SummaryItem = {
        id: t.id,
        projectId: t.projectId,
        projectName: proj.name,
        projectType: proj.type,
        titulo: t.nome,
        data: t.dataInicio.toISOString(),
        meta: `${t.percentualConcluido}%`,
      };
      if (t.dataInicio > endOfToday) {
        tarefasComecando.push(item);
      } else {
        tarefasAtivas.push(item);
      }
    }

    const bills = await this.prisma.recurringBill.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: 'ATIVO',
        proximoVencimento: { gte: startOfToday, lte: endOfWeek },
      },
      orderBy: { proximoVencimento: 'asc' },
    });
    const vencendoHoje: SummaryItem[] = [];
    const contasRecorrentes: SummaryItem[] = [];
    for (const b of bills) {
      const proj = projectMap.get(b.projectId);
      if (!proj || !b.proximoVencimento) continue;
      const item: SummaryItem = {
        id: b.id,
        projectId: b.projectId,
        projectName: proj.name,
        projectType: proj.type,
        titulo: b.nome,
        valor: b.valor,
        data: b.proximoVencimento.toISOString(),
        meta: b.categoria,
      };
      if (b.proximoVencimento <= endOfToday) vencendoHoje.push(item);
      else contasRecorrentes.push(item);
    }

    const reminders = await this.prisma.reminder.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: 'PENDENTE',
        data: { gte: startOfToday, lte: endOfWeek },
      },
      orderBy: { data: 'asc' },
    });
    const lembretes: SummaryItem[] = [];
    for (const r of reminders) {
      const proj = projectMap.get(r.projectId);
      if (!proj) continue;
      const item: SummaryItem = {
        id: r.id,
        projectId: r.projectId,
        projectName: proj.name,
        projectType: proj.type,
        titulo: r.titulo,
        data: r.data.toISOString(),
        meta: r.prioridade,
      };
      if (r.data <= endOfToday) vencendoHoje.push(item);
      else lembretes.push(item);
    }

    const manuts = await this.prisma.maintenanceLog.findMany({
      where: {
        tenantId,
        deletedAt: null,
        dataProxima: { gte: startOfToday, lte: endOfWeek },
      },
      orderBy: { dataProxima: 'asc' },
    });
    const manutencoes: SummaryItem[] = [];
    for (const m of manuts) {
      const proj = projectMap.get(m.projectId);
      if (!proj || !m.dataProxima) continue;
      const item: SummaryItem = {
        id: m.id,
        projectId: m.projectId,
        projectName: proj.name,
        projectType: proj.type,
        titulo: m.tipo,
        data: m.dataProxima.toISOString(),
        meta: m.fornecedor ?? undefined,
      };
      if (m.dataProxima <= endOfToday) vencendoHoje.push(item);
      else manutencoes.push(item);
    }

    const totalBadge =
      gastosItems.length +
      recebimentosItems.length +
      tarefasAtivas.length +
      vencendoHoje.length;

    return {
      data: startOfToday.toISOString().slice(0, 10),
      hoje: {
        gastos: {
          total: gastosTotal,
          count: gastosItems.length,
          items: gastosItems,
        },
        recebimentos: {
          total: recebimentosTotal,
          count: recebimentosItems.length,
          items: recebimentosItems,
        },
        tarefasAtivas,
        vencendoHoje,
      },
      proximos7Dias: {
        vencimentos: vencimentosItems,
        tarefasComecando,
        lembretes,
        manutencoes,
        contasRecorrentes,
      },
      totalBadge,
    };
  }
}
