/**
 * Contrato de resposta do endpoint GET /projects/:projectId/expenses/paid-origins.
 *
 * Deriva, para cada despesa PLANEJADA/PAGA do projeto (o ALVO), quem de fato
 * pagou — a fonte cross-project (PESSOAL/CASA/...) que a liquidou via
 * settlement por parcela, rateio, ou vínculo simples reverso. Read-only:
 * NUNCA escreve no alvo (O1). Ver docs/quitacao-parcela-cross-project.md.
 */
export type PaidOriginKind = 'card' | 'bank';

export interface PaidOriginRef {
  kind: PaidOriginKind;
  /** Últimos 4 do cartão/conta. Nunca vazio quando o ref é emitido. */
  last4: string;
  /** Apelido do CreditCard/BankAccount; null quando não resolvido (UI cai no fallback ••last4). */
  nickname: string | null;
  /** brand (cartão) ou institution (conta). Para ícone/fallback. */
  institution: string | null;
  sourceProjectId: string;
  sourceProjectName: string;
}

export interface ExpensePaidOrigin {
  expenseId: string;
  via: 'settlement' | 'rateio' | 'link';
  /** Só para via='settlement'. parcelaIndex é 0-based. Ordenado asc. */
  parcelas: Array<{ parcelaIndex: number; origin: PaidOriginRef }>;
  /** Conjunto DISTINTO (kind:last4). Nunca vazio. */
  origins: PaidOriginRef[];
  /** origins.length > 1 — calculado APÓS a redação. */
  multiple: boolean;
}

export interface PaidOriginsResponse {
  items: ExpensePaidOrigin[];
}

/** Viewer resolvido — já normalizado pelo service (scope de projeto pré-calculado). */
export interface PaidOriginsViewer {
  role: string | undefined;
  allowedModules: string[];
  /** null = sem restrição (ADMIN/OWNER ou allowedProjects vazio). Nunca []. */
  projectScope: string[] | null;
}

/** Linha crua de CrossProjectSettlement relevante ao alvo do projeto. */
export interface PaidOriginSettlementRow {
  targetExpenseId: string;
  sourceExpenseId: string;
  parcelaIndex: number;
}

/** Linha crua de RateioAllocation relevante ao alvo do projeto. */
export interface PaidOriginRateioRow {
  targetExpenseId: string;
  sourceExpenseId: string;
}

/** Vínculo simples reverso (Expense.linkedExpenseId apontando para o alvo). */
export interface PaidOriginLinkRow {
  targetExpenseId: string;
  sourceExpenseId: string;
}

/** Fonte re-lida ATIVA (deletedAt: null) — carrega os dados de pagamento. */
export interface PaidOriginSourceRow {
  id: string;
  projectId: string;
  projectName: string;
  projectType: string;
  cardLast4: string | null;
  bankLast4: string | null;
  accountId: string | null;
}

export interface PaidOriginCardRow {
  id: string;
  projectId: string;
  last4: string;
  nickname: string | null;
  brand: string | null;
  createdAt: Date;
}

export interface PaidOriginAccountRow {
  id: string;
  projectId: string;
  last4: string;
  nickname: string | null;
  institution: string | null;
  createdAt: Date;
}

export interface BuildPaidOriginsInput {
  settlements: PaidOriginSettlementRow[];
  rateios: PaidOriginRateioRow[];
  links: PaidOriginLinkRow[];
  sources: PaidOriginSourceRow[];
  cards: PaidOriginCardRow[];
  accounts: PaidOriginAccountRow[];
  viewer: PaidOriginsViewer;
}
