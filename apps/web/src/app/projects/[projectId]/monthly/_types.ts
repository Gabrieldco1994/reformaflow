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
  /** Código bruto do tipo de despesa (ex.: 'PAGAMENTO_FATURA_CARTAO'), para detecção de neutras.
   *  ATENÇÃO: vem ora como label ora como enum — NÃO usar para decidir neutro. Prefira `isNeutral`. */
  categoriaCodigo?: string | null;
  /** Enum cru do tipo de despesa (join Expense), sinal confiável para exibição/depuração. */
  tipoDespesaCodigo?: string | null;
  /** É tipo neutro (pagamento de fatura / movimentação interna)? Derivado no backend de
   *  `expense.tipoDespesa` — sinal CONFIÁVEL. Ausente em payloads de backend antigo (fallback no FE). */
  isNeutral?: boolean;
  /** É neutro DE CONSUMO? Superset de `isNeutral` + aporte (INVESTIMENTOS) na despesa e
   *  resgate (RESGATE) no recebimento. Usado para tirar do consumo/resultado SEM tirar do
   *  eixo de caixa (§10). Derivado no backend; ausente em payload antigo (fallback no FE). */
  isNeutralConsumo?: boolean;
  subcategoria: string | null;
  parcela?: string | null;
  formaPagamento: string | null;
  projectId: string;
  projectName: string;
  projectType: string;
  /** Últimos 4 dígitos do cartão de origem (null = débito de conta). */
  cardLast4?: string | null;
  /** Últimos 4 dígitos da conta bancária de origem (débito/PIX). */
  bankLast4?: string | null;
  /** Despesa PESSOAL vinculada a outro projeto (espelho). Conta no PESSOAL-only; dedup no consolidado. */
  isEspelho?: boolean;
  /** Id da Expense de origem (null = lançamento manual de cashflow). Para editar o tipo. */
  expenseId?: string | null;
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
  /** Projeção de caixa do MÊS CORRENTE (§10, mesma fonte da Visão Conta). Alimenta o
   *  card "Projeção fim do mês" no cockpit — conceito de caixa, igual nos dois eixos.
   *  Ausente em payload antigo/erro → frontend cai no cálculo por competência. */
  projecao?: {
    caixaHoje: number;
    entrouMes: number;
    saiuMes: number;
    faltaPagarMes: number;
    recebimentosPrevistosMes: number;
    sobraPrevista: number;
  };
}
