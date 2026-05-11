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
  saldoAcumulado: number;
}

// Receipts
export interface Receipt {
  id: string;
  valor: number;
  data: string;
  tipo: ReceiptType;
  status: ReceiptStatus;
}

export type ReceiptType = 'PAGAMENTO' | 'BONUS' | 'VENDA_ACAO' | 'ORCAMENTO_INICIAL';
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
  status: ExpenseStatus;
}

export type ExpenseStatus = 'PLANEJADO' | 'PAGO';

export interface ExpenseFormData {
  tipoDespesa: string;
  categoriaMaoDeObra?: string;
  roomId?: string;
  valor: number;
  quantidade: number;
  titulo?: string;
  fornecedor?: string;
  link?: string;
  imageUrl?: string;
  formaPagamento: string;
  dataPagamento?: string;
  quantidadeParcela?: number;
  dataInicioParcela?: string;
  status: ExpenseStatus;
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
