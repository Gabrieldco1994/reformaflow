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
  transactions: BankPreviewTx[];
  totals: { count: number; sumCents: number; duplicates: number };
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
    id: string;
    projectId: string;
    projectName: string;
    projectType: string;
    titulo: string | null;
    fornecedor: string | null;
    valor: number;
    data: string;
    status: string;
    matchScore: number;
  }>;
}
