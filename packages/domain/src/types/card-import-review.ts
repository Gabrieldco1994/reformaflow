/**
 * Explicit REVIEW contract for card statement imports (P01).
 *
 * A new installment line that shares merchant, card and full installment count
 * with a live purchase of a DIFFERENT per-installment amount is neither a
 * duplicate nor proven independent. The server asks for a human decision
 * instead of silently skipping it. The candidate list is public-safe: same
 * project only, no cash flow, no hidden participants, no tenant data.
 */
export const CARD_IMPORT_REVIEW_REASON = {
  /** A human choice is needed; `fingerprint` binds that choice to what was reviewed. */
  REQUIRED: "REVIEW_REQUIRED",
  /** The reviewed state changed (or vanished) before the decision was applied. */
  STALE: "REVIEW_STALE",
  /** Identity is protected or ineligible; no override exists. */
  BLOCKED: "BLOCKED_IDENTITY",
} as const;

export type CardImportReviewReason =
  (typeof CARD_IMPORT_REVIEW_REASON)[keyof typeof CARD_IMPORT_REVIEW_REASON];

/** Error code for a malformed decisions payload (HTTP 400, before any import record). */
export const CARD_IMPORT_INVALID_DECISION = "INVALID_DECISION";

const REVIEW_FINGERPRINT = /^[0-9a-f]{64}$/;

/** True only for a lowercase sha256 hex digest; `null`, numbers and short strings are not fingerprints. */
export function isCardImportReviewFingerprint(value: unknown): value is string {
  return typeof value === "string" && REVIEW_FINGERPRINT.test(value);
}

export interface CardImportReviewCandidate {
  expenseId: string;
  titulo: string | null;
  installmentCount: number;
  seriesAmountCents: number;
  /** `YYYY-MM-DD`, or `null` when the purchase has no competence date. */
  dataCompra: string | null;
}

export interface CardImportReviewItem {
  externalId: string;
  reason: CardImportReviewReason;
  /** `null` when there is nothing to confirm (BLOCKED, or STALE because the family vanished). */
  fingerprint: string | null;
  candidates: CardImportReviewCandidate[];
}

/** A line the import did not create and no decision can override. */
export interface CardImportSkippedItem {
  externalId: string;
  reason: typeof CARD_IMPORT_REVIEW_REASON.BLOCKED;
}

/** Preview line addition. `willImport` is false while a REVIEW/BLOCKED review is attached. */
export interface CardImportPreviewReview {
  review: CardImportReviewItem | null;
}

/**
 * Why a preview line is presented as not-a-purchase. Presentation/selection
 * signal only: it is NOT a promise of the outcome a legacy commit returns.
 */
export const CARD_IMPORT_IGNORED_REASON = {
  /** The line pays the invoice itself (e.g. "PAGAMENTO EFETUADO"); the import never creates it. */
  INVOICE_PAYMENT: "INVOICE_PAYMENT",
} as const;

export type CardImportIgnoredReason =
  (typeof CARD_IMPORT_IGNORED_REASON)[keyof typeof CARD_IMPORT_IGNORED_REASON];

/**
 * Preview line addition. `null` for ordinary lines and for strong duplicates
 * (`duplicate: true` wins). Independent of the Tier B `possibleDuplicate`
 * metadata, which is preserved. `willImport` is false while it is set.
 */
export interface CardImportPreviewIgnored {
  ignored: CardImportIgnoredReason | null;
}

/**
 * Commit result addition. Response counters satisfy
 * `total = inserted + settled + duplicated + skipped + possibleDuplicates.length + reviewRequired.length + notSelected`;
 * `settled` is an existing purchase reused WITHOUT any payment. `notSelected`
 * is 0 whenever the request carried no `selectedExternalIds`.
 */
export interface CardImportCommitReview {
  reviewRequired: CardImportReviewItem[];
  skippedItems: CardImportSkippedItem[];
  /**
   * Parsed lines outside `selectedExternalIds`: no dedupe, reuse, link, stamp or
   * creation happened. Persisted inside the record's `skipped` and named in its
   * `message`; always 0 in legacy mode.
   */
  notSelected: number;
  /** Always present, also in legacy mode. `skipped` = SKIPPED + BLOCKED + ERROR. */
  lineResults: CardImportLineResult[];
}

/** Decision addition: only meaningful with `action: 'import'`. */
export interface CardImportReviewDecision {
  reviewFingerprint?: string;
}

/**
 * Attempt selection (multipart field `selectedExternalIds`, JSON string, commit
 * mode only; preview ignores it). The client sends the set of `externalId`s the
 * user explicitly confirmed, including on the first round; on a retry only the
 * pending lines (REVIEW_REQUIRED, POSSIBLE_DUPLICATE, ERROR). Absent keeps the
 * legacy behavior of processing every parsed line. The server adds no size cap
 * of its own: it validates structure (array, at least one entry, every entry a
 * non-empty string, no repeats) and membership in the parsed lines, both before
 * any import record exists. Only the HTTP envelope limits it (1 MiB text field,
 * 5 files of 10 MiB).
 */
export interface CardImportSelection {
  selectedExternalIds?: string[];
}

/** HTTP 400: `selectedExternalIds` is not a non-empty array of unique, non-empty strings. */
export const CARD_IMPORT_INVALID_SELECTION = "INVALID_SELECTION";

/**
 * HTTP 409, zero effects: a selected id is not among the lines parsed from this
 * document. The UI asks for a new manual preview and never re-extracts alone.
 */
export const CARD_IMPORT_SELECTED_ROWS_CHANGED = "SELECTED_ROWS_CHANGED";

/** Body of the 409. `missingExternalIds` echoes only ids the client sent, at most the first 50. */
export interface CardImportSelectedRowsChanged {
  code: typeof CARD_IMPORT_SELECTED_ROWS_CHANGED;
  missingCount: number;
  missingExternalIds: string[];
}

/**
 * Per-line outcome of a commit.
 * - Final (the UI locks them): CREATED, REUSED, DUPLICATED, SKIPPED, BLOCKED.
 * - Pending (retryable): REVIEW_REQUIRED, POSSIBLE_DUPLICATE, ERROR.
 * - NOT_SELECTED leaves the round: nothing was deduped, reused, linked, stamped
 *   or created for it.
 * `REUSED` is an existing purchase reused WITHOUT payment. `SKIPPED` is a
 * terminal, never-retried ignore: the user's skip decision, or a deterministic
 * policy ignore such as an invoice-payment line (not a purchase). A failed row
 * (write failure or invalid data) is `ERROR`, never `SKIPPED`.
 */
export const CARD_IMPORT_LINE_OUTCOME = {
  CREATED: "CREATED",
  REUSED: "REUSED",
  DUPLICATED: "DUPLICATED",
  SKIPPED: "SKIPPED",
  BLOCKED: "BLOCKED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  POSSIBLE_DUPLICATE: "POSSIBLE_DUPLICATE",
  ERROR: "ERROR",
  NOT_SELECTED: "NOT_SELECTED",
} as const;

export type CardImportLineOutcome =
  (typeof CARD_IMPORT_LINE_OUTCOME)[keyof typeof CARD_IMPORT_LINE_OUTCOME];

/**
 * One entry per parsed line, in parse order (`lineResults.length === total`),
 * emitted in legacy mode too. Exactly these keys: no hidden-project or
 * participant data.
 */
export interface CardImportLineResult {
  externalId: string;
  outcome: CardImportLineOutcome;
  /** Attribute of a CREATED or REUSED line whose link ran, never an outcome. Absent otherwise, never `false`. */
  linked?: true;
}
