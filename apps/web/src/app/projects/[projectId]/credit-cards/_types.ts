import type {
  CategoriaFonte,
  ImportClassificationStatus,
} from '@/components/import/ImportClassificationNotice';

export type { CategoriaFonte, ImportClassificationStatus };

export interface CardRow {
  id: string;
  projectId?: string;
  project?: {
    id: string;
    name: string;
    type: string;
  };
  institution: string;
  brand: string;
  nickname: string | null;
  last4: string;
  limitTotalCents: number | null;
  limitAvailableCents: number | null;
  limitUsedCents?: number;
  limitAvailableComputedCents?: number;
  limitUsagePercent?: number;
  currentOpenInvoiceMonth?: string;
  closingDay: number | null;
  dueDay: number | null;
}

export interface CrossProjectMatch {
  expenseId: string;
  projectId: string;
  projectName: string;
  projectType: string;
  titulo: string | null;
  fornecedor?: string | null;
  valorCents: number;
  data: string;
  deltaCents: number;
  installmentCurrent?: number | null;
  installmentTotal?: number | null;
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
  suggestedCategory?: string;
  /** Origem da categoria sugerida nesta linha (#582 PR-5). `null` = heurístico não casou. */
  categoriaFonte?: CategoriaFonte | null;
  crossProjectMatches?: CrossProjectMatch[];
  isFuture?: boolean;
}

export interface PreviewResult {
  source: string;
  periodLabel: string | null;
  preview: PreviewTx[];
  futureInstallments?: PreviewTx[];
  total: number;
  duplicated: number;
  totalAmountCents: number;
  inserted?: number;
  /** Estado da categorização automática em lote do preview (#582 PR-5). Não bloqueia. */
  classificationStatus?: ImportClassificationStatus;
}

export interface CommitResult {
  source: string;
  periodLabel: string;
  inserted: number;
  duplicated: number;
  /** Linhas ignoradas como duplicata (auditável — para o usuário conferir o que não entrou). */
  duplicatedItems?: DuplicatedImportItem[];
  settled: number;
  importId: string;
  linked?: number;
  skipped?: number;
}

/** Uma linha do arquivo que a importação ignorou por já existir (dedup). */
export interface DuplicatedImportItem {
  externalId: string;
  date: string;
  description: string;
  amountCents: number;
  reason: 'duplicate';
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
    installmentCurrent?: number | null;
    installmentTotal?: number | null;
  }>;
}
