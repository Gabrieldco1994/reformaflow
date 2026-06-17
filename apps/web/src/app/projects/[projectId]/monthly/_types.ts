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
  /** Últimos 4 dígitos do cartão de origem (null = débito de conta). */
  cardLast4?: string | null;
  /** Despesa PESSOAL vinculada a outro projeto (espelho). Conta no PESSOAL-only; dedup no consolidado. */
  isEspelho?: boolean;
}

/** Caixa real da conta corrente (reconciliação §10). Valores em centavos. */
export interface CaixaConta {
  /** Saldo da conta hoje = saldo inicial + lançamentos realizados da conta. */
  hoje: number;
  /** Soma dos saldos iniciais cadastrados nas contas do projeto. */
  saldoInicial: number;
  /** Há saldo inicial cadastrado? Se não, `hoje` é só o fluxo (não bate com o banco). */
  temSaldoInicial: boolean;
  /** Saldo acumulado ao fim de cada mês (para sparkline e delta). */
  porMes: Array<{ mes: string; caixa: number }>;
}

/** Configuração de cartão para derivar o mês de caixa (vencimento). */
export interface CardConfigDTO {
  last4: string;
  nickname: string;
  closingDay: number | null;
  dueDay: number | null;
}

export interface MonthlyOverviewResponse {
  mesAtual: string;
  meses: MonthlyOverviewRow[];
  comparativo: MonthComparison;
  mesAtualEntries: MonthlyEntry[];
  entries?: MonthlyEntry[];
  projetos: Array<{ id: string; name: string; type: string }>;
  caixa?: CaixaConta;
  cards?: CardConfigDTO[];
}
