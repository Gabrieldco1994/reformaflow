import {
  recalculateAllTasks,
  calculateScheduleKPIs,
  sortScheduleByDate,
  type ScheduleDateConfig,
  type TaskForRecalc,
} from '@reformaflow/domain';
import type {
  GanttData,
  ScheduleConfig,
  ScheduleHoliday,
  ScheduleKPIs,
  ScheduleStage,
  ScheduleTask,
} from '../_types';
import { parsePredecessoras } from './format';

function buildDateConfig(
  config: ScheduleConfig,
  holidays: ScheduleHoliday[],
): ScheduleDateConfig {
  return {
    trabalhaDiasUteis: config.trabalhaDiasUteis,
    trabalhaSabados: config.trabalhaSabados,
    feriados: holidays.map((h) => new Date(h.data)),
  };
}

function flattenTasks(stages: ScheduleStage[]): ScheduleTask[] {
  return stages.flatMap((s) => s.tasks);
}

/**
 * Aplica o motor de cálculo do domínio às tarefas e devolve novos stages
 * com `dataInicio` e `dataTermino` atualizados.
 */
export function recalcStages(
  stages: ScheduleStage[],
  config: ScheduleConfig | null,
  holidays: ScheduleHoliday[],
): ScheduleStage[] {
  if (!config) return stages;

  const tasks = flattenTasks(stages);
  if (!tasks.length) return stages;

  const tasksForRecalc: TaskForRecalc[] = tasks.map((t) => ({
    id: t.id,
    numero: t.numero,
    duracao: t.duracao,
    predecessoras: parsePredecessoras(t.predecessoras),
    dataInicio: t.dataInicio ? new Date(t.dataInicio) : null,
    dataTermino: t.dataTermino ? new Date(t.dataTermino) : null,
  }));

  const results = recalculateAllTasks(
    tasksForRecalc,
    new Date(config.dataInicio),
    buildDateConfig(config, holidays),
  );

  const byId = new Map(results.map((r) => [r.id, r]));

  const withDates = stages.map((s) => ({
    ...s,
    tasks: s.tasks.map((t) => {
      const r = byId.get(t.id);
      if (!r) return t;
      return {
        ...t,
        dataInicio: r.dataInicio.toISOString(),
        dataTermino: r.dataTermino.toISOString(),
      };
    }),
  }));

  // Reordena cronologicamente para refletir datas/predecessoras (mesma regra do backend),
  // evitando que itens recém-criados ou reagendados fiquem fora de ordem após edições.
  return sortScheduleByDate(withDates);
}

export function computeKPIs(stages: ScheduleStage[]): ScheduleKPIs {
  const tasks = flattenTasks(stages);
  const kpis = calculateScheduleKPIs(
    tasks.map((t) => ({
      duracao: t.duracao,
      percentualConcluido: t.percentualConcluido,
      valorOrcado: t.valorOrcado,
      custoReal: t.custoReal,
      dataTermino: t.dataTermino ? new Date(t.dataTermino) : null,
    })),
  );
  return {
    totalOrcado: kpis.totalOrcado,
    totalReal: kpis.totalReal,
    totalDesvio: kpis.totalDesvio,
    percentualTotal: kpis.percentualTotal,
    terminoPrevisto: kpis.terminoPrevisto ? kpis.terminoPrevisto.toISOString() : null,
  };
}

/**
 * Recalcula dates e KPIs simultaneamente, mantendo a referência imutável
 * para que React detecte as mudanças.
 */
export function recalcAll(data: GanttData): GanttData {
  if (!data.config) return data;
  const stages = recalcStages(data.stages, data.config, data.holidays);
  const kpis = computeKPIs(stages);
  return { ...data, stages, kpis };
}
