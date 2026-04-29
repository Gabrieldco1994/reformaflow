import {
  BudgetStatus,
  CashFlowType,
  PaymentMethod,
  PaymentStatus,
  WorkTypeCategory,
  CashFlowStatus,
  ChangeOrderStatus,
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
  totalBudget: number;
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

export interface WorkType {
  id: string;
  name: string;
  category: WorkTypeCategory;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface BudgetItem {
  id: string;
  projectId: string;
  roomId: string;
  workTypeId: string;
  planned: number;
  // Realizado é calculado dinamicamente — não armazenado
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Resultado do cálculo de um BudgetItem */
export interface BudgetItemComputed {
  id: string;
  roomName: string;
  workTypeName: string;
  planned: number;
  actual: number;
  balance: number;
  percentConsumed: number;
  status: BudgetStatus | '-';
}

export interface Contractor {
  id: string;
  projectId: string;
  name: string;
  document: string | null; // CPF/CNPJ mascarado
  phone: string | null;
  contractedAmount: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ContractorMilestone {
  id: string;
  contractorId: string;
  projectId: string;
  stage: string;
  description: string;
  percentage: number;
  amountDue: number;
  amountPaid: number;
  percentCompleted: number;
  releasedAmount: number;
  paymentDate: Date | null;
  paymentMethod: PaymentMethod | null;
  paymentStatus: PaymentStatus;
  hasInvoice: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface MaterialPurchase {
  id: string;
  projectId: string;
  roomId: string;
  workTypeId: string;
  date: Date;
  item: string;
  store: string | null;
  paymentMethod: PaymentMethod;
  totalAmount: number;
  installments: number;
  installmentAmount: number;
  warrantyMonths: number | null;
  hasInvoice: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CashFlowEntry {
  id: string;
  projectId: string;
  roomId: string | null;
  workTypeId: string | null;
  plannedDate: Date;
  effectiveDate: Date | null;
  description: string;
  type: CashFlowType;
  amount: number;
  status: CashFlowStatus;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Resultado do cálculo de fluxo de caixa com saldo acumulado */
export interface CashFlowEntryComputed extends CashFlowEntry {
  rollingBalance: number;
}

export interface ChangeOrder {
  id: string;
  projectId: string;
  roomId: string | null;
  workTypeId: string | null;
  date: Date;
  item: string;
  reason: string;
  additionalAmount: number;
  approvedBy: string | null;
  status: ChangeOrderStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
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
