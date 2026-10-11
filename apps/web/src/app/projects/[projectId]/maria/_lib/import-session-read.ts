import {
  IMPORT_CHAT_CHANNEL,
  IMPORT_SESSION_LIMITS as L,
  IMPORT_SESSION_PRIMITIVES as P,
  ImportSessionAttachmentState,
  ImportSessionState,
  isInvoiceDueMonth,
  parseExpenseSchedule,
  parseInstallmentDateOnlyUtc,
  normalizeImportDeclaration,
  type ImportDeclarationContextV1,
  type ImportDeclaredFactViewV1,
  type ImportObservationQuestionV1,
  type ImportSessionDraftFieldV1,
  type ImportSessionDraftLineV1,
  type ImportSessionEntryV1,
  type ImportSessionPageV1,
  type ImportSessionQuestionV1,
  type ImportSessionReceiptLineSnapshotV1,
  type ImportSessionReceiptV1,
  type ImportSessionSummaryV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { isSupportedImportFormats } from "./import-entry-action";

/**
 * What the recovery UI actually reads, validated field by field before it reaches a component.
 * The projections are typed (`Pick`) so nothing claims a field this reader never checks: the
 * private-side parts of the session (proposal, confirmation) are not part of them.
 * Documentary facts are optional only in this reduced read; the full-view reader requires them.
 */
export type ImportViewRead = Pick<
  ImportSessionViewV1,
  | "id"
  | "ownerProjectId"
  | "cardId"
  | "state"
  | "revision"
  | "expiresAt"
  | "actions"
  | "attachments"
  | "selectedLineIds"
  | "reviewBlockers"
> &
  Partial<Pick<ImportSessionViewV1, "declaredFacts">> & {
    questions: Array<Pick<ImportSessionQuestionV1, "id" | "text">>;
    lines: Array<
      Pick<
        ImportSessionDraftLineV1,
        | "id"
        | "titulo"
        | "amountMeaning"
        | "amountCents"
        | "installmentCount"
        | "dataCompra"
      >
    >;
  };

export type ImportReceiptRead = Pick<
  ImportSessionReceiptV1,
  "appliedAt" | "continuationSessionId"
> & {
  items: Array<
    Pick<ImportSessionReceiptV1["items"][number], "lineId" | "outcome">
  >;
  snapshot: Pick<
    ImportSessionReceiptV1["snapshot"],
    | "lines"
    | "invoiceDeltas"
    | "createdEconomicTotalCents"
    | "bankCashDeltaCents"
  >;
};

export interface ImportResultRead {
  state: ImportSessionState;
  receipt: ImportReceiptRead | null;
}

export type ImportEntryRead =
  | { kind: "VALID"; value: ImportSessionEntryV1 }
  | { kind: "ERROR"; code: "MISSING_ENTRY" | "INVALID_ENTRY" };
export interface ImportListRead {
  page: ImportSessionPageV1<ImportSessionSummaryV1>;
  entry: ImportEntryRead;
}
export interface ImportEntryCard {
  id: string;
  nickname: string | null;
  last4: string;
  /**
   * Required in the authenticated card-choice response; nullable when the user
   * has not configured the corresponding statement-cycle day.
   */
  closingDay: number | null;
  dueDay: number | null;
  project: { id: string; name: string };
}
export const IMPORT_ENTRY_ERROR =
  "Não foi possível verificar a disponibilidade de novas importações. Suas importações guardadas continuam disponíveis.";

export function readImportEntry(
  value: Record<string, unknown>,
): ImportEntryRead {
  if (!Object.hasOwn(value, "entry"))
    return { kind: "ERROR", code: "MISSING_ENTRY" };
  const entry = value.entry;
  if (isRecord(entry)) {
    if (entry.kind === "UNAVAILABLE")
      return { kind: "VALID", value: { kind: "UNAVAILABLE" } };
    const formats = entry.formats;
    if (entry.kind === "CARD_INVOICE" && isSupportedImportFormats(formats))
      return { kind: "VALID", value: { kind: "CARD_INVOICE", formats } };
  }
  return { kind: "ERROR", code: "INVALID_ENTRY" };
}

export function isImportEntryCards(value: unknown): value is ImportEntryCard[] {
  const validDay = (day: unknown): day is number | null =>
    day === null ||
    (typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 31);
  return (
    Array.isArray(value) &&
    Array.from(value).every(
      (card) =>
        isRecord(card) &&
        isId(card.id) &&
        (card.nickname === null || typeof card.nickname === "string") &&
        typeof card.last4 === "string" &&
        /^\d{4}$/.test(card.last4) &&
        validDay(card.closingDay) &&
        validDay(card.dueDay) &&
        isRecord(card.project) &&
        isId(card.project.id) &&
        typeof card.project.name === "string" &&
        card.project.name.trim().length > 0,
    ) &&
    new Set(value.map((card) => card.id)).size === value.length
  );
}

const STATES: ReadonlySet<string> = new Set(Object.values(ImportSessionState));
const ACTIONS: ReadonlySet<string> = new Set([
  "UPLOAD",
  "RESOLVE",
  "PREPARE",
  "CONFIRM",
  "EXECUTE",
  "CANCEL",
  "READ_RESULT",
]);
const MEANINGS: ReadonlySet<string> = new Set([
  "TOTAL_PURCHASE",
  "INSTALLMENT_CHARGE",
  "UNKNOWN",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);
const isCents = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const isState = (value: unknown): value is ImportSessionState =>
  isString(value) && STATES.has(value);
const isActions = (value: unknown): value is ImportSessionViewV1["actions"] =>
  Array.isArray(value) &&
  value.every((action) => isString(action) && ACTIONS.has(action));
const isWorkflowActions = (
  value: unknown,
): value is ImportSessionViewV1["actions"] =>
  Array.isArray(value) &&
  value.every(
    (action) =>
      isString(action) && (action === "ANALYZE" || ACTIONS.has(action)),
  );
const every = <T>(
  value: unknown,
  guard: (item: unknown) => item is T,
): value is T[] => Array.isArray(value) && value.every(guard);

/** Only the parser's RangeError means "invalid shape"; anything else is a real failure and propagates. */
function hasValidSchedule(value: unknown): boolean {
  try {
    parseExpenseSchedule(value);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export function isSummary(value: unknown): value is ImportSessionSummaryV1 {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isState(value.state) &&
    isCents(value.revision) &&
    isString(value.cardId) &&
    isString(value.ownerProjectId) &&
    isString(value.createdAt) &&
    isNullableString(value.expiresAt) &&
    isNullableString(value.appliedAt) &&
    isCents(value.attachmentCount) &&
    typeof value.hasConfirmation === "boolean" &&
    isNullableString(value.continuationSessionId) &&
    isWorkflowActions(value.actions)
  );
}

export function isSummaryPage(
  value: unknown,
): value is ImportSessionPageV1<ImportSessionSummaryV1> {
  return (
    isRecord(value) &&
    every(value.items, isSummary) &&
    isNullableString(value.nextCursor)
  );
}

const isId = (value: unknown): value is string =>
  isString(value) && new RegExp(P.idPattern).test(value);

export function isImportAttachment(
  value: unknown,
): value is ImportSessionViewV1["attachments"][number] {
  const keys = [
    "id",
    "fileName",
    "declaredBytes",
    "state",
    "materializedInSession",
    "canAnalyze",
  ];
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    isId(value.id) &&
    isString(value.fileName) &&
    value.fileName.normalize("NFC") === value.fileName &&
    value.fileName.length >= 1 &&
    value.fileName.length <= P.maxFileNameLength &&
    isCents(value.declaredBytes) &&
    value.declaredBytes >= 1 &&
    value.declaredBytes <= L.bytesPerFile &&
    Object.values(ImportSessionAttachmentState).some(
      (state) => state === value.state,
    ) &&
    typeof value.materializedInSession === "boolean" &&
    typeof value.canAnalyze === "boolean" &&
    (!value.materializedInSession ||
      (value.state === "ATTACHED" && !value.canAnalyze)) &&
    (!value.canAnalyze ||
      (value.state === "ATTACHED" && !value.materializedInSession))
  );
}

export function isImportReviewBlockers(
  value: unknown,
): value is ImportSessionViewV1["reviewBlockers"] {
  return every(
    value,
    (blocker): blocker is ImportSessionViewV1["reviewBlockers"][number] =>
      isRecord(blocker) &&
      Object.keys(blocker).length === 3 &&
      isId(blocker.lineId) &&
      (blocker.resolution === "NEEDS_DECLARATION" ||
        blocker.resolution === "RESOLVED_BY_USER" ||
        blocker.resolution === "SEARCH_IDENTITY_UNAVAILABLE") &&
      (blocker.code === "ORIGINAL_IDENTITY_INCOMPLETE" ||
        blocker.code === "ORIGINAL_OCCURRENCE_INCOMPLETE"),
  );
}

export function hasImportDocumentFacts(
  view: Pick<
    ImportViewRead,
    | "attachments"
    | "actions"
    | "reviewBlockers"
    | "lines"
    | "selectedLineIds"
    | "state"
  >,
): boolean {
  return (
    (!view.actions.includes("ANALYZE") ||
      view.attachments.some((a) => a.canAnalyze)) &&
    view.reviewBlockers.every((blocker) =>
      view.lines.some((line) => line.id === blocker.lineId),
    ) &&
    view.selectedLineIds.every((id) =>
      view.lines.some((line) => line.id === id),
    ) &&
    (!["APPLIED", "CANCELLED", "EXPIRED"].includes(view.state) ||
      view.reviewBlockers.length === 0)
  );
}
export const IMPORT_DRAFT_QUESTION_FIELDS: readonly ImportSessionDraftFieldV1[] =
  [
    "amountMeaning",
    "amountCents",
    "installmentCount",
    "dataCompra",
    "firstDueDate",
    "targets",
    "decision",
    "tipoDespesa",
    "categoriaMaoDeObra",
  ];
const HUMAN_FIELDS = [
  "dataCompra",
  "merchant",
  "amountMeaning",
  "amountCents",
  "installmentCount",
  "installmentIndex",
];
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const isHumanMeaning = (value: unknown) =>
  value === "TOTAL_PURCHASE" || value === "INSTALLMENT_CHARGE";
const hasHumanContext = (value: Record<string, unknown>) =>
  isString(value.field) &&
  HUMAN_FIELDS.includes(value.field) &&
  (value.field === "amountCents"
    ? isHumanMeaning(value.meaningContext)
    : value.meaningContext === null);

export function importDeclarationContext(
  question: ImportObservationQuestionV1,
  declaredFacts: readonly ImportDeclaredFactViewV1[] | null = null,
): ImportDeclarationContextV1 {
  const count = declaredFacts?.find(
    (fact) =>
      fact.field === "installmentCount" &&
      fact.status === "CURRENT" &&
      fact.lineId === question.lineIds[0] &&
      fact.observationId === question.subject.observationId,
  );
  const effectiveInstallmentCount =
    count?.field === "installmentCount" && count.status === "CURRENT"
      ? count.value
      : null;
  return question.field === "amountCents"
    ? {
        field: question.field,
        meaningContext: question.subject.meaningContext,
        effectiveInstallmentCount,
      }
    : {
        field: question.field,
        meaningContext: null,
        effectiveInstallmentCount,
      };
}

export function isImportQuestion(
  value: unknown,
): value is ImportSessionQuestionV1 {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isString(value.text) ||
    value.text.normalize("NFC") !== value.text ||
    !value.text.length ||
    value.text.length > P.maxQuestionLength ||
    !every(value.lineIds, isId) ||
    !value.lineIds.length ||
    value.lineIds.length > L.editableLines ||
    new Set(value.lineIds).size !== value.lineIds.length
  )
    return false;
  if (!Object.hasOwn(value, "subject"))
    return (
      exact(value, ["id", "lineIds", "field", "text"]) &&
      IMPORT_DRAFT_QUESTION_FIELDS.some((field) => field === value.field)
    );
  return (
    exact(value, [
      "id",
      "lineIds",
      "field",
      "text",
      "subject",
      "answerState",
    ]) &&
    value.lineIds.length === 1 &&
    isRecord(value.subject) &&
    exact(value.subject, ["kind", "observationId", "meaningContext"]) &&
    value.subject.kind === "OBSERVATION" &&
    isId(value.subject.observationId) &&
    hasHumanContext({
      field: value.field,
      meaningContext: value.subject.meaningContext,
    }) &&
    (value.answerState === "UNANSWERED" ||
      value.answerState === "DECLARED" ||
      value.answerState === "UNKNOWN")
  );
}

export function isImportDeclaredFact(
  value: unknown,
): value is ImportDeclaredFactViewV1 {
  if (
    !isRecord(value) ||
    !exact(value, [
      "lineId",
      "observationId",
      "questionId",
      "field",
      "value",
      "meaningContext",
      "origin",
      "status",
      ...(Object.hasOwn(value, "channel") ? ["channel"] : []),
    ]) ||
    !isId(value.lineId) ||
    !isId(value.observationId) ||
    !isId(value.questionId) ||
    value.origin !== "USER_ATTESTATION" ||
    (Object.hasOwn(value, "channel") &&
      !Object.values(IMPORT_CHAT_CHANNEL).some(
        (channel) => channel === value.channel,
      )) ||
    !hasHumanContext(value)
  )
    return false;
  if (value.status === "UNKNOWN") return value.value === null;
  if (
    value.status !== "CURRENT" &&
    !(value.status === "CONTEXT_CHANGED" && value.field === "amountCents")
  )
    return false;
  switch (value.field) {
    case "amountCents":
      return (
        isCents(value.value) &&
        value.value >= P.minPurchaseCents &&
        value.value <= P.maxCents
      );
    case "installmentCount":
    case "installmentIndex":
      return (
        isCents(value.value) &&
        value.value >= 1 &&
        value.value <= L.installmentsPerPurchase
      );
    case "amountMeaning":
      return isHumanMeaning(value.value);
    case "dataCompra": {
      if (!isString(value.value)) return false;
      const date = parseInstallmentDateOnlyUtc(value.value);
      return (
        date !== null &&
        date.getUTCFullYear() >= P.minYear &&
        date.getUTCFullYear() <= P.maxYear
      );
    }
    case "merchant": {
      if (!isString(value.value)) return false;
      const normalized = normalizeImportDeclaration(
        {
          field: "merchant",
          meaningContext: null,
          effectiveInstallmentCount: null,
        },
        { kind: "VALUE", text: value.value },
      );
      return (
        normalized.kind === "VALID" && normalized.answer.value === value.value
      );
    }
    default:
      return false;
  }
}

export function hasImportDeclarationBindings(
  view: Pick<ImportSessionViewV1, "lines" | "questions" | "declaredFacts">,
): boolean {
  return (
    view.questions.every(
      (question) =>
        question.lineIds.every((id) =>
          view.lines.some((line) => line.id === id),
        ) &&
        (!("subject" in question) ||
          view.lines.some(
            (line) =>
              line.id === question.lineIds[0] &&
              line.observationIds.includes(question.subject.observationId),
          )),
    ) &&
    view.declaredFacts.every((fact) => {
      const line = view.lines.find((line) => line.id === fact.lineId);
      if (!line?.observationIds.includes(fact.observationId)) return false;
      return view.questions.some(
        (question) =>
          "subject" in question &&
          question.id === fact.questionId &&
          question.lineIds[0] === fact.lineId &&
          question.field === fact.field &&
          question.subject.observationId === fact.observationId &&
          (fact.status === "CONTEXT_CHANGED"
            ? question.field === "amountCents" &&
              question.subject.meaningContext !== fact.meaningContext
            : question.subject.meaningContext === fact.meaningContext &&
              question.answerState ===
                (fact.status === "CURRENT" ? "DECLARED" : "UNKNOWN")),
      );
    })
  );
}
function isDraftLine(value: unknown): value is ImportViewRead["lines"][number] {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.titulo) &&
    isString(value.amountMeaning) &&
    MEANINGS.has(value.amountMeaning) &&
    (value.amountCents === null || isCents(value.amountCents)) &&
    (value.installmentCount === null || isCents(value.installmentCount)) &&
    isNullableString(value.dataCompra)
  );
}

export function isViewRead(value: unknown): value is ImportViewRead {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.ownerProjectId) &&
    isString(value.cardId) &&
    isState(value.state) &&
    isCents(value.revision) &&
    isNullableString(value.expiresAt) &&
    isWorkflowActions(value.actions) &&
    every(value.attachments, isImportAttachment) &&
    value.attachments.length <= L.filesPerSession &&
    new Set(value.attachments.map((a) => a.id)).size ===
      value.attachments.length &&
    value.attachments.reduce((sum, a) => sum + a.declaredBytes, 0) <=
      L.bytesPerSession &&
    every(value.selectedLineIds, isId) &&
    value.selectedLineIds.length <= L.selectedLines &&
    new Set(value.selectedLineIds).size === value.selectedLineIds.length &&
    isImportReviewBlockers(value.reviewBlockers) &&
    every(
      value.questions,
      (question): question is ImportViewRead["questions"][number] =>
        isRecord(question) &&
        isString(question.id) &&
        isString(question.text) &&
        (!Object.hasOwn(question, "subject") || isImportQuestion(question)),
    ) &&
    (!Object.hasOwn(value, "declaredFacts") ||
      every(value.declaredFacts, isImportDeclaredFact)) &&
    every(value.lines, isDraftLine) &&
    hasImportDocumentFacts({
      attachments: value.attachments,
      actions: value.actions,
      reviewBlockers: value.reviewBlockers,
      lines: value.lines,
      selectedLineIds: value.selectedLineIds,
      state: value.state,
    })
  );
}

function isReceiptLine(
  value: unknown,
): value is ImportSessionReceiptLineSnapshotV1 {
  return (
    isRecord(value) &&
    isString(value.lineId) &&
    isNullableString(value.titulo) &&
    isNullableString(value.dataCompra) &&
    isCents(value.totalCents) &&
    isString(value.sourceProjectId) &&
    every(
      value.targets,
      (target): target is { projectId: string; amountCents: number } =>
        isRecord(target) &&
        isString(target.projectId) &&
        isCents(target.amountCents),
    ) &&
    hasValidSchedule(value.schedule)
  );
}

export function isReceiptRead(value: unknown): value is ImportReceiptRead {
  if (
    !isRecord(value) ||
    !isString(value.appliedAt) ||
    !isNullableString(value.continuationSessionId)
  )
    return false;
  const { items, snapshot } = value;
  return (
    every(
      items,
      (item): item is ImportReceiptRead["items"][number] =>
        isRecord(item) &&
        isString(item.lineId) &&
        (item.outcome === "CREATED" || item.outcome === "KEPT_EXISTING"),
    ) &&
    isRecord(snapshot) &&
    every(snapshot.lines, isReceiptLine) &&
    isCents(snapshot.createdEconomicTotalCents) &&
    snapshot.bankCashDeltaCents === 0 && // literal in the contract: an import never moves the bank
    every(
      snapshot.invoiceDeltas,
      (delta): delta is { invoiceDueMonth: string; amountCents: number } =>
        isRecord(delta) &&
        isInvoiceDueMonth(delta.invoiceDueMonth) &&
        isCents(delta.amountCents),
    )
  );
}

export function isResultRead(value: unknown): value is ImportResultRead {
  return (
    isRecord(value) &&
    isState(value.state) &&
    (value.receipt === null || isReceiptRead(value.receipt))
  );
}
