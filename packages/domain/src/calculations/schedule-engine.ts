// Motor de cálculo de datas para cronograma de obra
// Respeita feriados, fins de semana e configuração de dias úteis

export interface ScheduleDateConfig {
  trabalhaDiasUteis: boolean;
  trabalhaSabados: boolean;
  feriados: Date[]; // datas dos feriados
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isHoliday(date: Date, holidays: Date[]): boolean {
  return holidays.some((h) => isSameDay(date, h));
}

function isWeekend(date: Date, config: ScheduleDateConfig): boolean {
  const day = date.getDay();
  if (day === 0) return true; // Domingo sempre é folga
  if (day === 6 && !config.trabalhaSabados) return true;
  return false;
}

export function isWorkingDay(date: Date, config: ScheduleDateConfig): boolean {
  if (!config.trabalhaDiasUteis) {
    // Trabalha todos os dias — só pula feriados
    return !isHoliday(date, config.feriados);
  }
  if (isWeekend(date, config)) return false;
  if (isHoliday(date, config.feriados)) return false;
  return true;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Avança para o próximo dia útil (se o dia atual não for útil) */
export function nextWorkingDay(date: Date, config: ScheduleDateConfig): Date {
  let d = new Date(date);
  while (!isWorkingDay(d, config)) {
    d = addDays(d, 1);
  }
  return d;
}

/**
 * Calcula a data de término dado início e duração em dias úteis.
 * Duração 1 = mesmo dia (se for útil).
 */
export function calculateEndDate(
  startDate: Date,
  durationDays: number,
  config: ScheduleDateConfig,
): Date {
  if (durationDays <= 0) return new Date(startDate);

  let d = nextWorkingDay(new Date(startDate), config);
  let remaining = durationDays - 1; // primeiro dia conta como dia 1

  while (remaining > 0) {
    d = addDays(d, 1);
    if (isWorkingDay(d, config)) {
      remaining--;
    }
  }

  return d;
}

/**
 * Calcula o próximo dia útil após a data de término de uma predecessora.
 */
export function calculateStartAfterPredecessor(
  predecessorEnd: Date,
  config: ScheduleDateConfig,
): Date {
  return nextWorkingDay(addDays(predecessorEnd, 1), config);
}

/**
 * Conta os dias úteis entre duas datas (inclusive).
 */
export function getWorkingDaysBetween(
  start: Date,
  end: Date,
  config: ScheduleDateConfig,
): number {
  let count = 0;
  let d = new Date(start);
  while (d <= end) {
    if (isWorkingDay(d, config)) count++;
    d = addDays(d, 1);
  }
  return count;
}

export interface TaskForRecalc {
  id: string;
  numero: number;
  duracao: number;
  predecessoras: number[]; // números das tarefas predecessoras
  dataInicio: Date | null;
  dataTermino: Date | null;
}

interface RecalcResult {
  id: string;
  dataInicio: Date;
  dataTermino: Date;
}

/**
 * Recalcula datas de todas as tarefas baseado em dependências.
 * Tarefas sem predecessoras mantêm sua dataInicio.
 * Tarefas com predecessoras: início = dia útil após maior término das predecessoras.
 */
export function recalculateAllTasks(
  tasks: TaskForRecalc[],
  projectStart: Date,
  config: ScheduleDateConfig,
): RecalcResult[] {
  const results = new Map<number, RecalcResult>();
  const taskMap = new Map<number, TaskForRecalc>();
  tasks.forEach((t) => taskMap.set(t.numero, t));

  function resolve(task: TaskForRecalc): RecalcResult {
    const cached = results.get(task.numero);
    if (cached) return cached;

    let startDate: Date;

    if (task.predecessoras.length === 0) {
      // Sem predecessoras: usa data do task ou início do projeto
      startDate = nextWorkingDay(
        task.dataInicio || projectStart,
        config,
      );
    } else {
      // Com predecessoras: inicia após a maior data de término
      let latestEnd = new Date(0);
      for (const predNum of task.predecessoras) {
        const pred = taskMap.get(predNum);
        if (pred) {
          const predResult = resolve(pred);
          if (predResult.dataTermino > latestEnd) {
            latestEnd = predResult.dataTermino;
          }
        }
      }
      startDate = calculateStartAfterPredecessor(latestEnd, config);
    }

    const endDate = calculateEndDate(startDate, task.duracao, config);

    const result: RecalcResult = {
      id: task.id,
      dataInicio: startDate,
      dataTermino: endDate,
    };
    results.set(task.numero, result);
    return result;
  }

  // Resolve todas as tarefas
  for (const task of tasks) {
    resolve(task);
  }

  return Array.from(results.values());
}

/**
 * Calcula KPIs do cronograma
 */
export function calculateScheduleKPIs(
  tasks: Array<{
    duracao: number;
    percentualConcluido: number;
    valorOrcado: number | null;
    custoReal: number | null;
    dataTermino: Date | null;
  }>,
) {
  let totalOrcado = 0;
  let totalReal = 0;
  let totalDuracaoPonderada = 0;
  let totalDuracao = 0;
  let maxTermino: Date | null = null;

  for (const t of tasks) {
    totalOrcado += t.valorOrcado || 0;
    totalReal += t.custoReal || 0;
    totalDuracaoPonderada += t.duracao * t.percentualConcluido;
    totalDuracao += t.duracao;
    if (t.dataTermino && (!maxTermino || t.dataTermino > maxTermino)) {
      maxTermino = t.dataTermino;
    }
  }

  return {
    totalOrcado,
    totalReal,
    totalDesvio: totalReal - totalOrcado,
    percentualTotal:
      totalDuracao > 0
        ? Math.round(totalDuracaoPonderada / totalDuracao)
        : 0,
    terminoPrevisto: maxTermino,
  };
}
