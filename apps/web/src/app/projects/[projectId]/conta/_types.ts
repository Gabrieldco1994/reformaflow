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
  suggestionTipoDespesa?: string | null;
  suggestionSource?: 'MANUAL' | 'AI' | 'REGEX' | 'CACHE' | null;
}

export interface AccountViewEntrada {
  id: string | null;
  kind: 'entrada';
  descricao: string;
  /** Descrição crua (sem fallback do label) — prefixa o modal de edição. */
  descricaoRaw?: string | null;
  data: string;
  tipo: string;
  valor: number;
  bankLast4: string | null;
  status: 'EM_CAIXA' | 'PREVISTO';
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
  /** Centavos: fluxo líquido realizado em espécie (sem conta/cartão). */
  carteiraHoje?: number;
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

/**
 * Resposta de `getAccountViewYearly` — mesmos campos de `AccountViewResponse`,
 * exceto `ticketMedio` (série de 12 meses, não 6). `MovimentacoesSection` só
 * consome os campos comuns (saidas/comprasCartao/entradas/cartoes/contas), por
 * isso aceita as duas respostas via união em vez de duplicar o componente.
 */
export interface AccountViewYearlyResponse extends Omit<AccountViewResponse, 'ticketMedio'> {
  ticketMedio: {
    valor: number;
    nCompras: number;
    totalCompras: number;
    serie12m: AccountViewTicketSeriePoint[];
    mediaAnual: number;
    deltaVsMediaPct: number | null;
  };
}

export interface CardInvoicesYearlyOrigin {
  key: string;
  kind: 'card' | 'conta' | 'carteira';
  last4: string;
  nickname: string;
}

export interface CardInvoicesYearlyMonth {
  mes: string;
  label: string;
  porOrigem: Record<string, number>;
  /**
   * Parcela de `porOrigem` que é "cartão paga cartão" (cobrança no cartão com
   * `settlesInvoiceKey`). Já está DENTRO de `porOrigem` — a fatura tem que bater com o
   * banco (contrato §7-1). Serve só para qualificar o total agregado, que ao somar as
   * faturas de todos os cartões conta esse dinheiro duas vezes.
   */
  transferenciasPorOrigem: Record<string, number>;
  total: number;
}

export interface CardInvoicesYearlyResponse {
  year: number;
  origins: CardInvoicesYearlyOrigin[];
  months: CardInvoicesYearlyMonth[];
  totalAno: number;
  transferenciasAno: number;
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
  origem?: { kind: 'card' | 'conta' | 'carteira'; last4: string; nickname: string };
}

export interface OriginItemsYearlyResponse {
  year: number;
  kind: 'card' | 'conta' | 'all';
  last4: string;
  items: OriginYearlyItem[];
  total: number;
}
