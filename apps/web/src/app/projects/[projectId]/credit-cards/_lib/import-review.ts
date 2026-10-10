import {
  CARD_IMPORT_LINE_OUTCOME as OUTCOME,
  CARD_IMPORT_REVIEW_REASON as REASON,
  type CardImportLineOutcome,
  type CardImportLineResult,
  type CardImportReviewItem,
} from "@reformaflow/domain";

/** Desfechos que travam a linha: nada mais é enviado para ela. */
const FINAL_OUTCOMES: ReadonlySet<CardImportLineOutcome> = new Set([
  OUTCOME.CREATED,
  OUTCOME.REUSED,
  OUTCOME.DUPLICATED,
  OUTCOME.SKIPPED,
  OUTCOME.BLOCKED,
]);

export function isFinalOutcome(outcome: CardImportLineOutcome | undefined) {
  return !!outcome && FINAL_OUTCOMES.has(outcome);
}

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set(Object.values(OUTCOME));

/** Nunca chama pulo, bloqueio ou erro de "aplicado". */
export const OUTCOME_LABELS: Record<CardImportLineOutcome, string> = {
  CREATED: "Criada",
  REUSED: "Reaproveitada, sem pagamento",
  DUPLICATED: "Já existia · ignorada",
  SKIPPED: "Não importada",
  BLOCKED: "Bloqueada · não importada",
  REVIEW_REQUIRED: "Precisa da sua decisão",
  POSSIBLE_DUPLICATE: "Possível duplicata · não importada",
  ERROR: "Com erro · revise os dados ou tente novamente",
  NOT_SELECTED: "Não enviada · aguardando sua decisão",
};

export function isLineResultList(
  value: unknown,
): value is CardImportLineResult[] {
  return (
    Array.isArray(value) &&
    value.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        typeof r.externalId === "string" &&
        typeof r.outcome === "string" &&
        KNOWN_OUTCOMES.has(r.outcome) &&
        (r.linked === undefined || r.linked === true),
    )
  );
}

export function isBlockedReview(review: CardImportReviewItem | null | undefined) {
  return review?.reason === REASON.BLOCKED;
}

/** A escolha vale só para o fingerprint que o usuário viu; qualquer outro é rascunho velho. */
export function hasReviewConsent(
  review: CardImportReviewItem | null | undefined,
  decision: { action?: string; reviewFingerprint?: string } | undefined,
) {
  return (
    !!review &&
    !!review.fingerprint &&
    decision?.action === "import" &&
    decision.reviewFingerprint === review.fingerprint
  );
}

export interface AttemptLine {
  externalId: string;
  title: string;
  amountCents: number;
  outcome: CardImportLineOutcome;
  linked?: true;
}

/** Resumo de UMA tentativa; nunca somado com as outras (NOT_SELECTED/duplicadas reaparecem). */
export interface ImportAttempt {
  number: number;
  importId: string;
  periodLabel: string;
  inserted: number;
  settled: number;
  duplicated: number;
  skipped: number;
  linked: number;
  notSelected: number;
  lines: AttemptLine[];
}

export const SELECTED_ROWS_CHANGED_COPY =
  "O documento mudou desde a prévia e alguma linha escolhida não existe mais. Nada foi criado nesta tentativa. Gere uma nova prévia manualmente para continuar.";
