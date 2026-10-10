import type { ExpenseScheduleV1 } from "./calculations/expense-schedule";
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
  csvColumnsPerFile: 64,
  csvFieldBytes: 1000,
  editableLines: 100,
  selectedLines: 10,
  installmentsPerPurchase: 24,
  targetsPerPurchase: 1,
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
  documentaryCommandReceipts: 64,
  interpretationReceipts: 32,
  interpretationLeaseSeconds: 120,
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
  LEASE_CONFLICT: "LEASE_CONFLICT",
  RETRYABLE_WRITE_CONFLICT: "RETRYABLE_WRITE_CONFLICT",
  CAPABILITY_DISABLED: "CAPABILITY_DISABLED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  MODEL_OUTPUT_INVALID: "MODEL_OUTPUT_INVALID",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  ALREADY_APPLIED: "ALREADY_APPLIED",
} as const;
export type ImportSessionErrorCode =
  (typeof ImportSessionErrorCode)[keyof typeof ImportSessionErrorCode];

/** Existing parent CUIDs remain valid. Only NEW server IDs and request IDs require UUIDv4. */
export type ImportSessionId = string;
export type ImportSessionRequestId = string;
export type ImportSessionHash = string;
/** Public digest of the exact human-visible confirmation surface. */
export type ImportSessionConfirmationHash = string;
/** Private digest of the complete executable plan. Never serialize publicly. */
export type ImportSessionFullPlanDigest = string;
/** Gregorian date, 1900..2199; financial persistence uses the existing UTC/BRT policy. */
export type ImportSessionDateOnly = string;
export type ImportSessionInstant = string;
export type ImportSessionRevision = number;
export type ImportSessionCents = number;

export type ImportTypedGuidedAnswerV1 =
  | { kind: "KNOWN"; value: string | number }
  | { kind: "UNKNOWN" }
  | { kind: "REMOVE" };

export interface ImportSessionTargetInputV1 {
  projectId: ImportSessionId;
  roomId: ImportSessionId | null;
  amountCents: ImportSessionCents;
}
export type ImportSessionDecisionV1 =
  | { kind: "UNRESOLVED" }
  | { kind: "CREATE"; acceptNaturalDuplicate: boolean }
  | { kind: "KEEP_EXISTING"; expenseId: ImportSessionId }
  | { kind: "DEFER" }
  | { kind: "EXCLUDE" }
  | {
      kind: "IGNORED_POLICY";
      reason: "INVOICE_PAYMENT" | "CARD_PAYS_CARD";
      policyVersion: 1;
    };

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
};

export type ImportDeclaredFactViewV1 = {
  lineId: ImportSessionId;
  observationId: ImportSessionId;
  questionId: ImportSessionId;
  origin: "USER_ATTESTATION";
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
export interface ImportSessionNoWriteRowV1 {
  lineId: ImportSessionId;
  outcome: "DEFERRED" | "EXCLUDED" | "IGNORED";
  reason:
    | "USER_DEFERRED"
    | "USER_EXCLUDED"
    | "INVOICE_PAYMENT"
    | "CARD_PAYS_CARD";
  title: string;
  amountCents: ImportSessionCents | null;
}
export interface ImportSessionEffectsV1 {
  personalSourceCreates: number;
  reformaTargetCreates: number;
  expenseCreates: number;
  cashFlowEntryCreates: number;
  rateioAllocationCreates: number;
  keptExistingCount: number;
  deferredCount: number;
  excludedCount: number;
  ignoredCount: number;
}
export interface ImportSessionProposalV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  kind: typeof IMPORT_SESSION_KIND;
  sessionId: ImportSessionId;
  revision: ImportSessionRevision;
  /** Private persisted full-plan digest; legacy JSON key retained for compatibility. */
  proposalHash: ImportSessionFullPlanDigest;
  lines: Array<ImportSessionPlannedCreateV1 | ImportSessionPlannedKeepV1>;
  noWriteRows?: ImportSessionNoWriteRowV1[];
  effects?: ImportSessionEffectsV1;
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
/** Public proposal projection; private executable-plan digest is never serialized. */
export type ImportSessionPublicProposalV1 = Omit<
  ImportSessionProposalV1,
  "proposalHash"
>;
export interface ImportSessionConfirmationRefV1 {
  financialRequestId: ImportSessionRequestId;
  confirmedRevision: ImportSessionRevision;
  bindingVersion: 0 | 1;
  confirmationHash: ImportSessionConfirmationHash | null;
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
  items: Array<{
    lineId: ImportSessionId;
    outcome: "CREATED" | "KEPT_EXISTING";
    sourceExpenseId: ImportSessionId;
    targetExpenseIds: ImportSessionId[];
    allocationIds: ImportSessionId[];
    cashFlowEntryIds: ImportSessionId[];
  }>;
  auditItems?: ImportSessionNoWriteRowV1[];
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
export interface ImportSessionStoredDraftV1 extends Omit<
  ImportSessionDraftV1,
  "questions"
> {
  /**
   * Preparation may persist unresolved documentary questions so their
   * observation identity and answer state survive recalculation.
   */
  questions: ImportSessionQuestionV1[];
  scope: ImportSessionDraftScopeV1;
  /**
   * Private, server-written evidence for guided draft fields. Absence means
   * unknown legacy origin; readers must never infer FILE or USER from a value.
   */
  fieldProvenance?: ImportSessionDraftFieldProvenanceV1[];
  declarations?: {
    version: 1;
    items: ImportStoredDeclarationV1[];
  };
  commandLedger?: ImportDocumentaryCommandLedgerV1;
  interpretationLedger?: ImportInterpretationLedgerV1;
}

export type ImportSessionDraftFieldOriginV1 = "FILE" | "USER" | "AI_CONFIRMED";
export interface ImportSessionDraftFieldProvenanceV1 {
  origin: ImportSessionDraftFieldOriginV1;
  lineId: ImportSessionId;
  field: ImportSessionDraftFieldV1;
  recordedRevision: ImportSessionRevision;
  interpretationRequestId?: ImportSessionRequestId;
}

export type ImportDocumentaryOperationV1 =
  | "DECLARE"
  | "RESOLVE"
  | "DEFER"
  | "REACTIVATE"
  | "CONTINUE_ANSWERING"
  | "PREPARE_CURRENT_LOT";
export type ImportDocumentaryCommandOutcomeV1 =
  | "APPLIED"
  | "NO_CHANGE"
  | "NEEDS_INPUT"
  | "CURRENT_LOT_READY";
export interface ImportDocumentaryCommandReceiptV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  requestId: ImportSessionRequestId;
  operation: ImportDocumentaryOperationV1;
  outcome: ImportDocumentaryCommandOutcomeV1;
  revision: ImportSessionRevision;
}
export interface ImportDocumentaryCommandRecordV1 {
  requestId: ImportSessionRequestId;
  operation: ImportDocumentaryOperationV1;
  payloadHash: ImportSessionHash;
  expectedRevision: ImportSessionRevision;
  result: ImportDocumentaryCommandReceiptV1;
  actorUserId: ImportSessionId;
  recordedAt: ImportSessionInstant;
}
export interface ImportDocumentaryCommandLedgerV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  items: ImportDocumentaryCommandRecordV1[];
}
export interface ImportInterpretationResultV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  requestId: ImportSessionRequestId;
  outcome: "CANDIDATE" | "CLARIFY";
  candidate?: ImportTypedGuidedAnswerV1;
}
export type ImportInterpretationFailureCodeV1 =
  | typeof ImportSessionErrorCode.PROVIDER_UNAVAILABLE
  | typeof ImportSessionErrorCode.MODEL_OUTPUT_INVALID;
type ImportInterpretationRecordBaseV1 = {
  requestId: ImportSessionRequestId;
  payloadHash: ImportSessionHash;
  expectedRevision: ImportSessionRevision;
  recordedAt: ImportSessionInstant;
};
export type ImportInterpretationRecordV1 = ImportInterpretationRecordBaseV1 &
  (
    | {
        status: "PENDING";
        result?: never;
        failureCode?: never;
      }
    | {
        status: "COMPLETE";
        result: ImportInterpretationResultV1;
        failureCode?: never;
      }
    | {
        status: "FAILED";
        result?: never;
        failureCode: ImportInterpretationFailureCodeV1;
      }
  );
export interface ImportInterpretationLedgerV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  items: ImportInterpretationRecordV1[];
}
export interface ImportSessionViewV1 extends Omit<
  ImportSessionDraftV1,
  "questions"
> {
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
  searchComplete: boolean;
  proposal: ImportSessionPublicProposalV1 | null;
  confirmation: ImportSessionConfirmationRefV1 | null;
  receipt: ImportSessionReceiptV1 | null;
  guidedReview?: ImportSessionGuidedReviewV1 | null;
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

export type ImportSessionGuidedControlV1 =
  | "DECISION"
  | "TARGETS"
  | "EXPENSE_TYPE"
  | "LABOR_CATEGORY";
export type ImportSessionGuidedProgressV1 =
  | "ANSWERING"
  | "READY"
  | "READY_WITH_PENDING";
export interface ImportSessionGuidedAnswerByControlV1 {
  DECISION: Extract<ImportTypedDraftAnswerV1, { kind: "DECISION" }>;
  TARGETS: {
    kind: "TARGETS";
    value: [] | [ImportSessionTargetInputV1];
  };
  EXPENSE_TYPE: Extract<ImportTypedDraftAnswerV1, { kind: "EXPENSE_TYPE" }>;
  LABOR_CATEGORY: {
    kind: "LABOR_CATEGORY";
    value: LaborCategory;
  };
}
export type ImportSessionGuidedOptionV1<
  C extends ImportSessionGuidedControlV1 = ImportSessionGuidedControlV1,
> = {
  [K in C]: {
    /** Human-readable copy only. Stable database ids may appear in `answer`, never here. */
    label: string;
    answer: ImportSessionGuidedAnswerByControlV1[K];
  };
}[C];
interface ImportSessionGuidedFocusBaseV1 {
  questionId: ImportSessionId;
  lineId: ImportSessionId;
  prompt: string;
  purchaseOrdinal: number;
  purchaseTotal: number;
  questionOrdinal: number;
  questionTotal: number;
  context: {
    title: string;
    merchant: string | null;
    amountCents: ImportSessionCents | null;
    purchaseDate: ImportSessionDateOnly | null;
  };
}
export type ImportSessionGuidedFocusV1<
  C extends ImportSessionGuidedControlV1 = ImportSessionGuidedControlV1,
> = {
  [K in C]: ImportSessionGuidedFocusBaseV1 & {
    control: K;
    options: ImportSessionGuidedOptionV1<K>[];
  };
}[C];
export type ImportSessionGuidedReviewV1 =
  | {
      progress: "ANSWERING";
      focus: ImportSessionGuidedFocusV1 | null;
      actions: ["CONTINUE_ANSWERING"];
    }
  | {
      progress: "READY";
      focus: null;
      actions: ["REVIEW_READY"];
    }
  | {
      progress: "READY_WITH_PENDING";
      focus: ImportSessionGuidedFocusV1 | null;
      actions: ["CONTINUE_ANSWERING", "REVIEW_READY"];
    };
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
export interface ImportSessionPageV1<T> {
  items: T[];
  nextCursor: string | null;
}
/** Pre-session availability, not content validation or authority to write. */
export const ImportSessionEntryUnavailableReason = {
  NOT_ENABLED: "NOT_ENABLED",
  RUNTIME_UNAVAILABLE: "RUNTIME_UNAVAILABLE",
  NO_QUALIFIED_FORMAT: "NO_QUALIFIED_FORMAT",
} as const;
export type ImportSessionEntryUnavailableReason =
  (typeof ImportSessionEntryUnavailableReason)[keyof typeof ImportSessionEntryUnavailableReason];
export type ImportSessionEntryV1 =
  | {
      kind: "UNAVAILABLE";
      version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
      reason: ImportSessionEntryUnavailableReason;
    }
  | {
      kind: "CARD_INVOICE";
      version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
      /** Runtime capability advertises only formats qualified for the complete RAW chain. */
      formats: readonly ["CSV"];
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
export interface ImportDeclarationCommandV1 extends ImportSessionRevisionRequestV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  requestId: ImportSessionRequestId;
  questionId: ImportSessionId;
  answer: ImportTypedGuidedAnswerV1;
}
export type ImportTypedDraftAnswerV1 =
  | { kind: "CENTS"; value: ImportSessionCents }
  | { kind: "POSITIVE_INTEGER"; value: number }
  | { kind: "DATE"; value: ImportSessionDateOnly }
  | { kind: "AMOUNT_MEANING"; value: ImportHumanMeaningV1 }
  | { kind: "TEXT"; value: string }
  | { kind: "DECISION"; value: ImportSessionDecisionV1 }
  | { kind: "TARGETS"; value: ImportSessionTargetInputV1[] }
  | { kind: "EXPENSE_TYPE"; value: ExpenseType }
  | { kind: "LABOR_CATEGORY"; value: LaborCategory | null }
  | { kind: "UNKNOWN" }
  | { kind: "REMOVE" };
export interface ImportDraftResolutionCommandV1 extends ImportSessionRevisionRequestV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  requestId: ImportSessionRequestId;
  questionId: ImportSessionId;
  answer: ImportTypedDraftAnswerV1;
}
export interface ImportLineDocumentaryCommandV1 extends ImportSessionRevisionRequestV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  requestId: ImportSessionRequestId;
  lineId: ImportSessionId;
}
export interface PrepareCurrentLotCommandV1 extends ImportSessionRevisionRequestV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  requestId: ImportSessionRequestId;
}
export interface ContinueAnsweringCommandV1 extends ImportSessionRevisionRequestV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  requestId: ImportSessionRequestId;
}
export interface ImportInterpretationRequestV1 extends ImportSessionRevisionRequestV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  requestId: ImportSessionRequestId;
  questionId: ImportSessionId;
  text: string;
  consentExternalProcessing: true;
}
export interface ImportCurrentLotV1 {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  state: "READY" | "READY_WITH_PENDING" | "CONFIRMED";
  revision: ImportSessionRevision;
  confirmationHash: ImportSessionConfirmationHash;
  purchases: Array<{
    title: string;
    merchant: string | null;
    purchaseDate: ImportSessionDateOnly;
    totalCents: ImportSessionCents;
    installmentIndex: number | null;
    installmentCount: number | null;
    schedule: ExpenseScheduleV1;
    targets: Array<{
      projectLabel: string;
      roomLabel: string | null;
      amountCents: ImportSessionCents;
      schedule: ExpenseScheduleV1;
    }>;
    disposition: "CREATE" | "KEEP_EXISTING";
  }>;
  createdEconomicTotalCents: ImportSessionCents;
  bankCashDeltaCents: 0;
  invoiceDeltas: Array<{
    invoiceDueMonth: string;
    amountCents: ImportSessionCents;
  }>;
  hasRemainingWork: boolean;
  actions: Array<"CONFIRM" | "EXECUTE">;
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
export interface ImportSessionChallengeRequestV1 extends ImportSessionRevisionRequestV1 {
  confirmationHash: ImportSessionConfirmationHash;
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
  reason: "ATTACHMENT_IN_FLIGHT" | "WRITE_BUDGET_EXCEEDED" | null;
}
