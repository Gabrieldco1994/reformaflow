import type { ExpenseScheduleV1 } from "./calculations/expense-schedule";
import { CARD_IMPORT_IGNORED_REASON } from "./types/card-import-review";
export const IMPORT_CARD_CYCLE_CONFIGURATION_REQUIRED =
  "CARD_CYCLE_CONFIGURATION_REQUIRED";
export const IMPORT_NO_ELIGIBLE_PURCHASES = "NO_ELIGIBLE_PURCHASES";
const MAX_CARD_CYCLE_DAY = 31;
export interface CardImportConfiguration {
  configured: boolean;
  reason: typeof IMPORT_CARD_CYCLE_CONFIGURATION_REQUIRED | null;
}
export function cardImportConfiguration(
  card: Readonly<{
    closingDay: number | null;
    dueDay: number | null;
  }>,
): CardImportConfiguration {
  const configured = [card.closingDay, card.dueDay].every(
    (day) =>
      day !== null &&
      Number.isInteger(day) &&
      day > 0 &&
      day <= MAX_CARD_CYCLE_DAY,
  );
  return {
    configured,
    reason: configured ? null : IMPORT_CARD_CYCLE_CONFIGURATION_REQUIRED,
  };
}
import type { ExpenseType, LaborCategory } from "./enums";

/** Wire v1 only. These types/constants are not runtime input validation or authorization. */
export const IMPORT_SESSION_PROTOCOL_VERSION = 1 as const;
export const IMPORT_SESSION_CONSENT_POLICY_VERSION = 1 as const;
export const IMPORT_SESSION_KIND = "CREATE_CARD_PURCHASES" as const;

export const IMPORT_SESSION_LIMITS = Object.freeze({
  filesPerRequest: 5,
  bytesPerFile: 10485760,
  filesPerSession: 10,
  bytesPerSession: 52428800,
  activeSessionsPerUser: 3,
  activeSessionsPerTenant: 20,
  storedAndReservedBytesPerTenant: 209715200,
  storedAndReservedBytesGlobal: 1073741824,
  concurrentUploadsPerTenant: 2,
  concurrentParsersPerTenant: 1,
  concurrentParsersGlobal: 2,
  uploadLeaseSeconds: 120,
  parserLeaseSeconds: 90,
  parserDeadlineSeconds: 60,
  confirmationNonceSeconds: 300,
  draftRetentionSeconds: 604800,
  pdfPagesPerFile: 30,
  pdfPagesPerSession: 60,
  imagePixels: 16000000,
  expandedArchiveBytes: 52428800,
  expandedArchiveEntries: 1000,
  parsedRowsPerFile: 1000,
  parsedRowsPerSession: 2000,
  editableLines: 100,
  selectedLines: 10,
  installmentsPerPurchase: 24,
  /** Wire-v1 compatibility bound; new mutations/preparations enforce the invariant below. */
  targetsPerPurchase: 4,
  expandedCFEsPerBatch: 240,
  financialAndCoordinationWritesPerBatch: 512,
  matchingRowsVisitedPerPreparation: 5000,
  jsonBytesPerDraftOrProposal: 1048576,
  transactionMaxWaitMs: 5000,
  transactionTimeoutMs: 20000,
  writeAttempts: 3,
  pageSize: 25,
  cursorSeconds: 900,
  reaperIntervalSeconds: 60,
  observationsPerLine: 20,
});

export const IMPORT_SESSION_PRIMITIVES = Object.freeze({
  idPattern: "^[A-Za-z0-9_-]{1,191}$",
  requestIdPattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  hashPattern: "^[0-9a-f]{64}$",
  dateOnlyPattern: "^\\d{4}-\\d{2}-\\d{2}$",
  instantPattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
  minRevision: 1,
  maxRevision: 2147483647,
  minCents: -2147483647,
  maxCents: 2147483647,
  minPurchaseCents: 1,
  minYear: 1900,
  maxYear: 2199,
  maxTitleLength: 160,
  maxSupplierLength: 160,
  maxFileNameLength: 255,
  maxQuestionLength: 500,
  maxReferenceLength: 192,
  maxObservationTextLength: 1000,
  maxAnswerLiteralLength: 4000,
});

export const ImportSessionState = {
  DRAFT: "DRAFT",
  ANALYZING: "ANALYZING",
  NEEDS_INPUT: "NEEDS_INPUT",
  READY: "READY",
  CONFIRMED: "CONFIRMED",
  APPLIED: "APPLIED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
} as const;
export type ImportSessionState =
  (typeof ImportSessionState)[keyof typeof ImportSessionState];
export const ImportSessionAmountMeaning = {
  TOTAL_PURCHASE: "TOTAL_PURCHASE",
  INSTALLMENT_CHARGE: "INSTALLMENT_CHARGE",
  UNKNOWN: "UNKNOWN",
} as const;
export type ImportSessionAmountMeaning =
  (typeof ImportSessionAmountMeaning)[keyof typeof ImportSessionAmountMeaning];
export const ImportSessionAttachmentState = {
  RESERVED: "RESERVED",
  UPLOADED: "UPLOADED",
  ATTACHED: "ATTACHED",
  FAILED: "FAILED",
  RELEASED: "RELEASED",
} as const;
export type ImportSessionAttachmentState =
  (typeof ImportSessionAttachmentState)[keyof typeof ImportSessionAttachmentState];
export const ImportSessionArtifactState = {
  RAW_READY: "RAW_READY",
  ANALYZING: "ANALYZING",
  EXTRACTED: "EXTRACTED",
  FAILED: "FAILED",
  PURGING: "PURGING",
  PURGED: "PURGED",
} as const;
export type ImportSessionArtifactState =
  (typeof ImportSessionArtifactState)[keyof typeof ImportSessionArtifactState];
export const ImportSessionDocumentFormat = {
  CSV: "CSV",
  OFX: "OFX",
  PDF: "PDF",
  XLS: "XLS",
  XLSX: "XLSX",
  PNG: "PNG",
  JPEG: "JPEG",
  WEBP: "WEBP",
} as const;
export type ImportSessionDocumentFormat =
  (typeof ImportSessionDocumentFormat)[keyof typeof ImportSessionDocumentFormat];
export const ImportSessionErrorCode = {
  INVALID_INPUT: "INVALID_INPUT",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  NOT_FOUND: "NOT_FOUND",
  UI_ACTION_REQUIRED: "UI_ACTION_REQUIRED",
  REVISION_CONFLICT: "REVISION_CONFLICT",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  STALE_PREVIEW: "STALE_PREVIEW",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  SEARCH_TOO_BROAD: "SEARCH_TOO_BROAD",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  UNSUPPORTED_DOCUMENT: "UNSUPPORTED_DOCUMENT",
  OCR_REQUIRED: "OCR_REQUIRED",
  OCR_UNAVAILABLE: "OCR_UNAVAILABLE",
  OCR_SAFETY_BLOCKED: "OCR_SAFETY_BLOCKED",
  OCR_MALFORMED_RESPONSE: "OCR_MALFORMED_RESPONSE",
  OCR_ATTEMPT_UNKNOWN: "OCR_ATTEMPT_UNKNOWN",
  OCR_BUDGET_EXHAUSTED: "OCR_BUDGET_EXHAUSTED",
  DOCUMENT_UNREADABLE: "DOCUMENT_UNREADABLE",
  PDF_PASSWORD_REQUIRED: "PDF_PASSWORD_REQUIRED",
  LEASE_CONFLICT: "LEASE_CONFLICT",
  RETRYABLE_WRITE_CONFLICT: "RETRYABLE_WRITE_CONFLICT",
  CAPABILITY_DISABLED: "CAPABILITY_DISABLED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  ALREADY_APPLIED: "ALREADY_APPLIED",
} as const;
export type ImportSessionErrorCode =
  (typeof ImportSessionErrorCode)[keyof typeof ImportSessionErrorCode];
export type ImportSessionOcrTerminalCodeV1 =
  | typeof ImportSessionErrorCode.OCR_UNAVAILABLE
  | typeof ImportSessionErrorCode.OCR_SAFETY_BLOCKED
  | typeof ImportSessionErrorCode.OCR_MALFORMED_RESPONSE
  | typeof ImportSessionErrorCode.OCR_ATTEMPT_UNKNOWN
  | typeof ImportSessionErrorCode.LIMIT_EXCEEDED
  | typeof ImportSessionErrorCode.DOCUMENT_UNREADABLE;

/** Existing parent CUIDs remain valid. Only NEW server IDs and request IDs require UUIDv4. */
export type ImportSessionId = string;
export type ImportSessionRequestId = string;
export type ImportSessionHash = string;
/** Gregorian date, 1900..2199; financial persistence uses the existing UTC/BRT policy. */
export type ImportSessionDateOnly = string;
export type ImportSessionInstant = string;
export type ImportSessionRevision = number;
export type ImportSessionCents = number;

export interface ImportSessionTargetInputV1 {
  projectId: ImportSessionId;
  roomId: ImportSessionId | null;
  amountCents: ImportSessionCents;
}
export const IMPORT_SESSION_NEW_INTEGRAL_TARGET_LIMIT = 1 as const;
/** New mutations/preparations allow no destination or one destination for the full purchase. */
export function isZeroOrOneIntegralImportTargetSet(
  targets: readonly Pick<ImportSessionTargetInputV1, "amountCents">[],
  totalCents: ImportSessionCents | null,
): boolean {
  return (
    targets.length <= IMPORT_SESSION_NEW_INTEGRAL_TARGET_LIMIT &&
    (targets.length === 0 ||
      (totalCents !== null && targets[0]?.amountCents === totalCents))
  );
}
export type ImportSessionDecisionV1 =
  | { kind: "UNRESOLVED" }
  | { kind: "CREATE"; acceptNaturalDuplicate: boolean }
  | { kind: "KEEP_EXISTING"; expenseId: ImportSessionId };

export interface ImportSessionDraftLineV1 {
  id: ImportSessionId;
  observationIds: ImportSessionId[];
  titulo: string;
  fornecedor: string | null;
  tipoDespesa: ExpenseType | null;
  categoriaMaoDeObra: LaborCategory | null;
  amountMeaning: ImportSessionAmountMeaning;
  amountCents: ImportSessionCents | null;
  installmentCount: number | null;
  dataCompra: ImportSessionDateOnly | null;
  firstDueDate: ImportSessionDateOnly | null;
  /** null = unresolved; [] = source without targets. */
  targets: ImportSessionTargetInputV1[] | null;
  decision: ImportSessionDecisionV1;
}
export interface ImportOcrReviewEvidenceV1 {
  origin: "GOOGLE_VERTEX_AI";
  model: "gemini-2.5-flash";
  modelVersion: string;
  region: "southamerica-east1";
  authTrace: "LOCAL_ADC" | "SERVICE_ACCOUNT_FILE_ADC";
  attachmentId: ImportSessionId;
  artifactFingerprint: ImportSessionHash;
  candidateFingerprint: ImportSessionHash;
  pageNumber: number;
  text: string;
}
export interface ImportSessionLineViewV1 extends ImportSessionDraftLineV1 {
  /** Present only for active OCR review; never stored in draftJson. */
  ocrEvidence?: ImportOcrReviewEvidenceV1;
}
export type ImportSessionDraftFieldV1 =
  | "amountMeaning"
  | "amountCents"
  | "installmentCount"
  | "dataCompra"
  | "firstDueDate"
  | "targets"
  | "decision"
  | "tipoDespesa"
  | "categoriaMaoDeObra";

export interface ImportSessionDraftQuestionV1 {
  id: ImportSessionId;
  lineIds: ImportSessionId[];
  field: ImportSessionDraftFieldV1;
  text: string;
}
export type ImportSessionQuestionV1 =
  | ImportSessionDraftQuestionV1
  | ImportObservationQuestionV1;

export type ImportHumanMeaningV1 = "TOTAL_PURCHASE" | "INSTALLMENT_CHARGE";
export type ImportHumanFactValuesV1 = {
  dataCompra: ImportSessionDateOnly;
  merchant: string;
  amountMeaning: ImportHumanMeaningV1;
  amountCents: ImportSessionCents;
  installmentCount: number;
  installmentIndex: number;
};
export type ImportHumanFactFieldV1 = keyof ImportHumanFactValuesV1;
/** Native guided controls attest documentary facts only, never draft/financial decisions. */
export interface ImportSessionFactDocumentaryAnswerRequestV1 {
  version: 1;
  answerRequestId: ImportSessionRequestId;
  expectedRevision: ImportSessionRevision;
  questionId: ImportSessionId;
  channel: ImportChatChannel;
  input: import("./import-declaration").ImportDeclarationUiInputV1;
  answer: ImportDeclarationAnswerV1;
}

export interface ImportSessionOcrConsentAnswerRequestV1 {
  version: 1;
  answerRequestId: ImportSessionRequestId;
  expectedRevision: ImportSessionRevision;
  questionId: ImportSessionId;
  channel: "TEXT";
  input: { kind: "VALUE"; text: "ALLOW_EXTERNAL_PROCESSING" };
  answer: {
    field: "externalOcrConsent";
    value: "ALLOW_EXTERNAL_PROCESSING";
    attachmentId: ImportSessionId;
    requestId: ImportSessionRequestId;
    consentPolicyVersion: 1;
    provider: "GOOGLE_VERTEX_AI";
    purpose: "DOCUMENT_LINE_TRANSCRIPTION_FOR_HUMAN_REVIEW";
    region: "southamerica-east1";
    retentionDays: 7;
    sendsFullOriginal: true;
    includesMetadataAndEmbeddedContent: true;
    includesPotentiallyNonVisibleContent: true;
  };
}
export type ImportSessionDocumentaryAnswerRequestV1 =
  | ImportSessionFactDocumentaryAnswerRequestV1
  | ImportSessionOcrConsentAnswerRequestV1;

export type ImportDeclarationAnswerV1 = {
  [F in ImportHumanFactFieldV1]: {
    field: F;
    value: ImportHumanFactValuesV1[F] | null;
    meaningContext: F extends "amountCents" ? ImportHumanMeaningV1 : null;
  };
}[ImportHumanFactFieldV1];

export type ImportObservationQuestionV1 = {
  [F in ImportHumanFactFieldV1]: {
    id: ImportSessionId;
    lineIds: [ImportSessionId];
    field: F;
    text: string;
    subject: {
      kind: "OBSERVATION";
      observationId: ImportSessionId;
      meaningContext: F extends "amountCents" ? ImportHumanMeaningV1 : null;
    };
    answerState: "UNANSWERED" | "DECLARED" | "UNKNOWN";
  };
}[ImportHumanFactFieldV1];

export type ImportStoredDeclarationV1 = ImportDeclarationAnswerV1 & {
  lineId: ImportSessionId;
  observationId: ImportSessionId;
  originalFingerprint: ImportSessionHash;
  claimVersion: number;
  originSessionId: ImportSessionId;
  recordedRevision: ImportSessionRevision;
  questionId: ImportSessionId;
  turnId: ImportSessionRequestId;
  attestedByUserId: ImportSessionId;
  attestedAt: ImportSessionInstant;
  literalHash: ImportSessionHash;
  /** Absent only on historical wire-v1 drafts recorded before channel provenance. */
  channel?: ImportChatChannel;
};

export type ImportDeclaredFactViewV1 = {
  lineId: ImportSessionId;
  observationId: ImportSessionId;
  questionId: ImportSessionId;
  origin: "USER_ATTESTATION";
  /** Absent only on historical declarations. */
  channel?: ImportChatChannel;
} & (
  | {
      [F in ImportHumanFactFieldV1]: {
        field: F;
        meaningContext: F extends "amountCents" ? ImportHumanMeaningV1 : null;
      } & (
        | { status: "CURRENT"; value: ImportHumanFactValuesV1[F] }
        | { status: "UNKNOWN"; value: null }
      );
    }[ImportHumanFactFieldV1]
  | {
      field: "amountCents";
      meaningContext: ImportHumanMeaningV1;
      status: "CONTEXT_CHANGED";
      value: ImportSessionCents;
    }
);

export type ImportReviewBlockerV1 = {
  lineId: ImportSessionId;
  code: "ORIGINAL_IDENTITY_INCOMPLETE" | "ORIGINAL_OCCURRENCE_INCOMPLETE";
  resolution:
    | "NEEDS_DECLARATION"
    | "RESOLVED_BY_USER"
    | "SEARCH_IDENTITY_UNAVAILABLE";
};

export interface ImportSessionCandidateV1 {
  lineId: ImportSessionId;
  kind: "EXPENSE" | "RECEIPT";
  id: ImportSessionId;
  projectId: ImportSessionId;
  description: string;
  amountCents: ImportSessionCents;
  date: ImportSessionDateOnly;
  reason: "STRONG_IDENTITY" | "NATURAL_MATCH" | "INSTALLMENT_MATCH";
  canKeepExisting: boolean;
}
export interface ImportSessionPlannedCreateV1 {
  kind: "CREATE";
  lineId: ImportSessionId;
  titulo: string;
  fornecedor: string | null;
  tipoDespesa: ExpenseType;
  categoriaMaoDeObra: LaborCategory | null;
  dataCompra: ImportSessionDateOnly;
  totalCents: ImportSessionCents;
  schedule: ExpenseScheduleV1;
  targets: Array<ImportSessionTargetInputV1 & { schedule: ExpenseScheduleV1 }>;
}
export interface ImportSessionPlannedKeepV1 {
  kind: "KEEP_EXISTING";
  lineId: ImportSessionId;
  sourceExpenseId: ImportSessionId;
  totalCents: ImportSessionCents;
  schedule: ExpenseScheduleV1;
}
export const IMPORT_SESSION_AUDIT_OUTCOME = {
  IGNORED: "IGNORED",
} as const;
export type ImportSessionAuditOutcome =
  (typeof IMPORT_SESSION_AUDIT_OUTCOME)[keyof typeof IMPORT_SESSION_AUDIT_OUTCOME];
export interface ImportSessionIgnoredAuditItemV1 {
  observationId: ImportSessionId;
  outcome: typeof IMPORT_SESSION_AUDIT_OUTCOME.IGNORED;
  reason: typeof CARD_IMPORT_IGNORED_REASON.INVOICE_PAYMENT;
  title: string;
  /** Documentary amount only; ignored observations never affect financial totals. */
  amountCents: ImportSessionCents | null;
}
export interface ImportSessionProposalV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  kind: typeof IMPORT_SESSION_KIND;
  sessionId: ImportSessionId;
  revision: ImportSessionRevision;
  proposalHash: ImportSessionHash;
  lines: Array<ImportSessionPlannedCreateV1 | ImportSessionPlannedKeepV1>;
  /** Terminal documentary outcomes, hash-bound but excluded from every financial effect. */
  auditItems: ImportSessionIgnoredAuditItemV1[];
  /** Selected-out observations that stay in the draft (AC18 continuation). */
  deferredObservationIds: ImportSessionId[];
  /**
   * Attachments still pending WITHOUT completed extraction. Required even when
   * `deferredObservationIds` is empty, so an unparsed attachment cannot vanish.
   */
  deferredAttachmentIds: ImportSessionId[];
  /** AC18: earliest instant the deferred references may be released; null when nothing is deferred. */
  retainUntil: ImportSessionInstant | null;
  createdEconomicTotalCents: ImportSessionCents;
  bankCashDeltaCents: 0;
  invoiceDeltas: Array<{
    invoiceDueMonth: string;
    amountCents: ImportSessionCents;
  }>;
}
export interface ImportSessionConfirmationRefV1 {
  financialRequestId: ImportSessionRequestId;
  confirmedRevision: ImportSessionRevision;
  proposalHash: ImportSessionHash;
}
/**
 * Immutable per-line snapshot approved at confirmation (B1b). KEEP_EXISTING lines carry
 * `titulo`/`dataCompra` null. `targets` is always an array (never null as partial redaction).
 */
export interface ImportSessionReceiptLineSnapshotV1 {
  lineId: ImportSessionId;
  titulo: string | null;
  dataCompra: ImportSessionDateOnly | null;
  totalCents: ImportSessionCents;
  schedule: ExpenseScheduleV1;
  sourceProjectId: ImportSessionId;
  targets: Array<{
    projectId: ImportSessionId;
    amountCents: ImportSessionCents;
  }>;
}
export interface ImportSessionReceiptSnapshotV1 {
  /** 1:1 with `items`, same order, coherent lineId/outcome. */
  lines: ImportSessionReceiptLineSnapshotV1[];
  /** Distinct, sorted union of the anchor project, line sources and targets. */
  participantProjectIds: ImportSessionId[];
  createdEconomicTotalCents: ImportSessionCents;
  bankCashDeltaCents: 0;
  invoiceDeltas: Array<{
    invoiceDueMonth: string;
    amountCents: ImportSessionCents;
  }>;
}
/** Applied batch receipt, NOT the existing financial Receipt (recebimento). */
export interface ImportSessionReceiptV1 extends ImportSessionConfirmationRefV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  sessionId: ImportSessionId;
  appliedAt: ImportSessionInstant;
  /**
   * Private successor session holding only the deferred scope, or null when
   * nothing was deferred. Always present; the receipt stays immutable while the
   * successor's own state is read separately.
   */
  continuationSessionId: ImportSessionId | null;
  /** Immutable copy of the proposal audit. Historical receipts parse this as an empty list. */
  auditItems?: ImportSessionIgnoredAuditItemV1[];
  items: Array<{
    lineId: ImportSessionId;
    outcome: "CREATED" | "KEPT_EXISTING";
    sourceExpenseId: ImportSessionId;
    targetExpenseIds: ImportSessionId[];
    allocationIds: ImportSessionId[];
    cashFlowEntryIds: ImportSessionId[];
  }>;
  /** Mandatory since B1b: the approved amounts/projects, never recomputed from current data. */
  snapshot: ImportSessionReceiptSnapshotV1;
}
export interface ImportSessionAttachmentViewV1 {
  id: ImportSessionId;
  fileName: string;
  declaredBytes: number;
  state: ImportSessionAttachmentState;
  materializedInSession: boolean;
  canAnalyze: boolean;
}
export interface ImportSessionDraftV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  lines: ImportSessionDraftLineV1[];
  selectedLineIds: ImportSessionId[];
  questions: ImportSessionDraftQuestionV1[];
}
/**
 * Server-owned scope of a draft. Never accepted from PATCH bodies or tool
 * arguments; every observation/candidate endpoint filters by it.
 */
export interface ImportSessionDraftScopeV1 {
  observationIds: ImportSessionId[];
  pendingAttachmentIds: ImportSessionId[];
}
/**
 * Private persisted draft JSON (`import_sessions.draft_json`). `scope` is always
 * present, including in the empty cleanup document. The public view/edit wire
 * shapes deliberately do NOT carry it.
 */
export interface ImportSessionStoredDraftV1 extends ImportSessionDraftV1 {
  scope: ImportSessionDraftScopeV1;
  declarations?: {
    version: 1;
    items: ImportStoredDeclarationV1[];
  };
}
export interface ImportSessionViewV1 extends Omit<
  ImportSessionDraftV1,
  "questions" | "lines"
> {
  lines: ImportSessionLineViewV1[];
  id: ImportSessionId;
  ownerProjectId: ImportSessionId;
  cardId: ImportSessionId;
  state: ImportSessionState;
  revision: ImportSessionRevision;
  /** Terminal states project null; the SQL historical deadline remains NOT NULL. */
  expiresAt: ImportSessionInstant | null;
  attachments: ImportSessionAttachmentViewV1[];
  questions: ImportSessionQuestionV1[];
  declaredFacts: ImportDeclaredFactViewV1[];
  reviewBlockers: ImportReviewBlockerV1[];
  /** Server always projects this field; optional until older clients migrate their strict reader. */
  ocrCapability?: {
    status: "DISABLED" | "UNAVAILABLE" | "AVAILABLE";
    consentPolicyVersion: 1;
    provider: "GOOGLE_VERTEX_AI";
    purpose: "DOCUMENT_LINE_TRANSCRIPTION_FOR_HUMAN_REVIEW";
    region: "southamerica-east1";
    retentionDays: 7;
    sendsFullOriginal: true;
    includesMetadataAndEmbeddedContent: true;
    includesPotentiallyNonVisibleContent: true;
    attachments: Array<{
      attachmentId: ImportSessionId;
      questionId: ImportSessionId;
      consentedRequestId: ImportSessionRequestId | null;
      consentedRevision: ImportSessionRevision | null;
    }>;
    /** Opt-in GET projection; absent from legacy and mutation response shapes. */
    terminalOutcomes?: Array<{
      attachmentId: ImportSessionId;
      code: ImportSessionOcrTerminalCodeV1;
    }>;
  };
  searchComplete: boolean;
  /** Completed analysis produced no eligible purchase lines (e.g. only invoice payments). */
  analysisOutcome?: typeof IMPORT_NO_ELIGIBLE_PURCHASES | null;
  proposal: ImportSessionProposalV1 | null;
  confirmation: ImportSessionConfirmationRefV1 | null;
  receipt: ImportSessionReceiptV1 | null;
  actions: Array<
    | "UPLOAD"
    | "ANALYZE"
    | "RESOLVE"
    | "PREPARE"
    | "CONFIRM"
    | "EXECUTE"
    | "CANCEL"
    | "READ_RESULT"
  >;
}
/** Explicit upload-only result when identical bytes already exist in this session. */
export interface ImportSessionDuplicateUploadV1 {
  kind: "DEDUPLICATED";
  attachmentId: ImportSessionId;
  view: ImportSessionViewV1;
}
export type ImportSessionUploadResponseV1 =
  | ImportSessionViewV1
  | ImportSessionDuplicateUploadV1;
/** Recovery-list row (B1b): columns only, no OCR, evidence, file names or private hashes. */
export interface ImportSessionSummaryV1 {
  id: ImportSessionId;
  state: ImportSessionState;
  /** Lets the UI cancel with CAS from the list; it is not a confirmation. */
  revision: ImportSessionRevision;
  cardId: ImportSessionId;
  ownerProjectId: ImportSessionId;
  createdAt: ImportSessionInstant;
  /** Terminal states project null. */
  expiresAt: ImportSessionInstant | null;
  appliedAt: ImportSessionInstant | null;
  attachmentCount: number;
  hasConfirmation: boolean;
  /** APPLIED only, taken from a validated receipt. */
  continuationSessionId: ImportSessionId | null;
  actions: ImportSessionViewV1["actions"];
}
export interface ImportSessionObservationViewV1 {
  /** Absent on historical projections; null means this is not a policy ignore. */
  ignoredReason?: "INVOICE_PAYMENT" | null;
  id: ImportSessionId;
  attachmentId: ImportSessionId;
  reference: string;
  text: string;
  amountMeaning: ImportSessionAmountMeaning;
  amountCents: ImportSessionCents | null;
  installmentCount: number | null;
  /** Printed index, not the local index in ExpenseScheduleV1. */
  installmentIndex: number | null;
  dataCompra: ImportSessionDateOnly | null;
}
export const IMPORT_CHAT_CHANNEL = {
  TEXT: "TEXT",
  VOICE: "VOICE",
} as const;
export type ImportChatChannel =
  (typeof IMPORT_CHAT_CHANNEL)[keyof typeof IMPORT_CHAT_CHANNEL];
export const IMPORT_ENTRY_ACTION_KIND = {
  START_CARD_INVOICE_IMPORT: "START_CARD_INVOICE_IMPORT",
  UNAVAILABLE: "IMPORT_UNAVAILABLE",
} as const;

/** Request-first entry hint only; channel is provenance, never a grant. */
export type ImportEntryActionV1 =
  | {
      version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
      kind: typeof IMPORT_ENTRY_ACTION_KIND.START_CARD_INVOICE_IMPORT;
      originChannel: ImportChatChannel;
      formats: Array<
        | typeof ImportSessionDocumentFormat.CSV
        | typeof ImportSessionDocumentFormat.PDF
      >;
      suggestedCardId: string | null;
    }
  | {
      version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
      kind: typeof IMPORT_ENTRY_ACTION_KIND.UNAVAILABLE;
      originChannel: ImportChatChannel;
    };
export interface ImportSessionPageV1<T> {
  items: T[];
  nextCursor: string | null;
}
/** Pre-session availability, not content validation or authority to write. */
export type ImportSessionEntryV1 =
  | { kind: "UNAVAILABLE" }
  | {
      kind: "CARD_INVOICE";
      /** Nonempty, distinct formats qualified for the complete RAW chain. */
      formats: Array<"CSV" | "OFX" | "PDF" | "XLS" | "XLSX">;
    };
export interface ImportSessionListV1 extends ImportSessionPageV1<ImportSessionSummaryV1> {
  entry: ImportSessionEntryV1;
}
export interface ImportSessionCreateRequestV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  createRequestId: ImportSessionRequestId;
  cardId: ImportSessionId;
  consentPolicyVersion: typeof IMPORT_SESSION_CONSENT_POLICY_VERSION;
  /** This boolean carries no UI authority. The service also requires an internal grant. */
  consentAnalyze: true;
}
export interface ImportSessionRevisionRequestV1 {
  expectedRevision: ImportSessionRevision;
}
export interface ImportSessionReserveRequestV1 extends ImportSessionRevisionRequestV1 {
  files: Array<{
    id: ImportSessionId;
    fileName: string;
    declaredBytes: number;
    mime: string;
  }>;
}
export interface ImportSessionEditRequestV1 extends ImportSessionRevisionRequestV1 {
  questionId: ImportSessionId | null;
  replaceLines: ImportSessionDraftLineV1[];
  selectedLineIds: ImportSessionId[];
}
type ImportSessionFocusedLiteralAnswerV1 =
  | {
      field: "amountMeaning";
      literal: string;
      value:
        | typeof ImportSessionAmountMeaning.TOTAL_PURCHASE
        | typeof ImportSessionAmountMeaning.INSTALLMENT_CHARGE;
    }
  | { field: "amountCents"; literal: string; value: ImportSessionCents }
  | { field: "installmentCount"; literal: string; value: number }
  | {
      field: "dataCompra" | "firstDueDate";
      literal: string;
      value: ImportSessionDateOnly;
    };
export type ImportSessionFocusedTargetAnswerV1 =
  | { kind: "NO_TARGETS" }
  | ({ kind: "TARGET"; literal: string } & ImportSessionTargetInputV1);
/** Explicit UI draft choices, not documentary attestations or financial consent. */
export type ImportSessionFocusedDraftAnswerV1 =
  | ImportSessionFocusedLiteralAnswerV1
  | { field: "tipoDespesa"; value: ExpenseType }
  | { field: "categoriaMaoDeObra"; value: LaborCategory }
  | {
      field: "decision";
      value:
        | Extract<ImportSessionDecisionV1, { kind: "CREATE" }>
        | Extract<ImportSessionDecisionV1, { kind: "KEEP_EXISTING" }>;
    }
  | { field: "targets"; value: ImportSessionFocusedTargetAnswerV1 };
export interface ImportSessionFocusedDraftAnswerRequestV1 extends ImportSessionRevisionRequestV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  answerRequestId: ImportSessionRequestId;
  questionId: ImportSessionId;
  channel: ImportChatChannel;
  answer: ImportSessionFocusedDraftAnswerV1;
}
export interface ImportSessionChallengeRequestV1 extends ImportSessionRevisionRequestV1 {
  proposalHash: ImportSessionHash;
}
export interface ImportSessionChallengeResponseV1 {
  nonce: string;
  expiresAt: ImportSessionInstant;
}
export interface ImportSessionConfirmRequestV1 extends ImportSessionChallengeRequestV1 {
  financialRequestId: ImportSessionRequestId;
  /** null only for a reauthorized replay of the identical persisted confirmation tuple. */
  nonce: string | null;
}
export interface ImportSessionConfirmResponseV1 {
  sessionId: ImportSessionId;
  financialRequestId: ImportSessionRequestId;
  state: "CONFIRMED" | "APPLIED" | "REVIEW_REQUIRED" | "CANCELLED" | "EXPIRED";
}
export interface ImportSessionExecuteRequestV1 {
  financialRequestId: ImportSessionRequestId;
}
export interface ImportSessionResultV1 {
  state: ImportSessionState;
  receipt: ImportSessionReceiptV1 | null;
}
export interface ImportSessionErrorV1 {
  code: ImportSessionErrorCode;
  retryable: boolean;
  sessionId: ImportSessionId | null;
  currentRevision: ImportSessionRevision | null;
  /** AC18: refines an existing code (no new code); null whenever it does not apply. */
  reason:
    | "ATTACHMENT_IN_FLIGHT"
    | "WRITE_BUDGET_EXCEEDED"
    | typeof IMPORT_CARD_CYCLE_CONFIGURATION_REQUIRED
    | null;
}
