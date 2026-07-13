export type ProjectType = 'REFORMA' | 'COMPRA' | 'CASA' | 'CARRO' | 'PESSOAL';

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

export const PROJECT_TYPE_COLORS: Record<ProjectType, string> = {
  REFORMA: '#c2410c',
  CASA: '#0f766e',
  CARRO: '#1e3a8a',
  PESSOAL: '#9333ea',
  COMPRA: '#be185d',
};

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  REFORMA: 'Reforma',
  CASA: 'Casa',
  CARRO: 'Carro',
  PESSOAL: 'Pessoal',
  COMPRA: 'Compra',
};
