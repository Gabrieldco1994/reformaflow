export interface AccountViewCardSummary {
  nickname: string;
  last4: string;
  faturaAtual: number;
  vencimento: string;
  status: 'paga' | 'a pagar';
  limiteUsadoPct: number | null;
  limiteUsado: number | null;
  limiteTotal: number | null;
}

export interface AccountViewSaida {
  descricao: string;
  data: string;
  forma: 'cartao' | 'pix' | 'debito' | 'boleto' | 'ted';
  valor: number;
  realizado: boolean;
}

export interface AccountViewEntrada {
  descricao: string;
  data: string;
  tipo: string;
  valor: number;
}

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
  saidas: AccountViewSaida[];
  entradas: AccountViewEntrada[];
  ticketMedio: AccountViewTicketMedio;
}
