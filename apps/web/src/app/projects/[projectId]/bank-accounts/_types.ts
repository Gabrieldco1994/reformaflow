export interface BankAccountRow {
  id: string;
  institution: string;
  nickname: string | null;
  last4: string;
  agency: string | null;
  accountNumber: string | null;
  openingBalanceCents?: number;
  openingBalanceDate?: string | null;
  balanceCents?: number;
}

export interface BankCrossExpenseMatch {
  kind: 'expense';
  expenseId: string;
  projectId: string;
  projectName: string;
  projectType: string;
  titulo: string | null;
  valorCents: number;
  data: string;
  deltaCents: number;
  installmentCurrent?: number | null;
  installmentTotal?: number | null;
}

export interface BankCrossReceiptMatch {
  kind: 'receipt';
  receiptId: string;
  projectId: string;
  projectName: string;
  projectType: string;
  titulo: string | null;
  valorCents: number;
  data: string;
  deltaCents: number;
}

export type BankCrossProjectMatch = BankCrossExpenseMatch | BankCrossReceiptMatch;

export interface BankCardCandidate {
  cardLast4: string;
  nickname: string;
  /** Mês de vencimento da fatura, "YYYY-MM". */
  dueMonth: string;
  invoiceTotalCents: number;
  /** invoiceTotal − pagamento. Negativo = pagamento maior que a fatura. */
  deltaCents: number;
}

export interface BankPreviewTx {
  externalId: string;
  date: string;
  merchant: string;
  amountCents: number;
  category: string | null;
  duplicate: boolean;
  isCredit?: boolean;
  isCardPayment?: boolean;
  suggestedCategory?: string;
  /** Faturas em aberto que este pagamento pode estar quitando (mais provável primeiro). */
  cardCandidates?: BankCardCandidate[];
  /** Cartão detectado sem ambiguidade, quando houve. */
  suggestedCardLast4?: string | null;
  crossProjectMatches?: BankCrossProjectMatch[];
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
  /** Sinal de que o arquivo parece uma fatura de cartão, não um extrato (Bug A). Não bloqueia. */
  warning?: { code: 'looks_like_card_invoice'; message: string };
}

export interface BankCommitResult {
  importId: string;
  source: string;
  periodLabel: string;
  inserted: number;
  duplicated: number;
  /** Linhas ignoradas como duplicata (auditável — para o usuário conferir o que não entrou). */
  duplicatedItems?: DuplicatedImportItem[];
  /** Linhas com data+descrição que o parser não reconheceu como lançamento (nem saldo). */
  unparsedItems?: UnparsedImportItem[];
  /** Linhas que falharam ao inserir no meio do commit (erro de dependência/DB). */
  failedItems?: FailedImportItem[];
  receiptsInserted: number;
  cardPayments: number;
  /** Pagamentos de fatura que entraram SEM cartão identificado (saem do caixa, não quitam fatura). */
  unlinkedCardPayments?: number;
  aiReclassified: number;
  recurrencesCreated: number;
  skipped: number;
}

/** Uma linha do arquivo que a importação ignorou por já existir (dedup). */
export interface DuplicatedImportItem {
  externalId: string;
  date: string;
  description: string;
  amountCents: number;
  reason: 'duplicate';
}

/** Uma linha com data+descrição que o parser não conseguiu transformar em lançamento. */
export interface UnparsedImportItem {
  rowIndex: number;
  date: string;
  description: string;
  reason: 'no-amount' | 'unreadable';
}

/** Uma linha que falhou ao ser inserida (erro no meio do commit). */
export interface FailedImportItem {
  date: string;
  description: string;
  amountCents: number;
  reason: 'error';
  message: string;
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
    installmentCurrent?: number | null;
    installmentTotal?: number | null;
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
