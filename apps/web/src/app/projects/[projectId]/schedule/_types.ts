export interface ScheduleConfig {
  id: string;
  dataInicio: string;
  trabalhaDiasUteis: boolean;
  trabalhaSabados: boolean;
  linhaBaseData?: string;
}

export interface ScheduleTask {
  id: string;
  stageId: string;
  numero: number;
  nome: string;
  duracao: number;
  dataInicio: string | null;
  dataTermino: string | null;
  predecessoras: string | null;
  valorOrcado: number | null;
  custoReal: number | null;
  percentualConcluido: number;
  ordem: number;
  dataInicioBase?: string | null;
  dataTerminoBase?: string | null;
}

export interface ScheduleStage {
  id: string;
  nome: string;
  ordem: number;
  tasks: ScheduleTask[];
}

export interface ScheduleHoliday {
  id: string;
  nome: string;
  data: string;
}

export interface ScheduleKPIs {
  totalOrcado: number;
  totalReal: number;
  totalDesvio: number;
  percentualTotal: number;
  terminoPrevisto: string | null;
}

export interface GanttData {
  config: ScheduleConfig | null;
  stages: ScheduleStage[];
  holidays: ScheduleHoliday[];
  kpis: ScheduleKPIs;
}

export type TaskUpdatePatch = Partial<{
  nome: string;
  duracao: number;
  dataInicio: string | null;
  predecessoras: string | null;
  valorOrcado: number | null;
  custoReal: number | null;
  percentualConcluido: number;
  ordem: number;
}>;
