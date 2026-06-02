export interface MonthlyOverviewRow {
  mes: string;
  totalDespesas: number;
  totalRecebimentos: number;
  despesasRealizadas: number;
  recebimentosRealizados: number;
  saldoMes: number;
  saldoMesRealizado: number;
  porOrigem: Record<string, { despesas: number; recebimentos: number }>;
  porCategoria: Array<{ categoria: string; valor: number }>;
}

export interface MonthComparison {
  current: MonthlyOverviewRow | null;
  previous: MonthlyOverviewRow | null;
  deltaDespesas: number;
  deltaDespesasPct: number | null;
  deltaRecebimentos: number;
  deltaRecebimentosPct: number | null;
  deltaSaldo: number;
}

export interface MonthlyEntry {
  id: string;
  data: string;
  tipo: 'DESPESA' | 'RECEBIMENTO';
  status: string;
  valor: number;
  categoria: string | null;
  subcategoria: string | null;
  formaPagamento: string | null;
  projectId: string;
  projectName: string;
  projectType: string;
}

export interface MonthlyOverviewResponse {
  mesAtual: string;
  meses: MonthlyOverviewRow[];
  comparativo: MonthComparison;
  mesAtualEntries: MonthlyEntry[];
  entries?: MonthlyEntry[];
  projetos: Array<{ id: string; name: string; type: string }>;
}
