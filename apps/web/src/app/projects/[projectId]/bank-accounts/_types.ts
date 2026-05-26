export interface BankAccountRow {
  id: string;
  institution: string;
  nickname: string | null;
  last4: string;
  agency: string | null;
  accountNumber: string | null;
}

export interface BankPreviewTx {
  externalId: string;
  date: string;
  merchant: string;
  amountCents: number;
  category: string | null;
  duplicate: boolean;
}

export interface BankPreviewResult {
  source: string;
  periodLabel: string | null;
  preview: BankPreviewTx[];
  total: number;
  duplicated: number;
  totalAmountCents: number;
  totalDebits?: number;
  totalCredits?: number;
  inserted?: number;
}

export interface BankCommitResult {
  importId: string;
  source: string;
  periodLabel: string;
  inserted: number;
  duplicated: number;
  receiptsInserted: number;
  cardPayments: number;
  aiReclassified: number;
  recurrencesCreated: number;
  skipped: number;
}

export interface BankSuggestionRow {
  expense: {
    id: string;
    titulo: string | null;
    fornecedor: string | null;
    valor: number;
    data: string;
    status: string;
    bankLast4: string | null;
    linkedExpenseId: string | null;
  };
  suggestions: Array<{
    expenseId: string;
    projectId: string;
    projectName: string;
    projectType: string;
    titulo: string | null;
    fornecedor: string | null;
    valor: number;
    data: string;
    deltaCents: number;
  }>;
}

export interface BankReceiptSuggestionRow {
  receipt: {
    id: string;
    valor: number;
    data: string;
    tipo: string;
    status: string;
    descricao: string | null;
    bankLast4: string | null;
    linkedReceiptId: string | null;
  };
  suggestions: Array<{
    receiptId: string;
    projectId: string;
    projectName: string;
    projectType: string;
    tipo: string;
    descricao: string | null;
    valor: number;
    data: string;
    deltaCents: number;
  }>;
}
