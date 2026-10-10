import type { ImportSession, ImportSessionArtifact } from "@prisma/client";
import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  IMPORT_SESSION_PROTOCOL_VERSION,
  ImportSessionAttachmentState,
  ImportSessionState,
  isInvoiceDueMonth,
  isPendingImportQuestion,
  parseExpenseSchedule,
  type ExpenseScheduleV1,
  type ImportSessionConfirmationRefV1,
  type ImportSessionId,
  type ImportSessionProposalV1,
  type ImportSessionReceiptLineSnapshotV1,
  type ImportSessionReceiptSnapshotV1,
  type ImportSessionReceiptV1,
  type ImportSessionSummaryV1,
  type ImportSessionStoredDraftV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { IMPORT_NO_ELIGIBLE_PURCHASES } from "@reformaflow/domain";
import { ImportSessionCorruptStateError } from "./import-session.errors";
import { parseStoredImportSearch } from "./import-session.search";
import {
  assertProposalDraftReferences,
  validateProposal,
  validateStoredDraft,
} from "./import-session.validation";

/** Literal empty document, `scope` included (also what cancel/cleanup writes back). */
export const EMPTY_DRAFT_JSON = JSON.stringify({
  version: IMPORT_SESSION_PROTOCOL_VERSION,
  lines: [],
  selectedLineIds: [],
  questions: [],
  scope: { observationIds: [], pendingAttachmentIds: [] },
});

const CANCELLABLE_STATES: ReadonlySet<string> = new Set([
  ImportSessionState.DRAFT,
  ImportSessionState.ANALYZING,
  ImportSessionState.NEEDS_INPUT,
  ImportSessionState.READY,
  ImportSessionState.CONFIRMED,
  ImportSessionState.REVIEW_REQUIRED,
]);
export const CANCELLABLE_STATE_LIST = [...CANCELLABLE_STATES];
export const IMPORT_SESSION_UPLOAD_EDITABLE_STATES: readonly string[] = [
  ImportSessionState.DRAFT,
  ImportSessionState.NEEDS_INPUT,
];
const KNOWN_STATES: ReadonlySet<string> = new Set(
  Object.values(ImportSessionState),
);

const HASH = new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern);
const ID = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);
const REQUEST_ID = new RegExp(IMPORT_SESSION_PRIMITIVES.requestIdPattern);
const INSTANT = new RegExp(IMPORT_SESSION_PRIMITIVES.instantPattern);

const corrupt = (field: string) => new ImportSessionCorruptStateError(field);

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function parseJson(raw: string, field: string): unknown {
  if (
    Buffer.byteLength(raw, "utf8") >
    IMPORT_SESSION_LIMITS.jsonBytesPerDraftOrProposal
  ) {
    throw corrupt(field);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw corrupt(field);
  }
}

/** Strict parse of the private draft: no fallback to an empty draft when it is broken. */
export function parseStoredDraft(raw: string): ImportSessionStoredDraftV1 {
  return validateStoredDraft(parseJson(raw, "draft"));
}

export function parseSessionDocuments(row: ProjectableSession) {
  const stored = parseStoredDraft(row.draftJson);
  const search = parseStoredImportSearch(
    row.searchJson,
    row.confirmedRevision ?? row.revision,
    stored,
  );
  const proposal =
    row.proposalJson === null
      ? null
      : parseProposal(row.proposalJson, row.id, row.proposalHash);
  if (proposal !== null) {
    assertProposalDraftReferences(proposal, stored);
    if (
      proposal.retainUntil !== null &&
      proposal.retainUntil !== row.expiresAt.toISOString()
    )
      throw corrupt("proposal");
  }
  return {
    stored,
    proposal,
    searchComplete: search.kind === "SEARCH" && search.value.complete,
  };
}

export function parseProposal(
  raw: string,
  sessionId: string,
  proposalHash: string | null,
): ImportSessionProposalV1 {
  return validateProposal(parseJson(raw, "proposal"), sessionId, proposalHash);
}

/**
 * ACL-only scan of the targets the view may expose. Malformed envelopes are left to the
 * strict parser AFTER all readable participant IDs have been authorised, never repaired.
 * Size is checked only by the deep parser: skipping an oversized envelope leaks 404 vs 500.
 * It deliberately does not inspect financial values, and cancel never calls this scan.
 */
export function draftProposalParticipantEnvelope(
  row: Pick<
    ImportSession,
    "state" | "expiresAt" | "draftJson" | "proposalJson"
  >,
  now: Date,
): string[] {
  if (
    row.state === ImportSessionState.CANCELLED ||
    row.state === ImportSessionState.EXPIRED ||
    (CANCELLABLE_STATES.has(row.state) &&
      now.getTime() >= row.expiresAt.getTime())
  )
    return [];
  const participants = new Set<string>();
  for (const raw of [row.draftJson, row.proposalJson]) {
    if (raw === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (!isRecord(value) || !Array.isArray(value["lines"])) continue;
    for (const line of value["lines"]) {
      if (!isRecord(line) || !Array.isArray(line["targets"])) continue;
      for (const target of line["targets"]) {
        if (isRecord(target) && typeof target["projectId"] === "string") {
          participants.add(target["projectId"]);
        }
      }
    }
  }
  return [...participants];
}

const RECEIPT_OUTCOMES: ReadonlySet<unknown> = new Set([
  "CREATED",
  "KEPT_EXISTING",
]);
const DATE_ONLY = new RegExp(IMPORT_SESSION_PRIMITIVES.dateOnlyPattern);
const RECEIPT_KEYS = [
  "version",
  "sessionId",
  "financialRequestId",
  "confirmedRevision",
  "proposalHash",
  "appliedAt",
  "continuationSessionId",
  "items",
  "snapshot",
].sort();
const ITEM_KEYS = [
  "lineId",
  "outcome",
  "sourceExpenseId",
  "targetExpenseIds",
  "allocationIds",
  "cashFlowEntryIds",
].sort();
const SNAPSHOT_KEYS = [
  "lines",
  "participantProjectIds",
  "createdEconomicTotalCents",
  "bankCashDeltaCents",
  "invoiceDeltas",
].sort();
const SNAPSHOT_LINE_KEYS = [
  "lineId",
  "titulo",
  "dataCompra",
  "totalCents",
  "schedule",
  "sourceProjectId",
  "targets",
].sort();

const hasExactKeys = (value: JsonRecord, keys: readonly string[]): boolean => {
  const own = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return (
    own.length === wanted.length &&
    own.every((key, index) => key === wanted[index])
  );
};
const isId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
const isIdArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isId);
/** Non-negative safe integer (centavos). Fractions, strings and negatives are corruption. */
const isCents = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The ACL envelope of a stored receipt: ONLY `snapshot.participantProjectIds`, judged with the
 * same definition as the list SQL CASE (valid JSON, array, non-empty, every member text).
 * Returns null when the envelope is malformed. That case is NOT an authorization decision: it
 * must reach the strict parser, which answers the sanitised 500. Nothing else in the receipt
 * is inspected here, so an unauthorised participant never has its content examined.
 */
export function receiptParticipantEnvelope(raw: string): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value["snapshot"])) return null;
  const ids = value["snapshot"]["participantProjectIds"];
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    !ids.every((id) => typeof id === "string")
  ) {
    return null;
  }
  return ids as string[];
}

function parseSnapshot(
  value: unknown,
  items: ImportSessionReceiptV1["items"],
  anchorProjectId: string,
): ImportSessionReceiptSnapshotV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SNAPSHOT_KEYS) ||
    !Array.isArray(value["lines"]) ||
    value["lines"].length !== items.length ||
    !isIdArray(value["participantProjectIds"]) ||
    !isCents(value["createdEconomicTotalCents"]) ||
    value["bankCashDeltaCents"] !== 0 ||
    !Array.isArray(value["invoiceDeltas"])
  ) {
    throw corrupt("receipt");
  }
  const union = new Set<string>([anchorProjectId]);
  let createdTotal = 0;
  const lines = value["lines"].map(
    (line: unknown, index): ImportSessionReceiptLineSnapshotV1 => {
      const item = items[index]!;
      if (
        !isRecord(line) ||
        !hasExactKeys(line, SNAPSHOT_LINE_KEYS) ||
        line["lineId"] !== item.lineId ||
        !isCents(line["totalCents"]) ||
        !isId(line["sourceProjectId"]) ||
        !Array.isArray(line["targets"])
      ) {
        throw corrupt("receipt");
      }
      const created = item.outcome === "CREATED";
      if (created) {
        if (
          typeof line["titulo"] !== "string" ||
          line["titulo"].trim().length === 0 ||
          typeof line["dataCompra"] !== "string" ||
          !DATE_ONLY.test(line["dataCompra"])
        ) {
          throw corrupt("receipt");
        }
        createdTotal += line["totalCents"];
      } else if (line["titulo"] !== null || line["dataCompra"] !== null) {
        // KEEP_EXISTING never carries an approved description or date.
        throw corrupt("receipt");
      }
      let schedule: ExpenseScheduleV1;
      try {
        schedule = parseExpenseSchedule(line["schedule"]);
      } catch {
        throw corrupt("receipt");
      }
      if (
        schedule.occurrences.reduce((sum, o) => sum + o.valor, 0) !==
          line["totalCents"] ||
        (created &&
          schedule.occurrences.some((item) => item.invoiceDueMonth === null))
      ) {
        throw corrupt("receipt");
      }
      union.add(line["sourceProjectId"]);
      const targets = line["targets"].map((target: unknown) => {
        if (
          !isRecord(target) ||
          !hasExactKeys(target, ["projectId", "amountCents"]) ||
          !isId(target["projectId"]) ||
          !isCents(target["amountCents"])
        ) {
          throw corrupt("receipt");
        }
        union.add(target["projectId"]);
        return {
          projectId: target["projectId"],
          amountCents: target["amountCents"],
        };
      });
      return {
        lineId: line["lineId"],
        titulo: created ? (line["titulo"] as string) : null,
        dataCompra: created ? (line["dataCompra"] as string) : null,
        totalCents: line["totalCents"],
        schedule,
        sourceProjectId: line["sourceProjectId"],
        targets,
      };
    },
  );
  const participants = value["participantProjectIds"];
  const expected = [...union].sort();
  if (
    participants.length !== expected.length ||
    participants.some((id, index) => id !== expected[index]) ||
    createdTotal !== value["createdEconomicTotalCents"]
  ) {
    throw corrupt("receipt");
  }
  const invoiceDeltas = value["invoiceDeltas"].map((delta: unknown) => {
    if (
      !isRecord(delta) ||
      !hasExactKeys(delta, ["invoiceDueMonth", "amountCents"]) ||
      !isInvoiceDueMonth(delta["invoiceDueMonth"]) ||
      !isCents(delta["amountCents"])
    ) {
      throw corrupt("receipt");
    }
    return {
      invoiceDueMonth: delta["invoiceDueMonth"],
      amountCents: delta["amountCents"],
    };
  });
  return {
    lines,
    participantProjectIds: [...participants],
    createdEconomicTotalCents: value["createdEconomicTotalCents"],
    bankCashDeltaCents: 0,
    invoiceDeltas,
  };
}

/**
 * Strict, allowlisting parse of the immutable receipt v1. There is NO fallback for a legacy
 * IDs-only receipt: a missing/invalid snapshot is corruption (sanitised 500), never a partial
 * success. The result is rebuilt field by field, so unknown keys can never be echoed.
 */
export function parseReceipt(
  raw: string,
  sessionId: string,
  anchorProjectId: string,
): ImportSessionReceiptV1 {
  const value = parseJson(raw, "receipt");
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RECEIPT_KEYS) ||
    value["version"] !== IMPORT_SESSION_PROTOCOL_VERSION ||
    value["sessionId"] !== sessionId ||
    typeof value["financialRequestId"] !== "string" ||
    !REQUEST_ID.test(value["financialRequestId"]) ||
    !Number.isInteger(value["confirmedRevision"]) ||
    typeof value["proposalHash"] !== "string" ||
    !HASH.test(value["proposalHash"]) ||
    typeof value["appliedAt"] !== "string" ||
    !INSTANT.test(value["appliedAt"]) ||
    // AC18: always present, nullable.
    !(
      value["continuationSessionId"] === null ||
      isId(value["continuationSessionId"])
    ) ||
    !Array.isArray(value["items"])
  ) {
    throw corrupt("receipt");
  }
  const items = value["items"].map(
    (item: unknown): ImportSessionReceiptV1["items"][number] => {
      if (
        !isRecord(item) ||
        !hasExactKeys(item, ITEM_KEYS) ||
        !isId(item["lineId"]) ||
        !RECEIPT_OUTCOMES.has(item["outcome"]) ||
        !isId(item["sourceExpenseId"]) ||
        !isIdArray(item["targetExpenseIds"]) ||
        !isIdArray(item["allocationIds"]) ||
        !isIdArray(item["cashFlowEntryIds"])
      ) {
        throw corrupt("receipt");
      }
      return {
        lineId: item["lineId"],
        outcome: item["outcome"] as "CREATED" | "KEPT_EXISTING",
        sourceExpenseId: item["sourceExpenseId"],
        targetExpenseIds: [...item["targetExpenseIds"]],
        allocationIds: [...item["allocationIds"]],
        cashFlowEntryIds: [...item["cashFlowEntryIds"]],
      };
    },
  );
  const snapshot = parseSnapshot(value["snapshot"], items, anchorProjectId);
  return {
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    sessionId: sessionId as ImportSessionId,
    financialRequestId: value["financialRequestId"],
    confirmedRevision: value["confirmedRevision"] as number,
    proposalHash: value["proposalHash"],
    appliedAt: value["appliedAt"],
    continuationSessionId: value["continuationSessionId"] as string | null,
    items,
    snapshot,
  };
}

export function effectiveState(
  row: Pick<ImportSession, "state" | "expiresAt">,
  now: Date,
): ImportSessionState {
  if (!KNOWN_STATES.has(row.state)) throw corrupt("state");
  const state = row.state as ImportSessionState;
  // Expiry is a projection: never a write from a read path.
  if (
    CANCELLABLE_STATES.has(state) &&
    now.getTime() >= row.expiresAt.getTime()
  ) {
    return ImportSessionState.EXPIRED;
  }
  return state;
}

export function confirmationOf(
  row: Pick<
    ImportSession,
    "financialRequestId" | "confirmedRevision" | "proposalHash"
  >,
): ImportSessionConfirmationRefV1 | null {
  if (
    row.financialRequestId === null ||
    row.confirmedRevision === null ||
    row.proposalHash === null
  ) {
    return null;
  }
  return {
    financialRequestId: row.financialRequestId,
    confirmedRevision: row.confirmedRevision,
    proposalHash: row.proposalHash,
  };
}

export type ProjectableSession = Readonly<ImportSession>;
export type ProjectableAttachment = Pick<
  ImportSessionArtifact,
  "id" | "fileName" | "declaredBytes" | "state" | "position"
> &
  Partial<
    Pick<
      ImportSessionArtifact,
      | "uploadGeneration"
      | "uploadLeaseExpiresAt"
      | "uploadTokenExpiresAt"
      | "temporaryPurgePending"
    >
  >;

export interface ProjectionResult {
  readonly view: ImportSessionViewV1;
}

/** Whether the projection may emit the applied receipt (only after the participant ACL gate). */
export interface ProjectionOptions {
  readonly includeReceipt: boolean;
  readonly analysisEnabled?: boolean;
  /** Broad parser support is not CSV RAW qualification while global writes are OFF. */
  readonly csvOnlyAnalysis?: boolean;
  readonly qualifiedAnalysisFormats?: readonly string[];
  readonly documentary?: {
    readonly questions: ImportSessionViewV1["questions"];
    /** Server-resolved legacy task coverage; absent only for legacy projection callers. */
    readonly coalescedQuestions?: ImportSessionViewV1["questions"];
    readonly declaredFacts: ImportSessionViewV1["declaredFacts"];
    readonly reviewBlockers: ImportSessionViewV1["reviewBlockers"];
    readonly executableAttachmentIds: readonly string[];
  };
  readonly workflow?: {
    writesEnabled: boolean;
    canMutate: boolean;
    presentedSessionVersion: number;
  };
}

export function rethrowImportSessionProjectionError(
  error: unknown,
  sessionId: ImportSessionId,
): never {
  if (error instanceof ImportSessionCorruptStateError)
    error.sessionId = sessionId;
  throw error;
}

/**
 * Explicit allowlist projection: only public fields are copied, the private columns
 * (hashes other than the public confirmation tuple, challenge, storage keys, evidence,
 * `createRequestId`, draft `scope`, tenant/owner ids) can never appear by accident.
 */
export function projectSession(
  row: ProjectableSession,
  attachments: readonly ProjectableAttachment[],
  now: Date,
  options: ProjectionOptions,
): ProjectionResult {
  try {
    return projectSessionUnchecked(row, attachments, now, options);
  } catch (error) {
    rethrowImportSessionProjectionError(error, row.id);
  }
}

function projectSessionUnchecked(
  row: ProjectableSession,
  attachments: readonly ProjectableAttachment[],
  now: Date,
  options: ProjectionOptions,
): ProjectionResult {
  const state = effectiveState(row, now);
  const hidden =
    state === "CANCELLED" || state === "EXPIRED" || state === "APPLIED";
  const terminal = hidden;

  let draft: Pick<
    ImportSessionStoredDraftV1,
    "lines" | "selectedLineIds" | "questions"
  > = {
    lines: [],
    selectedLineIds: [],
    questions: [],
  };
  let proposal: ImportSessionProposalV1 | null = null;
  let receipt: ImportSessionReceiptV1 | null = null;
  let searchComplete = false;
  let pendingAttachmentIds: readonly string[] = [];
  let analysisOutcome: ImportSessionViewV1["analysisOutcome"] = null;
  if (!hidden) {
    const documents = parseSessionDocuments(row);
    const { stored } = documents;
    pendingAttachmentIds = stored.scope.pendingAttachmentIds;
    if (
      stored.lines.length === 0 &&
      stored.scope.observationIds.length > 0 &&
      stored.scope.pendingAttachmentIds.length === 0
    ) {
      analysisOutcome = IMPORT_NO_ELIGIBLE_PURCHASES;
    }
    searchComplete = documents.searchComplete;
    draft = {
      lines: stored.lines,
      selectedLineIds: stored.selectedLineIds,
      questions: stored.questions,
    };
    proposal = documents.proposal;
  }
  if (!terminal && !options.documentary)
    throw corrupt("documentary_projection");
  // A caller without a completed participant ACL gate (cancel, recovery) never gets a receipt.
  if (state === "APPLIED" && options.includeReceipt) {
    if (row.receiptJson === null) throw corrupt("receipt");
    receipt = parseReceipt(row.receiptJson, row.id, row.ownerProjectId);
  }

  const view: ImportSessionViewV1 = {
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    analysisOutcome,
    id: row.id as ImportSessionId,
    ownerProjectId: row.ownerProjectId,
    cardId: row.cardId,
    state,
    revision: row.revision,
    expiresAt: terminal ? null : row.expiresAt.toISOString(),
    lines: draft.lines,
    selectedLineIds: draft.selectedLineIds,
    questions: terminal
      ? draft.questions
      : (options.documentary!.coalescedQuestions ?? [
          ...draft.questions,
          ...options.documentary!.questions,
        ]),
    declaredFacts: terminal ? [] : options.documentary!.declaredFacts,
    attachments: hidden
      ? []
      : attachments
          .filter((a) => a.state !== ImportSessionAttachmentState.RELEASED)
          .sort((a, b) => a.position - b.position)
          .map((a) => ({
            id: a.id,
            fileName: a.fileName,
            declaredBytes: a.declaredBytes,
            state: a.state as ImportSessionAttachmentState,
            materializedInSession:
              a.state === ImportSessionAttachmentState.ATTACHED &&
              !pendingAttachmentIds.includes(a.id),
            canAnalyze:
              !terminal &&
              a.state === ImportSessionAttachmentState.ATTACHED &&
              pendingAttachmentIds.includes(a.id) &&
              options.documentary!.executableAttachmentIds.includes(a.id),
          })),
    reviewBlockers: terminal ? [] : options.documentary!.reviewBlockers,
    searchComplete,
    proposal,
    confirmation: confirmationOf(row),
    receipt,
    actions: actionsFor(
      state,
      attachments.some(
        (ref) =>
          ref.state === ImportSessionAttachmentState.RESERVED &&
          ref.uploadGeneration === 1 &&
          ref.temporaryPurgePending === false &&
          ref.uploadLeaseExpiresAt != null &&
          ref.uploadLeaseExpiresAt.getTime() > now.getTime() &&
          ref.uploadTokenExpiresAt != null &&
          ref.uploadTokenExpiresAt.getTime() > now.getTime(),
      ),
    ),
  };
  if (view.attachments.some((attachment) => attachment.canAnalyze))
    view.actions.push("ANALYZE");
  if (options.workflow)
    view.actions.push(
      ...projectWorkflowActions(row, view, now, options.workflow),
    );
  return { view };
}

export function projectWorkflowActions(
  row: ProjectableSession,
  view: Omit<ImportSessionViewV1, "actions">,
  now: Date,
  facts: NonNullable<ProjectionOptions["workflow"]>,
): Array<"RESOLVE" | "PREPARE" | "CONFIRM" | "EXECUTE"> {
  if (
    !facts.writesEnabled ||
    !facts.canMutate ||
    row.closedAt !== null ||
    row.receiptJson !== null ||
    now.getTime() >= row.expiresAt.getTime()
  )
    return [];
  const editable =
    row.financialRequestId === null &&
    [
      ImportSessionState.DRAFT,
      ImportSessionState.ANALYZING,
      ImportSessionState.NEEDS_INPUT,
      ImportSessionState.READY,
      ImportSessionState.REVIEW_REQUIRED,
    ].some((state) => state === view.state);
  const actions: Array<"RESOLVE" | "PREPARE" | "CONFIRM" | "EXECUTE"> = [];
  const inFlight = view.attachments.some(
    (ref) =>
      ref.state === ImportSessionAttachmentState.RESERVED ||
      ref.state === ImportSessionAttachmentState.UPLOADED,
  );
  const selected =
    view.selectedLineIds.length > 0 &&
    view.selectedLineIds.length <= IMPORT_SESSION_LIMITS.selectedLines;
  if (editable) {
    actions.push("RESOLVE");
    if (
      selected &&
      !inFlight &&
      !view.reviewBlockers.some(
        (blocker) =>
          view.selectedLineIds.includes(blocker.lineId) &&
          blocker.resolution === "NEEDS_DECLARATION",
      )
    )
      actions.push("PREPARE");
  }
  const ready =
    selected &&
    !inFlight &&
    !view.reviewBlockers.some(
      (blocker) =>
        view.selectedLineIds.includes(blocker.lineId) &&
        blocker.resolution !== "RESOLVED_BY_USER",
    ) &&
    view.searchComplete &&
    !view.questions.some(
      (q) =>
        isPendingImportQuestion(q) &&
        q.lineIds.some((id) => view.selectedLineIds.includes(id)),
    ) &&
    row.preflightHash !== null &&
    HASH.test(row.preflightHash) &&
    view.proposal !== null &&
    view.proposal.proposalHash === row.proposalHash;
  if (
    ready &&
    editable &&
    view.state === ImportSessionState.READY &&
    view.confirmation === null &&
    view.proposal?.revision === row.revision
  )
    actions.push("CONFIRM");
  if (
    ready &&
    view.state === ImportSessionState.CONFIRMED &&
    row.financialRequestId !== null &&
    view.confirmation !== null &&
    row.confirmedRevision === view.proposal?.revision &&
    row.confirmedSessionVersion === facts.presentedSessionVersion
  )
    actions.push("EXECUTE");
  return actions;
}

export function actionsFor(
  state: ImportSessionState,
  canUpload = false,
): ImportSessionViewV1["actions"] {
  if (canUpload && IMPORT_SESSION_UPLOAD_EDITABLE_STATES.includes(state))
    return ["CANCEL", "UPLOAD"];
  return CANCELLABLE_STATES.has(state)
    ? ["CANCEL"]
    : state === "APPLIED"
      ? ["READ_RESULT"]
      : [];
}

/** Columns the recovery list reads. `receiptJson` is selected only for APPLIED rows. */
export interface SummaryColumns {
  readonly id: string;
  readonly state: string;
  readonly revision: number;
  readonly cardId: string;
  readonly ownerProjectId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly hasConfirmation: boolean;
  readonly receiptJson: string | null;
}

/**
 * Summary of one recovery-list row: columns only, no OCR/evidence/file names/private hashes,
 * and the draft is never parsed. An APPLIED row is projected only through the strict receipt
 * parser (its `appliedAt`/`continuationSessionId` come from a validated receipt): a broken one
 * is a sanitised 500, never an omission.
 */
export function projectSummary(
  row: SummaryColumns,
  attachmentCount: number,
): ImportSessionSummaryV1 {
  try {
    if (!KNOWN_STATES.has(row.state)) throw corrupt("state");
    const state = row.state as ImportSessionState;
    let appliedAt: string | null = null;
    let continuationSessionId: string | null = null;
    if (state === ImportSessionState.APPLIED) {
      if (row.receiptJson === null) throw corrupt("receipt");
      const receipt = parseReceipt(row.receiptJson, row.id, row.ownerProjectId);
      appliedAt = receipt.appliedAt;
      continuationSessionId = receipt.continuationSessionId;
    }
    const terminal =
      state === ImportSessionState.APPLIED ||
      state === ImportSessionState.CANCELLED ||
      state === ImportSessionState.EXPIRED;
    return {
      id: row.id as ImportSessionId,
      state,
      revision: row.revision,
      cardId: row.cardId,
      ownerProjectId: row.ownerProjectId,
      createdAt: row.createdAt.toISOString(),
      expiresAt: terminal ? null : row.expiresAt.toISOString(),
      appliedAt,
      attachmentCount,
      hasConfirmation: row.hasConfirmation,
      continuationSessionId,
      actions: actionsFor(state),
    };
  } catch (error) {
    rethrowImportSessionProjectionError(error, row.id);
  }
}
