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
  data: string;
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
