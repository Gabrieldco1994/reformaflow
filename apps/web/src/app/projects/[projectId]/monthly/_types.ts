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

export interface AccumulatedRow extends MonthlyOverviewRow {
  saldoAcumulado: number;
  saldoAcumuladoRealizado: number;
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
  projetos: Array<{ id: string; name: string; type: string }>;
}

export const ORIGIN_COLORS: Record<string, string> = {
  PESSOAL: '#138A6B',
  REFORMA: '#4F000B',
  CASA: '#A8327D',
  CARRO: '#D77A61',
  OUTROS: '#888',
};

export const ORIGIN_ICONS: Record<string, string> = {
  PESSOAL: '💰',
  REFORMA: '🏗️',
  CASA: '🏡',
  CARRO: '🚗',
  OUTROS: '📦',
};

export function formatMesLabel(mes: string) {
  const [y, m] = mes.split('-');
  const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${meses[parseInt(m ?? '1') - 1]}/${(y ?? '').slice(2)}`;
}
