export interface CardRow {
  id: string;
  institution: string;
  brand: string;
  nickname: string | null;
  last4: string;
  limitTotalCents: number | null;
  limitAvailableCents: number | null;
  closingDay: number | null;
  dueDay: number | null;
}

export interface PreviewTx {
  externalId: string;
  date: string;
  merchant: string;
  amountCents: number;
  category: string | null;
  installmentCurrent: number | null;
  installmentTotal: number | null;
  duplicate: boolean;
}

export interface PreviewResult {
  source: string;
  periodLabel: string | null;
  preview: PreviewTx[];
  total: number;
  duplicated: number;
  totalAmountCents: number;
  inserted?: number;
}

export interface CommitResult {
  source: string;
  periodLabel: string;
  inserted: number;
  duplicated: number;
  settled: number;
  importId: string;
}

export interface SuggestionRow {
  expense: {
    id: string;
    titulo: string | null;
    fornecedor: string | null;
    valor: number;
    data: string;
    status: string;
    cardLast4: string | null;
    linkedExpenseId: string | null;
    seriesKey: string | null;
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
