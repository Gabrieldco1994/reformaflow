import {
  CARD_IMPORT_IGNORED_REASON,
  ExpenseType,
  IMPORT_SESSION_AUDIT_OUTCOME,
  LaborCategory,
  IMPORT_NO_ELIGIBLE_PURCHASES,
  IMPORT_SESSION_KIND,
  IMPORT_SESSION_LIMITS as L,
  IMPORT_SESSION_PRIMITIVES as P,
  IMPORT_SESSION_PROTOCOL_VERSION as VERSION,
  ImportSessionAmountMeaning,
  ImportSessionState,
  IMPORT_SESSION_TERMINAL_OUTCOMES_PROJECTION_VERSION,
  PDF_OCR_MODEL_VERSION_PATTERN,
  isInvoiceDueMonth,
  parseExpenseSchedule,
  parseInstallmentDateOnlyUtc,
  type ExpenseScheduleV1,
  type ImportSessionCandidateV1,
  type ImportSessionChallengeResponseV1,
  type ImportSessionConfirmationRefV1,
  type ImportSessionConfirmResponseV1,
  type ImportSessionDecisionV1,
  type ImportSessionIgnoredAuditItemV1,
  type ImportSessionObservationViewV1,
  type ImportSessionPageV1,
  type ImportSessionProposalV1,
  type ImportSessionQuestionV1,
  type ImportSessionReceiptV1,
  type ImportSessionReceiptLineSnapshotV1,
  type ImportSessionTargetInputV1,
  type ImportSessionTerminalOutcomesV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import {
  hasImportDocumentFacts,
  hasImportDeclarationBindings,
  IMPORT_DRAFT_QUESTION_FIELDS,
  isImportDeclaredFact,
  isImportQuestion,
  isImportAttachment,
  isImportReviewBlockers,
  isRecord,
} from "./import-session-read";
import type {
  ImportOcrSessionViewV1,
  OcrCapabilityV1,
  OcrReviewEvidenceV1,
  OcrReviewLineV1,
  OcrTerminalOutcomeV1,
} from "../_types";

export class ImportWorkflowResponseError extends Error {
  constructor() {
    super("Unexpected import workflow response");
    this.name = "ImportMalformedResponseError";
  }
}
/** Additive backend field; older observation projections omit it. */
export type ImportObservationView = ImportSessionObservationViewV1 & {
  ignoredReason?: "INVOICE_PAYMENT" | null;
};
export type ImportWorkflowAuditItem = ImportSessionIgnoredAuditItemV1;
export type ImportWorkflowReceipt = Omit<
  ImportSessionReceiptV1,
  "auditItems"
> & {
  auditItems: ImportWorkflowAuditItem[];
};
export type ImportWorkflowProposal = ImportSessionProposalV1;
type ImportWorkflowProposalWire = Omit<
  ImportSessionProposalV1,
  "auditItems"
> & {
  auditItems?: ImportWorkflowAuditItem[];
};
const invalid = (): never => {
  throw new ImportWorkflowResponseError();
};
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const cents = (v: unknown): v is number => integer(v, P.minCents, P.maxCents);
const purchase = (v: unknown): v is number =>
  integer(v, P.minPurchaseCents, P.maxCents);
const revision = (v: unknown): v is number =>
  integer(v, P.minRevision, P.maxRevision);
const matches = (v: unknown, pattern: string): v is string =>
  typeof v === "string" && new RegExp(pattern).test(v);
const id = (v: unknown): v is string => matches(v, P.idPattern);
const hash = (v: unknown): v is string => matches(v, P.hashPattern);
const requestId = (v: unknown): v is string => matches(v, P.requestIdPattern);
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === "string" &&
  v.normalize("NFC") === v &&
  v.length >= min &&
  v.length <= max;
const oneOf = <T extends string>(v: unknown, options: readonly T[]): v is T =>
  typeof v === "string" && options.some((option) => option === v);
const distinct = (values: readonly string[]) =>
  new Set(values).size === values.length;
const ids = (v: unknown, min: number, max: number): v is string[] =>
  Array.isArray(v) &&
  v.length >= min &&
  v.length <= max &&
  v.every(id) &&
  distinct(v);
const every = <T>(
  v: unknown,
  guard: (item: unknown) => item is T,
  min: number,
  max: number,
): v is T[] =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every(guard);
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item) => b.includes(item));
const workflowJson = (value: unknown) =>
  JSON.stringify(value, (_key, member: unknown) =>
    isRecord(member)
      ? Object.fromEntries(
          Object.keys(member)
            .sort()
            .map((key) => [key, member[key]]),
        )
      : member,
  );
const same = (a: unknown, b: unknown): boolean =>
  workflowJson(a) === workflowJson(b);

/** Only JSON object members are unordered; approved array order remains significant. */
export function sameImportProposal(
  a: ImportSessionProposalV1 | null,
  b: ImportSessionProposalV1 | null,
): boolean {
  return same(a, b);
}
const instant = (v: unknown): v is string =>
  matches(v, P.instantPattern) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const date = (v: unknown): v is string => {
  if (!matches(v, P.dateOnlyPattern)) return false;
  const parsed = parseInstallmentDateOnlyUtc(v);
  return (
    parsed !== null &&
    parsed.getUTCFullYear() >= P.minYear &&
    parsed.getUTCFullYear() <= P.maxYear
  );
};

const OBSERVATION_KEYS = [
  "id",
  "attachmentId",
  "reference",
  "text",
  "amountMeaning",
  "amountCents",
  "installmentCount",
  "installmentIndex",
  "dataCompra",
];

function observation(v: unknown): v is ImportObservationView {
  if (!isRecord(v)) return false;
  const hasIgnoredReason = Object.hasOwn(v, "ignoredReason");
  return (
    exact(
      v,
      hasIgnoredReason
        ? [...OBSERVATION_KEYS, "ignoredReason"]
        : OBSERVATION_KEYS,
    ) &&
    (!hasIgnoredReason ||
      v.ignoredReason === null ||
      v.ignoredReason === "INVOICE_PAYMENT") &&
    id(v.id) &&
    id(v.attachmentId) &&
    text(v.reference, 1, P.maxReferenceLength) &&
    text(v.text, 0, P.maxObservationTextLength) &&
    oneOf(v.amountMeaning, Object.values(ImportSessionAmountMeaning)) &&
    (v.amountCents === null || cents(v.amountCents)) &&
    (v.installmentCount === null ||
      integer(
        v.installmentCount,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      )) &&
    (v.installmentIndex === null ||
      integer(
        v.installmentIndex,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      )) &&
    (v.dataCompra === null || date(v.dataCompra))
  );
}

function candidate(v: unknown): v is ImportSessionCandidateV1 {
  return (
    isRecord(v) &&
    exact(v, [
      "lineId",
      "kind",
      "id",
      "projectId",
      "description",
      "amountCents",
      "date",
      "reason",
      "canKeepExisting",
    ]) &&
    id(v.lineId) &&
    oneOf(v.kind, ["EXPENSE", "RECEIPT"]) &&
    id(v.id) &&
    id(v.projectId) &&
    typeof v.description === "string" &&
    cents(v.amountCents) &&
    date(v.date) &&
    oneOf(v.reason, [
      "STRONG_IDENTITY",
      "NATURAL_MATCH",
      "INSTALLMENT_MATCH",
    ]) &&
    typeof v.canKeepExisting === "boolean"
  );
}

function readPage<T>(
  value: unknown,
  guard: (item: unknown) => item is T,
): ImportSessionPageV1<T> {
  if (
    !isRecord(value) ||
    !exact(value, ["items", "nextCursor"]) ||
    !every(value.items, guard, 0, L.pageSize) ||
    !(
      value.nextCursor === null ||
      (typeof value.nextCursor === "string" && value.nextCursor.length > 0)
    )
  )
    return invalid();
  return { items: value.items, nextCursor: value.nextCursor };
}

export function readImportObservationPage(
  value: unknown,
): ImportSessionPageV1<ImportObservationView> {
  const page = readPage(value, observation);
  return distinct(page.items.map((item) => item.id)) ? page : invalid();
}

export function readImportCandidatePage(
  value: unknown,
  expectedLineId: string,
): ImportSessionPageV1<ImportSessionCandidateV1> {
  const page = readPage(value, candidate);
  return page.items.every((item) => item.lineId === expectedLineId) &&
    distinct(page.items.map((item) => `${item.kind}:${item.id}`))
    ? page
    : invalid();
}

function boundedJson(v: unknown): boolean {
  const json = JSON.stringify(v);
  return (
    typeof json === "string" &&
    new TextEncoder().encode(json).length <= L.jsonBytesPerDraftOrProposal
  );
}
function schedule(
  v: unknown,
  total: number,
  creating: boolean,
): v is ExpenseScheduleV1 {
  try {
    const parsed = parseExpenseSchedule(v);
    return (
      (!creating || parsed.occurrences.length <= L.installmentsPerPurchase) &&
      parsed.occurrences.every(
        (o) =>
          cents(o.valor) &&
          date(o.data) &&
          (!creating || o.invoiceDueMonth !== null),
      ) &&
      parsed.occurrences.reduce((sum, o) => sum + o.valor, 0) === total
    );
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}
function decision(v: unknown): v is ImportSessionDecisionV1 {
  if (!isRecord(v)) return false;
  switch (v.kind) {
    case "UNRESOLVED":
      return exact(v, ["kind"]);
    case "CREATE":
      return (
        exact(v, ["kind", "acceptNaturalDuplicate"]) &&
        typeof v.acceptNaturalDuplicate === "boolean"
      );
    case "KEEP_EXISTING":
      return exact(v, ["kind", "expenseId"]) && id(v.expenseId);
    default:
      return false;
  }
}
function target(v: unknown): v is ImportSessionTargetInputV1 {
  return (
    isRecord(v) &&
    exact(v, ["projectId", "roomId", "amountCents"]) &&
    id(v.projectId) &&
    (v.roomId === null || id(v.roomId)) &&
    purchase(v.amountCents)
  );
}
function ocrEvidence(v: unknown): v is OcrReviewEvidenceV1 {
  return (
    isRecord(v) &&
    exact(v, [
      "origin",
      "model",
      "modelVersion",
      "region",
      "authTrace",
      "attachmentId",
      "artifactFingerprint",
      "candidateFingerprint",
      "pageNumber",
      "text",
    ]) &&
    v.origin === "GOOGLE_VERTEX_AI" &&
    v.model === "gemini-2.5-flash" &&
    matches(v.modelVersion, PDF_OCR_MODEL_VERSION_PATTERN) &&
    v.region === "southamerica-east1" &&
    oneOf(v.authTrace, ["LOCAL_ADC", "SERVICE_ACCOUNT_FILE_ADC"]) &&
    id(v.attachmentId) &&
    hash(v.artifactFingerprint) &&
    hash(v.candidateFingerprint) &&
    integer(v.pageNumber, 1, 10) &&
    text(v.text, 1, P.maxObservationTextLength)
  );
}

function draftLine(v: unknown): v is OcrReviewLineV1 {
  const hasOcrEvidence = isRecord(v) && Object.hasOwn(v, "ocrEvidence");
  return (
    isRecord(v) &&
    exact(v, [
      "id",
      "observationIds",
      "titulo",
      "fornecedor",
      "tipoDespesa",
      "categoriaMaoDeObra",
      "amountMeaning",
      "amountCents",
      "installmentCount",
      "dataCompra",
      "firstDueDate",
      "targets",
      "decision",
      ...(hasOcrEvidence ? ["ocrEvidence"] : []),
    ]) &&
    id(v.id) &&
    ids(v.observationIds, 1, L.observationsPerLine) &&
    text(v.titulo, 1, P.maxTitleLength) &&
    (v.fornecedor === null || text(v.fornecedor, 0, P.maxSupplierLength)) &&
    (v.tipoDespesa === null ||
      oneOf(v.tipoDespesa, Object.values(ExpenseType))) &&
    (v.categoriaMaoDeObra === null ||
      oneOf(v.categoriaMaoDeObra, Object.values(LaborCategory))) &&
    oneOf(v.amountMeaning, Object.values(ImportSessionAmountMeaning)) &&
    (v.amountCents === null || cents(v.amountCents)) &&
    (v.installmentCount === null ||
      integer(v.installmentCount, 1, L.installmentsPerPurchase)) &&
    (v.dataCompra === null || date(v.dataCompra)) &&
    (v.firstDueDate === null || date(v.firstDueDate)) &&
    (v.targets === null ||
      (every(v.targets, target, 0, L.targetsPerPurchase) &&
        distinct(v.targets.map((t) => t.projectId)))) &&
    decision(v.decision) &&
    (!hasOcrEvidence || ocrEvidence(v.ocrEvidence))
  );
}

function ocrCapability(v: unknown): v is OcrCapabilityV1 {
  const hasTerminalOutcomes =
    isRecord(v) && Object.hasOwn(v, "terminalOutcomes");
  return (
    isRecord(v) &&
    exact(v, [
      "status",
      "consentPolicyVersion",
      "provider",
      "purpose",
      "region",
      "retentionDays",
      "sendsFullOriginal",
      "includesMetadataAndEmbeddedContent",
      "includesPotentiallyNonVisibleContent",
      "attachments",
      ...(hasTerminalOutcomes ? ["terminalOutcomes"] : []),
    ]) &&
    oneOf(v.status, ["DISABLED", "UNAVAILABLE", "AVAILABLE"]) &&
    v.consentPolicyVersion === 1 &&
    v.provider === "GOOGLE_VERTEX_AI" &&
    v.purpose === "DOCUMENT_LINE_TRANSCRIPTION_FOR_HUMAN_REVIEW" &&
    v.region === "southamerica-east1" &&
    v.retentionDays === 7 &&
    v.sendsFullOriginal === true &&
    v.includesMetadataAndEmbeddedContent === true &&
    v.includesPotentiallyNonVisibleContent === true &&
    every(
      v.attachments,
      (attachment): attachment is OcrCapabilityV1["attachments"][number] =>
        isRecord(attachment) &&
        exact(attachment, [
          "attachmentId",
          "questionId",
          "consentedRequestId",
          "consentedRevision",
        ]) &&
        id(attachment.attachmentId) &&
        id(attachment.questionId) &&
        (attachment.consentedRequestId === null ||
          requestId(attachment.consentedRequestId)) &&
        (attachment.consentedRevision === null ||
          revision(attachment.consentedRevision)) &&
        (attachment.consentedRequestId === null) ===
          (attachment.consentedRevision === null),
      0,
      L.filesPerSession,
    ) &&
    distinct(v.attachments.map((attachment) => attachment.attachmentId)) &&
    (!hasTerminalOutcomes ||
      (every(v.terminalOutcomes, terminalOutcome, 0, L.filesPerSession) &&
        distinct(v.terminalOutcomes.map((outcome) => outcome.attachmentId))))
  );
}

const OCR_TERMINAL_CODES: readonly OcrTerminalOutcomeV1["code"][] = [
  "OCR_UNAVAILABLE",
  "OCR_SAFETY_BLOCKED",
  "OCR_MALFORMED_RESPONSE",
  "OCR_ATTEMPT_UNKNOWN",
  "LIMIT_EXCEEDED",
  "DOCUMENT_UNREADABLE",
];

function terminalOutcome(v: unknown): v is OcrTerminalOutcomeV1 {
  return (
    isRecord(v) &&
    exact(v, ["attachmentId", "code"]) &&
    id(v.attachmentId) &&
    oneOf(v.code, OCR_TERMINAL_CODES)
  );
}

export function readImportTerminalOutcomes(
  value: unknown,
  expectedSessionId: string,
): ImportSessionTerminalOutcomesV1 {
  if (
    !isRecord(value) ||
    !exact(value, ["version", "sessionId", "revision", "outcomes"]) ||
    value.version !== IMPORT_SESSION_TERMINAL_OUTCOMES_PROJECTION_VERSION ||
    !id(value.sessionId) ||
    value.sessionId !== expectedSessionId ||
    !revision(value.revision) ||
    !every(value.outcomes, terminalOutcome, 0, L.filesPerSession) ||
    !distinct(value.outcomes.map((outcome) => outcome.attachmentId))
  )
    return invalid();
  return {
    version: IMPORT_SESSION_TERMINAL_OUTCOMES_PROJECTION_VERSION,
    sessionId: value.sessionId,
    revision: value.revision,
    outcomes: value.outcomes,
  };
}
export const QUESTION_FIELDS: readonly ImportSessionQuestionV1["field"][] = [
  ...IMPORT_DRAFT_QUESTION_FIELDS,
  "merchant",
  "installmentIndex",
];
export {
  exact as hasExactImportKeys,
  id as isImportId,
  ids as isImportIds,
  requestId as isImportRequestId,
  revision as isImportRevision,
};
type PlannedLine = ImportSessionProposalV1["lines"][number];
function plannedTarget(
  v: unknown,
): v is Extract<PlannedLine, { kind: "CREATE" }>["targets"][number] {
  return (
    isRecord(v) &&
    exact(v, ["projectId", "roomId", "amountCents", "schedule"]) &&
    id(v.projectId) &&
    (v.roomId === null || id(v.roomId)) &&
    purchase(v.amountCents) &&
    schedule(v.schedule, v.amountCents, true)
  );
}
function plannedLine(v: unknown): v is PlannedLine {
  if (!isRecord(v) || !id(v.lineId) || !cents(v.totalCents)) return false;
  if (v.kind === "KEEP_EXISTING") {
    return (
      exact(v, [
        "kind",
        "lineId",
        "sourceExpenseId",
        "totalCents",
        "schedule",
      ]) &&
      id(v.sourceExpenseId) &&
      schedule(v.schedule, v.totalCents, false)
    );
  }
  return (
    v.kind === "CREATE" &&
    exact(v, [
      "kind",
      "lineId",
      "titulo",
      "fornecedor",
      "tipoDespesa",
      "categoriaMaoDeObra",
      "dataCompra",
      "totalCents",
      "schedule",
      "targets",
    ]) &&
    purchase(v.totalCents) &&
    text(v.titulo, 1, P.maxTitleLength) &&
    (v.fornecedor === null || text(v.fornecedor, 0, P.maxSupplierLength)) &&
    oneOf(v.tipoDespesa, Object.values(ExpenseType)) &&
    (v.categoriaMaoDeObra === null ||
      oneOf(v.categoriaMaoDeObra, Object.values(LaborCategory))) &&
    date(v.dataCompra) &&
    schedule(v.schedule, v.totalCents, true) &&
    every(v.targets, plannedTarget, 0, L.targetsPerPurchase) &&
    distinct(v.targets.map((t) => t.projectId)) &&
    (v.targets.length === 0 ||
      v.targets.reduce((sum, t) => sum + t.amountCents, 0) === v.totalCents)
  );
}
function delta(
  v: unknown,
): v is ImportSessionProposalV1["invoiceDeltas"][number] {
  return (
    isRecord(v) &&
    exact(v, ["invoiceDueMonth", "amountCents"]) &&
    isInvoiceDueMonth(v.invoiceDueMonth) &&
    cents(v.amountCents)
  );
}
function invoiceEffectsMatch(
  sources: readonly ExpenseScheduleV1[],
  deltas: ImportSessionProposalV1["invoiceDeltas"],
): boolean {
  const occurrences = sources.flatMap((source) => source.occurrences);
  if (
    occurrences.reduce((sum, o) => sum + o.valor, 0) !==
    deltas.reduce((sum, d) => sum + d.amountCents, 0)
  )
    return false;
  const expected = new Map<string, number>();
  const supplied = new Map<string, number>();
  for (const occurrence of occurrences) {
    if (occurrence.invoiceDueMonth !== null) {
      expected.set(
        occurrence.invoiceDueMonth,
        (expected.get(occurrence.invoiceDueMonth) ?? 0) + occurrence.valor,
      );
    }
  }
  for (const d of deltas)
    supplied.set(
      d.invoiceDueMonth,
      (supplied.get(d.invoiceDueMonth) ?? 0) + d.amountCents,
    );
  return [...new Set([...expected.keys(), ...supplied.keys()])].every(
    (month) => (expected.get(month) ?? 0) === (supplied.get(month) ?? 0),
  );
}
function proposal(v: unknown): v is ImportWorkflowProposalWire {
  const hasAuditItems = isRecord(v) && Object.hasOwn(v, "auditItems");
  if (
    !isRecord(v) ||
    !boundedJson(v) ||
    !exact(v, [
      "version",
      "kind",
      "sessionId",
      "revision",
      "proposalHash",
      "lines",
      ...(hasAuditItems ? ["auditItems"] : []),
      "deferredObservationIds",
      "deferredAttachmentIds",
      "retainUntil",
      "createdEconomicTotalCents",
      "bankCashDeltaCents",
      "invoiceDeltas",
    ]) ||
    v.version !== VERSION ||
    v.kind !== IMPORT_SESSION_KIND ||
    !id(v.sessionId) ||
    !revision(v.revision) ||
    !hash(v.proposalHash) ||
    !every(v.lines, plannedLine, 1, L.selectedLines) ||
    !distinct(v.lines.map((l) => l.lineId)) ||
    (hasAuditItems &&
      (!every(v.auditItems, workflowAuditItem, 0, L.parsedRowsPerSession) ||
        !distinct(v.auditItems.map((item) => item.observationId)))) ||
    !ids(v.deferredObservationIds, 0, L.parsedRowsPerSession) ||
    !ids(v.deferredAttachmentIds, 0, L.filesPerSession) ||
    !(v.retainUntil === null || instant(v.retainUntil)) ||
    !integer(v.createdEconomicTotalCents, 0, P.maxCents) ||
    v.bankCashDeltaCents !== 0 ||
    !every(v.invoiceDeltas, delta, 0, L.expandedCFEsPerBatch)
  )
    return false;
  const expanded = v.lines.reduce(
    (sum, line) =>
      sum +
      (line.kind === "CREATE"
        ? line.schedule.occurrences.length +
          line.targets.reduce((n, t) => n + t.schedule.occurrences.length, 0)
        : 0),
    0,
  );
  return (
    expanded <= L.expandedCFEsPerBatch &&
    v.deferredObservationIds.length + v.deferredAttachmentIds.length > 0 ===
      (v.retainUntil !== null) &&
    v.lines.reduce(
      (sum, l) => sum + (l.kind === "CREATE" ? l.totalCents : 0),
      0,
    ) === v.createdEconomicTotalCents &&
    invoiceEffectsMatch(
      v.lines.flatMap((line) =>
        line.kind === "CREATE" ? [line.schedule] : [],
      ),
      v.invoiceDeltas,
    )
  );
}
function normalizeProposal(
  value: ImportWorkflowProposalWire,
): ImportWorkflowProposal {
  return {
    ...value,
    auditItems: value.auditItems ?? [],
  };
}
function confirmation(v: unknown): v is ImportSessionConfirmationRefV1 {
  return (
    isRecord(v) &&
    exact(v, ["financialRequestId", "confirmedRevision", "proposalHash"]) &&
    requestId(v.financialRequestId) &&
    revision(v.confirmedRevision) &&
    hash(v.proposalHash)
  );
}
function receiptItem(v: unknown): v is ImportSessionReceiptV1["items"][number] {
  return (
    isRecord(v) &&
    exact(v, [
      "lineId",
      "outcome",
      "sourceExpenseId",
      "targetExpenseIds",
      "allocationIds",
      "cashFlowEntryIds",
    ]) &&
    id(v.lineId) &&
    oneOf(v.outcome, ["CREATED", "KEPT_EXISTING"]) &&
    id(v.sourceExpenseId) &&
    ids(v.targetExpenseIds, 0, L.targetsPerPurchase) &&
    ids(v.allocationIds, 0, L.targetsPerPurchase) &&
    ids(
      v.cashFlowEntryIds,
      v.outcome === "CREATED" ? 1 : 0,
      L.expandedCFEsPerBatch,
    )
  );
}
function workflowAuditItem(v: unknown): v is ImportWorkflowAuditItem {
  return (
    isRecord(v) &&
    exact(v, ["observationId", "outcome", "reason", "title", "amountCents"]) &&
    id(v.observationId) &&
    v.outcome === IMPORT_SESSION_AUDIT_OUTCOME.IGNORED &&
    v.reason === CARD_IMPORT_IGNORED_REASON.INVOICE_PAYMENT &&
    text(v.title, 1, P.maxTitleLength) &&
    (v.amountCents === null || (cents(v.amountCents) && v.amountCents < 0))
  );
}
function snapshotLine(v: unknown): v is ImportSessionReceiptLineSnapshotV1 {
  return (
    isRecord(v) &&
    exact(v, [
      "lineId",
      "titulo",
      "dataCompra",
      "totalCents",
      "schedule",
      "sourceProjectId",
      "targets",
    ]) &&
    id(v.lineId) &&
    (v.titulo === null || text(v.titulo, 1, P.maxTitleLength)) &&
    (v.dataCompra === null || date(v.dataCompra)) &&
    cents(v.totalCents) &&
    schedule(v.schedule, v.totalCents, false) &&
    id(v.sourceProjectId) &&
    every(
      v.targets,
      (t): t is { projectId: string; amountCents: number } =>
        isRecord(t) &&
        exact(t, ["projectId", "amountCents"]) &&
        id(t.projectId) &&
        cents(t.amountCents),
      0,
      L.targetsPerPurchase,
    ) &&
    distinct(v.targets.map((t) => t.projectId))
  );
}
export function readImportWorkflowReceipt(
  value: unknown,
  anchorProjectId: string,
): ImportWorkflowReceipt {
  const hasAuditItems = isRecord(value) && Object.hasOwn(value, "auditItems");
  if (
    !isRecord(value) ||
    !exact(value, [
      "version",
      "sessionId",
      "financialRequestId",
      "confirmedRevision",
      "proposalHash",
      "appliedAt",
      "continuationSessionId",
      "items",
      "snapshot",
      ...(hasAuditItems ? ["auditItems"] : []),
    ]) ||
    value.version !== VERSION ||
    !id(value.sessionId) ||
    !requestId(value.financialRequestId) ||
    !revision(value.confirmedRevision) ||
    !hash(value.proposalHash) ||
    !instant(value.appliedAt) ||
    !(
      value.continuationSessionId === null ||
      (id(value.continuationSessionId) &&
        value.continuationSessionId !== value.sessionId)
    ) ||
    !every(value.items, receiptItem, 1, L.selectedLines) ||
    !distinct(value.items.map((i) => i.lineId)) ||
    (hasAuditItems &&
      (!every(value.auditItems, workflowAuditItem, 0, L.parsedRowsPerSession) ||
        !distinct(value.auditItems.map((item) => item.observationId)))) ||
    !distinct(
      value.items
        .filter((i) => i.outcome === "CREATED")
        .map((i) => i.sourceExpenseId),
    )
  )
    return invalid();
  const items = value.items;
  const auditItems = hasAuditItems
    ? (value.auditItems as ImportWorkflowAuditItem[])
    : [];
  const s = value.snapshot;
  if (
    !isRecord(s) ||
    !exact(s, [
      "lines",
      "participantProjectIds",
      "createdEconomicTotalCents",
      "bankCashDeltaCents",
      "invoiceDeltas",
    ]) ||
    !every(s.lines, snapshotLine, value.items.length, value.items.length) ||
    !ids(
      s.participantProjectIds,
      1,
      1 + L.selectedLines * (1 + L.targetsPerPurchase),
    ) ||
    !integer(s.createdEconomicTotalCents, 0, P.maxCents) ||
    s.bankCashDeltaCents !== 0 ||
    !every(s.invoiceDeltas, delta, 0, L.expandedCFEsPerBatch)
  )
    return invalid();
  const participants = [
    ...new Set([
      anchorProjectId,
      ...s.lines.flatMap((l) => [
        l.sourceProjectId,
        ...l.targets.map((t) => t.projectId),
      ]),
    ]),
  ].sort();
  if (
    !same(participants, s.participantProjectIds) ||
    s.lines.some((line, index) => {
      const item = items[index];
      return (
        line.lineId !== item.lineId ||
        (item.outcome === "CREATED"
          ? line.titulo === null ||
            line.dataCompra === null ||
            !purchase(line.totalCents) ||
            !schedule(line.schedule, line.totalCents, true) ||
            line.sourceProjectId !== anchorProjectId ||
            item.targetExpenseIds.length !== line.targets.length ||
            item.allocationIds.length !== line.targets.length ||
            line.targets.some((target) => !purchase(target.amountCents)) ||
            (line.targets.length > 0 &&
              line.targets.reduce(
                (sum, target) => sum + target.amountCents,
                0,
              ) !== line.totalCents)
          : line.titulo !== null || line.dataCompra !== null)
      );
    }) ||
    s.lines.reduce(
      (sum, l, i) => sum + (items[i].outcome === "CREATED" ? l.totalCents : 0),
      0,
    ) !== s.createdEconomicTotalCents ||
    !invoiceEffectsMatch(
      s.lines.flatMap((line, index) =>
        items[index].outcome === "CREATED" ? [line.schedule] : [],
      ),
      s.invoiceDeltas,
    )
  )
    return invalid();
  return {
    version: VERSION,
    sessionId: value.sessionId,
    financialRequestId: value.financialRequestId,
    confirmedRevision: value.confirmedRevision,
    proposalHash: value.proposalHash,
    appliedAt: value.appliedAt,
    continuationSessionId: value.continuationSessionId,
    items: value.items,
    auditItems,
    snapshot: {
      lines: s.lines,
      participantProjectIds: s.participantProjectIds,
      createdEconomicTotalCents: s.createdEconomicTotalCents,
      bankCashDeltaCents: 0,
      invoiceDeltas: s.invoiceDeltas,
    },
  };
}

/** Compare to the approved proposal, never to current financial rows. */
export function assertWorkflowReceipt(
  receipt: ImportWorkflowReceipt,
  view: ImportSessionViewV1,
): void {
  const c = view.confirmation;
  if (
    !c ||
    receipt.sessionId !== view.id ||
    receipt.financialRequestId !== c.financialRequestId ||
    receipt.confirmedRevision !== c.confirmedRevision ||
    receipt.proposalHash !== c.proposalHash
  )
    invalid();
  const p = view.proposal;
  if (!p) return;
  const proposalAuditItems = (p as ImportWorkflowProposalWire).auditItems ?? [];
  const receiptAuditItems = receipt.auditItems;
  if (
    !same(receiptAuditItems, proposalAuditItems) ||
    receipt.snapshot.createdEconomicTotalCents !==
      p.createdEconomicTotalCents ||
    !same(receipt.snapshot.invoiceDeltas, p.invoiceDeltas) ||
    receipt.items.length !== p.lines.length ||
    (receipt.continuationSessionId !== null) !==
      p.deferredObservationIds.length + p.deferredAttachmentIds.length > 0 ||
    p.lines.some((line, index) => {
      const item = receipt.items[index];
      const snapshot = receipt.snapshot.lines[index];
      if (
        item.lineId !== line.lineId ||
        snapshot.totalCents !== line.totalCents ||
        !same(snapshot.schedule, line.schedule)
      )
        return true;
      return line.kind === "KEEP_EXISTING"
        ? item.outcome !== "KEPT_EXISTING" ||
            item.sourceExpenseId !== line.sourceExpenseId
        : item.outcome !== "CREATED" ||
            snapshot.titulo !== line.titulo ||
            snapshot.dataCompra !== line.dataCompra ||
            !same(
              snapshot.targets,
              line.targets.map((t) => ({
                projectId: t.projectId,
                amountCents: t.amountCents,
              })),
            );
    })
  )
    invalid();
}
const ACTIONS: readonly ImportSessionViewV1["actions"][number][] = [
  "UPLOAD",
  "ANALYZE",
  "RESOLVE",
  "PREPARE",
  "CONFIRM",
  "EXECUTE",
  "CANCEL",
  "READ_RESULT",
];

export function readImportWorkflowView(value: unknown): ImportOcrSessionViewV1 {
  const draftQuestionLimit =
    L.editableLines * IMPORT_DRAFT_QUESTION_FIELDS.length;
  const documentaryFieldLimit = L.editableLines * L.observationsPerLine * 6;
  const capabilityValue = isRecord(value) ? value.ocrCapability : null;
  if (
    !isRecord(value) ||
    !exact(value, [
      "version",
      "id",
      "ownerProjectId",
      "cardId",
      "state",
      "revision",
      "expiresAt",
      "attachments",
      "lines",
      "selectedLineIds",
      "questions",
      "declaredFacts",
      "reviewBlockers",
      "ocrCapability",
      "searchComplete",
      "proposal",
      "confirmation",
      "receipt",
      "actions",
      ...(Object.hasOwn(value, "analysisOutcome") ? ["analysisOutcome"] : []),
    ]) ||
    value.version !== VERSION ||
    !id(value.id) ||
    !id(value.ownerProjectId) ||
    !id(value.cardId) ||
    !oneOf(value.state, Object.values(ImportSessionState)) ||
    !revision(value.revision) ||
    !(value.expiresAt === null || instant(value.expiresAt)) ||
    !every(value.attachments, isImportAttachment, 0, L.filesPerSession) ||
    !distinct(value.attachments.map((a) => a.id)) ||
    value.attachments.reduce((sum, a) => sum + a.declaredBytes, 0) >
      L.bytesPerSession ||
    !every(value.lines, draftLine, 0, L.editableLines) ||
    !distinct(value.lines.map((l) => l.id)) ||
    !ids(value.selectedLineIds, 0, L.selectedLines) ||
    !isImportReviewBlockers(value.reviewBlockers) ||
    !ocrCapability(capabilityValue) ||
    !every(
      value.questions,
      isImportQuestion,
      0,
      draftQuestionLimit + documentaryFieldLimit,
    ) ||
    value.questions.filter((question) => !("subject" in question)).length >
      draftQuestionLimit ||
    value.questions.filter((question) => "subject" in question).length >
      documentaryFieldLimit ||
    !distinct(value.questions.map((q) => q.id)) ||
    !every(
      value.declaredFacts,
      isImportDeclaredFact,
      0,
      documentaryFieldLimit,
    ) ||
    !hasImportDeclarationBindings({
      lines: value.lines,
      questions: value.questions,
      declaredFacts: value.declaredFacts,
    }) ||
    typeof value.searchComplete !== "boolean" ||
    !(value.proposal === null || proposal(value.proposal)) ||
    !(value.confirmation === null || confirmation(value.confirmation)) ||
    !every(
      value.actions,
      (a): a is ImportSessionViewV1["actions"][number] => oneOf(a, ACTIONS),
      0,
      ACTIONS.length,
    ) ||
    !distinct(value.actions) ||
    !hasImportDocumentFacts({
      attachments: value.attachments,
      actions: value.actions,
      reviewBlockers: value.reviewBlockers,
      lines: value.lines,
      selectedLineIds: value.selectedLineIds,
      state: value.state,
    })
  )
    return invalid();
  const { lines, selectedLineIds, questions, attachments } = value;
  const capability = capabilityValue;
  const selected = lines.filter((line) => selectedLineIds.includes(line.id));
  if (
    capability.attachments.some((candidate) =>
      attachments.every(
        (attachment) => attachment.id !== candidate.attachmentId,
      ),
    ) ||
    (capability.terminalOutcomes ?? []).some((outcome) => {
      const attachment = attachments.find(
        (candidate) => candidate.id === outcome.attachmentId,
      );
      return !attachment || attachment.canAnalyze;
    }) ||
    (value.actions.includes("ANALYZE") &&
      attachments
        .filter((attachment) => attachment.canAnalyze)
        .every((attachment) =>
          (capability.terminalOutcomes ?? []).some(
            (outcome) => outcome.attachmentId === attachment.id,
          ),
        )) ||
    lines.some(
      (line) =>
        line.ocrEvidence &&
        attachments.every(
          (attachment) => attachment.id !== line.ocrEvidence?.attachmentId,
        ),
    ) ||
    !boundedJson({
      version: VERSION,
      lines,
      selectedLineIds,
      questions: questions.filter((question) => !("subject" in question)),
    }) ||
    selected.length !== selectedLineIds.length ||
    questions.some((q) =>
      q.lineIds.some((lineId) => !lines.some((l) => l.id === lineId)),
    ) ||
    !distinct(selected.flatMap((l) => l.observationIds))
  )
    return invalid();
  const terminal = ["APPLIED", "CANCELLED", "EXPIRED"].includes(value.state);
  if (terminal !== (value.expiresAt === null)) return invalid();
  const p = value.proposal === null ? null : normalizeProposal(value.proposal);
  const c = value.confirmation;
  if (c && ["DRAFT", "ANALYZING", "NEEDS_INPUT", "READY"].includes(value.state))
    return invalid();
  if (c && c.confirmedRevision > value.revision) return invalid();
  if (
    p &&
    (p.sessionId !== value.id ||
      p.revision !== (c?.confirmedRevision ?? value.revision) ||
      (c && p.proposalHash !== c.proposalHash) ||
      !sameIds(
        p.lines.map((l) => l.lineId),
        selectedLineIds,
      ) ||
      p.lines.some((line) => {
        const d = selected.find((l) => l.id === line.lineId)?.decision;
        return (
          d?.kind !== line.kind ||
          (line.kind === "KEEP_EXISTING" &&
            (d.kind !== "KEEP_EXISTING" ||
              d.expenseId !== line.sourceExpenseId))
        );
      }) ||
      p.deferredObservationIds.some((o) =>
        selected.some((l) => l.observationIds.includes(o)),
      ) ||
      p.deferredAttachmentIds.some(
        (a) => !attachments.some((item) => item.id === a),
      ) ||
      (!terminal &&
        p.retainUntil !== null &&
        p.retainUntil !== value.expiresAt))
  )
    return invalid();
  const hidden = value.state === "CANCELLED" || value.state === "EXPIRED";
  if (
    hidden &&
    (lines.length ||
      selectedLineIds.length ||
      questions.length ||
      value.declaredFacts.length ||
      value.attachments.length ||
      p !== null)
  )
    return invalid();
  if ((value.state === "CONFIRMED" || value.state === "APPLIED") && c === null)
    return invalid();
  if (value.state !== "APPLIED" && value.receipt !== null) return invalid();
  const receipt =
    value.receipt === null
      ? null
      : readImportWorkflowReceipt(value.receipt, value.ownerProjectId);
  if (value.state === "APPLIED" && receipt === null) return invalid();
  const view: ImportOcrSessionViewV1 = {
    version: VERSION,
    id: value.id,
    ownerProjectId: value.ownerProjectId,
    cardId: value.cardId,
    state: value.state,
    revision: value.revision,
    expiresAt: value.expiresAt,
    attachments: value.attachments,
    lines,
    selectedLineIds,
    questions,
    declaredFacts: value.declaredFacts,
    reviewBlockers: value.reviewBlockers,
    ocrCapability: capability,
    searchComplete: value.searchComplete,
    proposal: p,
    confirmation: c,
    receipt,
    actions: value.actions,
  };
  if (Object.hasOwn(value, "analysisOutcome")) {
    if (
      value.analysisOutcome !== null &&
      value.analysisOutcome !== IMPORT_NO_ELIGIBLE_PURCHASES
    )
      return invalid();
    view.analysisOutcome = value.analysisOutcome;
  }
  if (receipt) assertWorkflowReceipt(receipt, view);
  return view;
}

export function readImportChallenge(
  value: unknown,
): ImportSessionChallengeResponseV1 {
  if (
    !isRecord(value) ||
    !exact(value, ["nonce", "expiresAt"]) ||
    !text(value.nonce, 1, 512) ||
    !instant(value.expiresAt)
  )
    return invalid();
  return { nonce: value.nonce, expiresAt: value.expiresAt };
}
export function readImportConfirmation(
  value: unknown,
): ImportSessionConfirmResponseV1 {
  if (
    !isRecord(value) ||
    !exact(value, ["sessionId", "financialRequestId", "state"]) ||
    !id(value.sessionId) ||
    !requestId(value.financialRequestId) ||
    !oneOf(value.state, [
      "CONFIRMED",
      "APPLIED",
      "REVIEW_REQUIRED",
      "CANCELLED",
      "EXPIRED",
    ])
  )
    return invalid();
  return {
    sessionId: value.sessionId,
    financialRequestId: value.financialRequestId,
    state: value.state,
  };
}
