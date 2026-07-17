export interface AccountViewCardSummary {
  nickname: string;
  last4: string;
  faturaAtual: number;
  faturaPendente: number;
  faturaPaga: number;
  residualDeclarado: number;
  possuiIntervencaoManual: boolean;
  ajusteManualTotal: number;
  dueMonth: string;
  vencimento: string;
  status: 'paga' | 'a pagar' | 'parcial';
  limiteUsadoPct: number | null;
  limiteUsado: number | null;
  limiteTotal: number | null;
}

export interface AccountViewConta {
  last4: string;
  nome: string;
}

export interface AccountViewSaida {
  id: string | null;
  kind: 'saida';
  descricao: string;
  data: string;
  forma: 'cartao' | 'pix' | 'debito' | 'boleto' | 'ted';
  valor: number;
  realizado: boolean;
  status: string;
  cardLast4: string | null;
  bankLast4: string | null;
  tipoDespesa: string;
  isInvoice: boolean;
  editavel: boolean;
  dueMonth: string | null;
  invoicePaidAmount?: number;
  invoiceResidualDeclared?: number;
  invoiceHasManualIntervention?: boolean;
  invoiceAdjustmentAmount?: number;
  projetoOrigem: { id: string; name: string; type: string } | null;
  parcelaIndex?: number | null;
  foreignExpenseId?: string | null;
}

export interface AccountViewEntrada {
  id: string | null;
  kind: 'entrada';
  descricao: string;
  data: string;
  tipo: string;
  valor: number;
  bankLast4: string | null;
  status: string;
}

export type AccountViewMovimentacao = AccountViewSaida | AccountViewEntrada;

export interface AccountViewTicketSeriePoint {
  mes: string;
  valor: number;
  deltaPct: number | null;
}

export interface AccountViewTicketMedio {
  valor: number;
  nCompras: number;
  totalCompras: number;
  serie6m: AccountViewTicketSeriePoint[];
  media6m: number;
  deltaVsMediaPct: number | null;
}

export interface AccountViewResponse {
  mesSelecionado: string;
  caixaHoje: number;
  entrouMes: number;
  saiuMes: number;
  faltaPagarMes: number;
  recebimentosPrevistosMes: number;
  sobraPrevista: number;
  devoCartaoTotal: number;
  cartoes: AccountViewCardSummary[];
  contas: AccountViewConta[];
  saidas: AccountViewSaida[];
  comprasCartao: AccountViewSaida[];
  entradas: AccountViewEntrada[];
  ticketMedio: AccountViewTicketMedio;
}

export interface CardInvoicesYearlyOrigin {
  key: string;
  kind: 'card' | 'conta';
  last4: string;
  nickname: string;
}

export interface CardInvoicesYearlyMonth {
  mes: string;
  label: string;
  porOrigem: Record<string, number>;
  total: number;
}

export interface CardInvoicesYearlyResponse {
  year: number;
  origins: CardInvoicesYearlyOrigin[];
  months: CardInvoicesYearlyMonth[];
  totalAno: number;
}

export interface OriginYearlyItem {
  mes: string;
  data: string;
  descricao: string;
  valor: number;
  tipoDespesa: string;
  status: string;
  projetoOrigem: { id: string; name: string; type: string } | null;
  /** Presente só na variante "Todos" (kind='all'): origem do lançamento. */
  origem?: { kind: 'card' | 'conta'; last4: string; nickname: string };
}

export interface OriginItemsYearlyResponse {
  year: number;
  kind: 'card' | 'conta' | 'all';
  last4: string;
  items: OriginYearlyItem[];
  total: number;
}
