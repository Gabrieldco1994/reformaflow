export interface AccountViewCardSummary {
  nickname: string;
  last4: string;
  faturaAtual: number;
  faturaPendente: number;
  dueMonth: string;
  vencimento: string;
  status: 'paga' | 'a pagar';
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
  projetoOrigem: { id: string; name: string; type: string } | null;
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
  sobraPrevista: number;
  devoCartaoTotal: number;
  cartoes: AccountViewCardSummary[];
  contas: AccountViewConta[];
  saidas: AccountViewSaida[];
  comprasCartao: AccountViewSaida[];
  entradas: AccountViewEntrada[];
  ticketMedio: AccountViewTicketMedio;
}

export interface CardInvoicesYearlyCard {
  last4: string;
  nickname: string;
}

export interface CardInvoicesYearlyMonth {
  mes: string;
  label: string;
  porCartao: Record<string, number>;
  total: number;
}

export interface CardInvoicesYearlyResponse {
  year: number;
  cards: CardInvoicesYearlyCard[];
  months: CardInvoicesYearlyMonth[];
  totalAno: number;
}
