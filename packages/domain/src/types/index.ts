import {
  ReceiptType,
  ReceiptStatus,
  ExpenseType,
  LaborCategory,
  PaymentForm,
  ExpenseStatus,
  CashFlowType,
  CashFlowStatus,
} from '../enums';

export interface Tenant {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Project {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Room {
  id: string;
  projectId: string;
  name: string;
  order: number;
  createdAt: Date;
  deletedAt: Date | null;
}

// ─── Recebimentos ───────────────────────────────────────────

export interface Receipt {
  id: string;
  projectId: string;
  tenantId: string;
  valor: number;    // centavos
  data: Date;
  tipo: ReceiptType;
  status: ReceiptStatus;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

// ─── Despesas ───────────────────────────────────────────────

export interface Expense {
  id: string;
  projectId: string;
  tenantId: string;
  tipoDespesa: ExpenseType;
  categoriaMaoDeObra: LaborCategory | null;
  roomId: string | null;
  valor: number;         // centavos (unitário)
  quantidade: number;
  valorTotal: number;    // centavos (calculado server-side)
  fornecedor: string | null;
  link: string | null;
  formaPagamento: PaymentForm;
  dataPagamento: Date | null;
  quantidadeParcela: number | null;
  dataInicioParcela: Date | null;
  status: ExpenseStatus;
  plannedExpenseId: string | null;
  settledByExpenseId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

// ─── Fluxo de Caixa ────────────────────────────────────────

export interface CashFlowEntry {
  id: string;
  projectId: string;
  tenantId: string;
  receiptId: string | null;
  expenseId: string | null;
  valor: number;   // centavos
  tipo: CashFlowType;
  data: Date;
  categoria: string;
  subcategoria: string | null;
  ambiente: string | null;
  formaPagamento: string | null;
  status: CashFlowStatus;
  parcela: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CashFlowEntryComputed extends CashFlowEntry {
  rollingBalance: number;
  rollingBalanceRealizado: number;
}

// ─── Dashboard ──────────────────────────────────────────────

export interface DashboardKpis {
  dinheiroDisponivel: number;   // Σ recebimentos EM_CAIXA
  jaPaguei: number;             // Σ cashflow DESPESA+PAGO
  previsaoGastos: number;       // Σ cashflow DESPESA+PLANEJADO
  previsaoRecebimentos: number; // Σ recebimentos PREVISTO
  previsaoSaldo: number;        // disponivel + previsaoReceb - jaPaguei - previsaoGastos
}

export interface DashboardRoomSummary {
  roomName: string;
  planejado: number;
  pago: number;
}

export interface DashboardExpenseTypeSummary {
  tipoDespesa: string;
  label: string;
  total: number;
}

export interface DashboardExpenseCategorySummary {
  categoria: string;
  label: string;
  total: number;
}

export interface DashboardData {
  kpis: DashboardKpis;
  byRoom: DashboardRoomSummary[];
  byExpenseType: DashboardExpenseTypeSummary[];
  byExpenseCategory: DashboardExpenseCategorySummary[];
}

export interface Attachment {
  id: string;
  entityType: string;
  entityId: string;
  fileName: string;
  mimeType: string;
  url: string;
  uploadedBy: string;
  createdAt: Date;
  deletedAt: Date | null;
}
