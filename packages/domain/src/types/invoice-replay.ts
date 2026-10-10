export const INVOICE_REPLAY_MAX_INT = 2_147_483_647;

export const INVOICE_SOURCE_KIND = {
  BANK_PAYMENT: "BANK_PAYMENT",
  CARD_TRANSFER: "CARD_TRANSFER",
  INVOICE_CREDIT: "INVOICE_CREDIT",
} as const;
export type SourceKind =
  (typeof INVOICE_SOURCE_KIND)[keyof typeof INVOICE_SOURCE_KIND];
export const INVOICE_ALLOCATION_KIND = {
  BANK_FUNDING: "BANK_FUNDING",
  TRANSFER_FUNDING: "TRANSFER_FUNDING",
  CREDIT_OFFSET: "CREDIT_OFFSET",
} as const;
export type AllocationKind =
  (typeof INVOICE_ALLOCATION_KIND)[keyof typeof INVOICE_ALLOCATION_KIND];
export type AllocationLayer = "ORIGINAL_COVERAGE" | "REPLAY";
export interface OccurrenceRef {
  expenseId: string;
  index: number;
}
export interface InvoiceRef {
  cardId: string;
  invoiceDueMonth: string;
}
export interface EvidenceInput {
  documentSha256: string;
  reference: string;
}
export const INVOICE_CREDIT_DISPOSITION = {
  AVAILABLE_ON_INVOICE: "AVAILABLE_ON_INVOICE",
  REDEEMED_TO_ACCOUNT: "REDEEMED_TO_ACCOUNT",
  UNRESOLVED: "UNRESOLVED",
} as const;
export interface CreditDispositionInput {
  occurrence: OccurrenceRef;
  disposition: (typeof INVOICE_CREDIT_DISPOSITION)[keyof typeof INVOICE_CREDIT_DISPOSITION];
  receiptId?: string;
  evidence: EvidenceInput;
}
export type AdmissionInput =
  | { mode: "EXISTING_ASSOCIATION" }
  | {
      mode: "ASSISTED_EXISTING_PAYMENT";
      evidence: EvidenceInput;
      confirmCardAndCycle: true;
    };
export interface SourceInput {
  kind: "BANK_PAYMENT" | "CARD_TRANSFER";
  occurrence: OccurrenceRef;
  admission: AdmissionInput;
}
export interface ReplayPreviewRequest {
  version: 1;
  invoiceDueMonth: string;
  sources: SourceInput[];
  admitOriginalCoverage: boolean;
  /** Documentary disposition, never editable financial amounts/dates. */
  creditDispositions?: CreditDispositionInput[];
}
export interface ReplayApplyRequest extends ReplayPreviewRequest {
  fingerprint: string;
  idempotencyKey: string;
}
export type UndoSelector =
  | { kind: "REPLAY_OPERATION"; operationId: string }
  | { kind: "SOURCE_REPLAY"; sourceId: string }
  | { kind: "ORIGINAL_ADMISSION"; operationId: string };
export interface UndoPreviewRequest {
  version: 1;
  invoiceDueMonth: string;
  selector: UndoSelector;
}
export interface UndoApplyRequest extends UndoPreviewRequest {
  fingerprint: string;
  idempotencyKey: string;
}
export type BlockCode =
  | "SOURCE_PROOF_REQUIRED"
  | "SOURCE_ALREADY_BOUND"
  | "SOURCE_MOVEMENT_DRIFT"
  | "TRAIL_VERSION_MISMATCH"
  | "INCOMPLETE_TRAIL"
  | "ORIGINAL_COVERAGE_UNPROVEN"
  | "OCCURRENCE_DRIFT"
  | "GRAPH_DRIFT"
  | "AMBIGUOUS_CARD"
  | "AMBIGUOUS_ACCOUNT"
  | "MULTI_TARGET_ATTRIBUTION_REQUIRED"
  | "CONTRACTED_FUNDING_REQUIRES_702"
  | "TRANSFER_PRINCIPAL_UNPROVEN"
  | "TRANSFER_NOT_EXECUTED"
  | "DUPLICATE_CREDIT_REPRESENTATION"
  | "CREDIT_DISPOSITION_UNPROVEN"
  | "ADJUSTMENT_ATTRIBUTION_REQUIRED"
  | "ADMISSION_HAS_DEPENDENTS"
  | "STALE_PREVIEW"
  | "IDEMPOTENCY_CONFLICT"
  | "RETRYABLE_WRITE_CONFLICT";
export interface Diagnostic {
  code: BlockCode;
}
export interface InvoiceFinancialTotals {
  grossChargesCents: number;
  invoiceCreditsCents: number;
  netObligationCents: number;
  bankRecordedCents: number;
  cardTransferRecordedCents: number;
  signedBalanceCents: number;
  bankPayableCents: number;
  invoiceSurplusCents: number;
}
export interface ExactCoverageTotals {
  bankAllocatedCents: number;
  cardTransferAllocatedCents: number;
  creditOffsetCents: number;
  uncoveredGrossCents: number;
  unallocatedBankCents: number;
  unallocatedTransferCents: number;
  unappliedCreditCents: number;
}
export type InvoiceCoverageState =
  | { mode: "EXACT"; totals: ExactCoverageTotals; fullyReconciled: boolean }
  | {
      mode: "LEGACY_UNATTRIBUTED";
      originalClaimCents: number;
      fullyReconciled: false;
    };
export interface InvoiceState {
  financial: InvoiceFinancialTotals;
  coverage: InvoiceCoverageState;
}
export interface SourceView {
  sourceId: string | null;
  kind: SourceKind;
  occurrence: OccurrenceRef;
  originalImportId: string | null;
  accountId: string | null;
  originCardId: string | null;
  recordedDate: string;
  capacityCents: number;
  originalReservedCents: number;
  allocatedCents: number;
  availableCents: number;
}
export interface OccurrenceView {
  occurrence: OccurrenceRef;
  cashFlowEntryId: string;
  parcela: string | null;
  data: string;
  invoiceDueMonth: string;
  amountCents: number;
  recordedStatus: "PAGO" | "PLANEJADO";
  coverageStatus: "UNATTRIBUTED" | "PARTIAL" | "COVERED";
  bankCents: number;
  transferCents: number;
  creditCents: number;
  uncoveredCents: number;
  proposedCents: number;
}
export interface AllocationView {
  kind: AllocationKind;
  layer: AllocationLayer;
  sourceOccurrence: OccurrenceRef;
  targetOccurrence: OccurrenceRef;
  amountCents: number;
}
export interface StatusDelta {
  occurrence: OccurrenceRef;
  cashFlowEntryId: string;
  before: "PAGO" | "PLANEJADO";
  after: "PAGO" | "PLANEJADO";
}
export interface BlockedPreview {
  version: 1;
  invoice: InvoiceRef;
  outcome: "BLOCKED";
  fingerprint: null;
  diagnostics: Diagnostic[];
  fullyReconciled: false;
}
export type ApplicablePreviewOutcome =
  | "READY"
  | "NO_CHANGES"
  | "NO_ELIGIBLE_OCCURRENCES"
  | "NO_AVAILABLE_COVERAGE";
export interface ApplicableReplayPreview {
  version: 1;
  invoice: InvoiceRef;
  outcome: ApplicablePreviewOutcome;
  fingerprint: string;
  diagnostics: [];
  before: InvoiceState;
  after: InvoiceState;
  sources: SourceView[];
  occurrences: OccurrenceView[];
  proposedAllocations: AllocationView[];
  statusDeltas: StatusDelta[];
}
export type ReplayPreviewResponse = BlockedPreview | ApplicableReplayPreview;
export type ApplyOutcome =
  | "APPLIED_FULL"
  | "APPLIED_PARTIAL"
  | "NO_CHANGES"
  | "NO_ELIGIBLE_OCCURRENCES"
  | "NO_AVAILABLE_COVERAGE";
export interface PublicApplyReceipt {
  version: 1;
  operationId: string;
  invoice: InvoiceRef;
  outcome: ApplyOutcome;
  createdAt: string;
  after: InvoiceState;
  allocatedBankCents: number;
  allocatedTransferCents: number;
  allocatedCreditCents: number;
  coveredOccurrenceCount: number;
  partialOccurrenceCount: number;
  changedStatusCount: number;
  originalAdmissionCreated: boolean;
}
export interface OperationLifecycle {
  replayState: "NONE" | "ACTIVE" | "PARTIALLY_REVERSED" | "REVERSED";
  originalAdmissionState:
    | "NONE"
    | "ACTIVE"
    | "WITHDRAWN"
    | "ECONOMICALLY_REDUCED";
}
export interface ReplayApplyResponse {
  receipt: PublicApplyReceipt;
  lifecycle: OperationLifecycle;
}
export interface ApplicableUndoPreview {
  version: 1;
  invoice: InvoiceRef;
  selector: UndoSelector;
  outcome: "READY" | "NO_CHANGES";
  fingerprint: string;
  diagnostics: [];
  before: InvoiceState;
  after: InvoiceState;
  allocationsToRelease: AllocationView[];
  statusDeltas: StatusDelta[];
  withdrawsOriginalAdmission: boolean;
}
export type UndoPreviewResponse = BlockedPreview | ApplicableUndoPreview;
export type InternalUndoSelector =
  | UndoSelector
  | { kind: "BANK_IMPORT" | "CARD_IMPORT"; importId: string }
  | { kind: "TRANSFER" | "CREDIT" | "GRAPH"; sourceExpenseId: string };
export interface PublicUndoReceipt {
  version: 1;
  operationId: string;
  invoice: InvoiceRef;
  selector: InternalUndoSelector;
  outcome: "REVERSED" | "NO_CHANGES";
  createdAt: string;
  releasedBankCents: number;
  releasedTransferCents: number;
  releasedCreditCents: number;
  changedStatusCount: number;
  originalAdmissionWithdrawn: boolean;
  after: InvoiceState;
}
export interface UndoApplyResponse {
  receipt: PublicUndoReceipt;
}
export interface OperationDetailResponse {
  receipt: PublicApplyReceipt | PublicUndoReceipt;
  lifecycle: OperationLifecycle;
}
