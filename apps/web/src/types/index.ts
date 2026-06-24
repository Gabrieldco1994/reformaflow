// Dashboard
export interface DashboardResponse {
  kpis: {
    dinheiroDisponivel: number;
    jaPaguei: number;
    previsaoGastos: number;
    previsaoRecebimentos: number;
    previsaoSaldo: number;
    saldo: number;
  };
  resumoPorAmbiente: RoomSummary[];
  resumoPorTipoDespesa: LabelTotal[];
  resumoPorCategoria: LabelTotal[];
  despesasMensal: DespesaMensal[];
  saldoAcumuladoMensal: SaldoMensal[];
}

export interface RoomSummary {
  roomName: string;
  planned: number;
  actual: number;
}

export interface LabelTotal {
  label: string;
  total: number;
}

export interface DespesaMensal {
  mes: string;
  planejado: number;
  pago: number;
}

export interface SaldoMensal {
  mes: string;
  recebimentos: number;
  despesas: number;
  recebimentosRealizados: number;
  despesasRealizadas: number;
  saldoAcumulado: number;
  saldoAcumuladoRealizado: number;
}

// Receipts
export interface Receipt {
  id: string;
  valor: number;
  data: string;
  tipo: ReceiptType;
  status: ReceiptStatus;
}

export type ReceiptType =
  | 'PAGAMENTO'
  | 'BONUS'
  | 'VENDA_ACAO'
  | 'ORCAMENTO_INICIAL'
  | 'SALARIO'
  | 'ADIANTAMENTO_SALARIO'
  | 'DECIMO_TERCEIRO'
  | 'FERIAS'
  | 'FREELANCE'
  | 'ALUGUEL'
  | 'REEMBOLSO'
  | 'DIVIDENDOS'
  | 'JUROS_RENDA_FIXA'
  | 'RESGATE'
  | 'POUPANCA'
  | 'ACAO'
  | 'FII'
  | 'CRIPTO'
  | 'PENSAO'
  | 'RESTITUICAO_IR'
  | 'COMISSAO'
  | 'VENDA_BEM'
  | 'PRESENTE'
  | 'OUTROS';
export type ReceiptStatus = 'PREVISTO' | 'EM_CAIXA';

export interface ReceiptFormData {
  valor: number;
  data: string;
  tipo: ReceiptType;
  status: ReceiptStatus;
}

// Expenses
export interface Expense {
  id: string;
  projectId?: string;
  tipoDespesa: string;
  categoriaMaoDeObra?: string;
  roomId?: string;
  room?: { id: string; name: string };
  valor: number;
  quantidade: number;
  valorTotal: number;
  titulo?: string;
  fornecedor?: string;
  link?: string;
  imageUrl?: string;
  formaPagamento: string;
  dataPagamento?: string;
  quantidadeParcela?: number;
  dataInicioParcela?: string;
  dataCompra?: string | null; // COMPETÊNCIA: data real da compra (eixo "Gastos Controle"). Não afeta a Conta Real.
  status: ExpenseStatus;
  recorrente?: boolean; // despesa fixa mensal (ocorrência virtual)
  recorrenciaFim?: string | null; // último mês da recorrência (ISO) ou null
  paidParcelas?: string | null; // JSON array de índices 0-based de parcelas pagas
  // Vínculos
  cardLast4?: string | null;
  bankLast4?: string | null;
  linkedExpenseId?: string | null;
  importId?: string | null;
  // Project info (presente em listagens cross-project)
  project?: { id: string; name: string; type: string } | null;
}

export type ExpenseStatus = 'PLANEJADO' | 'PAGO';

export interface ExpensesPage {
  items: Expense[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ExpenseFormData {
  tipoDespesa: string;
  categoriaMaoDeObra?: string | null;
  roomId?: string | null;
  valor: number;
  quantidade: number;
  titulo?: string | null;
  fornecedor?: string | null;
  link?: string | null;
  imageUrl?: string | null;
  formaPagamento: string;
  dataPagamento?: string | null;
  quantidadeParcela?: number | null;
  dataInicioParcela?: string | null;
  status: ExpenseStatus;
  recorrente?: boolean | null;
  recorrenciaFim?: string | null;
  // Vínculos opcionais
  creditCardId?: string | null;
  bankAccountId?: string | null;
  linkedExpenseId?: string | null;
}

// Cash Flow
export interface CashFlowEntry {
  id: string;
  data: string;
  tipo: 'RECEBIMENTO' | 'DESPESA';
  valor: number;
  categoria?: string;
  subcategoria?: string;
  ambiente?: string;
  formaPagamento?: string;
  parcela?: string;
  status: string;
  rollingBalance: number;
  rollingBalanceRealizado: number;
  expenseId?: string | null;
  receiptId?: string | null;
  titulo?: string | null;
  fornecedor?: string | null;
}

// Project
export interface Project {
  id: string;
  name: string;
  rooms: { id: string; name: string }[];
}
