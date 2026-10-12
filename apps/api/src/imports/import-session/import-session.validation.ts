import {
  ExpenseType,
  LaborCategory,
  CARD_IMPORT_IGNORED_REASON,
  IMPORT_SESSION_AUDIT_OUTCOME,
  IMPORT_SESSION_KIND,
  IMPORT_SESSION_LIMITS as LIMITS,
  IMPORT_SESSION_PRIMITIVES as PRIMITIVES,
  IMPORT_SESSION_PROTOCOL_VERSION,
  ImportSessionAmountMeaning,
  isInvoiceDueMonth,
  parseExpenseSchedule,
  parseInstallmentDateOnlyUtc,
  type ImportSessionDecisionV1,
  type ImportSessionDraftLineV1,
  type ImportSessionProposalV1,
  type ImportSessionDraftQuestionV1,
  type ImportSessionStoredDraftV1,
  type ImportSessionTargetInputV1,
  type ImportStoredDeclarationV1,
} from "@reformaflow/domain";
import { ImportSessionCorruptStateError } from "./import-session.errors";

const ID = new RegExp(PRIMITIVES.idPattern);
const HASH = new RegExp(PRIMITIVES.hashPattern);
const INSTANT = new RegExp(PRIMITIVES.instantPattern);
const QUESTION_FIELDS: readonly ImportSessionDraftQuestionV1["field"][] = [
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
const DRAFT_LINE_KEYS = [
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
];
const PROPOSAL_KEYS = [
  "version",
  "kind",
  "sessionId",
  "revision",
  "proposalHash",
  "lines",
  "auditItems",
  "deferredObservationIds",
  "deferredAttachmentIds",
  "retainUntil",
  "createdEconomicTotalCents",
  "bankCashDeltaCents",
  "invoiceDeltas",
];
const HISTORICAL_PROPOSAL_KEYS = PROPOSAL_KEYS.filter(
  (key) => key !== "auditItems",
);
const AUDIT_ITEM_KEYS = [
  "observationId",
  "outcome",
  "reason",
  "title",
  "amountCents",
];

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const id = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;
const cents = (value: unknown): value is number =>
  integer(value, PRIMITIVES.minCents, PRIMITIVES.maxCents);
const purchaseCents = (value: unknown): value is number =>
  integer(value, PRIMITIVES.minPurchaseCents, PRIMITIVES.maxCents);
const text = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" &&
  value.normalize("NFC") === value &&
  value.length >= min &&
  value.length <= max;
const ids = (value: unknown, min: number, max: number): value is string[] =>
  Array.isArray(value) &&
  value.length >= min &&
  value.length <= max &&
  value.every(id) &&
  new Set(value).size === value.length;
const oneOf = <T extends string>(
  value: unknown,
  values: readonly T[],
): value is T =>
  typeof value === "string" && values.some((member) => member === value);
const dateOnly = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const date = parseInstallmentDateOnlyUtc(value);
  return (
    date !== null &&
    date.getUTCFullYear() >= PRIMITIVES.minYear &&
    date.getUTCFullYear() <= PRIMITIVES.maxYear
  );
};
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  INSTANT.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const distinct = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

function decision(value: unknown): value is ImportSessionDecisionV1 {
  if (!record(value)) return false;
  switch (value["kind"]) {
    case "UNRESOLVED":
      return exact(value, ["kind"]);
    case "CREATE":
      return (
        exact(value, ["kind", "acceptNaturalDuplicate"]) &&
        typeof value["acceptNaturalDuplicate"] === "boolean"
      );
    case "KEEP_EXISTING":
      return exact(value, ["kind", "expenseId"]) && id(value["expenseId"]);
    default:
      return false;
  }
}

function target(value: unknown): value is ImportSessionTargetInputV1 {
  return (
    record(value) &&
    exact(value, ["projectId", "roomId", "amountCents"]) &&
    id(value["projectId"]) &&
    (value["roomId"] === null || id(value["roomId"])) &&
    purchaseCents(value["amountCents"])
  );
}

function draftLine(value: unknown): value is ImportSessionDraftLineV1 {
  return (
    record(value) &&
    exact(value, DRAFT_LINE_KEYS) &&
    id(value["id"]) &&
    ids(value["observationIds"], 1, LIMITS.observationsPerLine) &&
    text(value["titulo"], 1, PRIMITIVES.maxTitleLength) &&
    (value["fornecedor"] === null ||
      text(value["fornecedor"], 0, PRIMITIVES.maxSupplierLength)) &&
    (value["tipoDespesa"] === null ||
      oneOf(value["tipoDespesa"], Object.values(ExpenseType))) &&
    (value["categoriaMaoDeObra"] === null ||
      oneOf(value["categoriaMaoDeObra"], Object.values(LaborCategory))) &&
    oneOf(value["amountMeaning"], Object.values(ImportSessionAmountMeaning)) &&
    (value["amountCents"] === null || cents(value["amountCents"])) &&
    (value["installmentCount"] === null ||
      integer(value["installmentCount"], 1, LIMITS.installmentsPerPurchase)) &&
    (value["dataCompra"] === null || dateOnly(value["dataCompra"])) &&
    (value["firstDueDate"] === null || dateOnly(value["firstDueDate"])) &&
    (value["targets"] === null ||
      (Array.isArray(value["targets"]) &&
        value["targets"].length <= LIMITS.targetsPerPurchase &&
        value["targets"].every(target) &&
        distinct(value["targets"].map((item) => item.projectId)))) &&
    decision(value["decision"])
  );
}

function question(value: unknown): value is ImportSessionDraftQuestionV1 {
  return (
    record(value) &&
    exact(value, ["id", "lineIds", "field", "text"]) &&
    id(value["id"]) &&
    ids(value["lineIds"], 1, LIMITS.editableLines) &&
    oneOf(value["field"], QUESTION_FIELDS) &&
    text(value["text"], 1, PRIMITIVES.maxQuestionLength)
  );
}

function declaration(value: unknown): value is ImportStoredDeclarationV1 {
  const keys = [
    "field",
    "value",
    "meaningContext",
    "lineId",
    "observationId",
    "originalFingerprint",
    "claimVersion",
    "originSessionId",
    "recordedRevision",
    "questionId",
    "turnId",
    "attestedByUserId",
    "attestedAt",
    "literalHash",
  ];
  if (
    !record(value) ||
    !(exact(value, keys) || exact(value, [...keys, "channel"])) ||
    (Object.prototype.hasOwnProperty.call(value, "channel") &&
      value.channel !== "TEXT" &&
      value.channel !== "VOICE") ||
    !id(value.lineId) ||
    !id(value.observationId) ||
    !id(value.originSessionId) ||
    !id(value.questionId) ||
    !id(value.attestedByUserId) ||
    typeof value.originalFingerprint !== "string" ||
    !HASH.test(value.originalFingerprint) ||
    typeof value.literalHash !== "string" ||
    !HASH.test(value.literalHash) ||
    typeof value.turnId !== "string" ||
    !new RegExp(PRIMITIVES.requestIdPattern).test(value.turnId) ||
    !integer(value.claimVersion, 0, PRIMITIVES.maxRevision) ||
    !integer(
      value.recordedRevision,
      PRIMITIVES.minRevision,
      PRIMITIVES.maxRevision,
    ) ||
    !instant(value.attestedAt) ||
    (value.field === "amountCents"
      ? !oneOf(value.meaningContext, ["TOTAL_PURCHASE", "INSTALLMENT_CHARGE"])
      : value.meaningContext !== null)
  )
    return false;
  switch (value.field) {
    case "amountCents":
      return value.value === null || purchaseCents(value.value);
    case "installmentCount":
    case "installmentIndex":
      return (
        value.value === null ||
        integer(value.value, 1, LIMITS.installmentsPerPurchase)
      );
    case "amountMeaning":
      return (
        value.value === null ||
        oneOf(value.value, ["TOTAL_PURCHASE", "INSTALLMENT_CHARGE"])
      );
    case "dataCompra":
      return value.value === null || dateOnly(value.value);
    case "merchant":
      return (
        value.value === null ||
        (typeof value.value === "string" &&
          value.value.trim() === value.value &&
          value.value.length >= 1 &&
          value.value.length <= PRIMITIVES.maxSupplierLength &&
          !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value.value))
      );
    default:
      return false;
  }
}

export function validateStoredDraft(
  value: unknown,
): ImportSessionStoredDraftV1 {
  const corrupt = () => new ImportSessionCorruptStateError("draft");
  if (
    !record(value) ||
    !exact(value, [
      "version",
      "lines",
      "selectedLineIds",
      "questions",
      "scope",
      ...(Object.prototype.hasOwnProperty.call(value, "declarations")
        ? ["declarations"]
        : []),
    ]) ||
    value["version"] !== IMPORT_SESSION_PROTOCOL_VERSION ||
    !Array.isArray(value["lines"]) ||
    value["lines"].length > LIMITS.editableLines ||
    !value["lines"].every(draftLine) ||
    !ids(value["selectedLineIds"], 0, LIMITS.selectedLines) ||
    !Array.isArray(value["questions"]) ||
    !value["questions"].every(question) ||
    !record(value["scope"]) ||
    !exact(value["scope"], ["observationIds", "pendingAttachmentIds"]) ||
    !ids(value["scope"]["observationIds"], 0, LIMITS.parsedRowsPerSession) ||
    !ids(value["scope"]["pendingAttachmentIds"], 0, LIMITS.filesPerSession)
  )
    throw corrupt();
  let declarations: ImportSessionStoredDraftV1["declarations"];
  if (Object.prototype.hasOwnProperty.call(value, "declarations")) {
    const extension = value.declarations;
    if (
      !record(extension) ||
      !exact(extension, ["version", "items"]) ||
      extension.version !== 1 ||
      !Array.isArray(extension.items) ||
      extension.items.length >
        LIMITS.editableLines * LIMITS.observationsPerLine * 6 ||
      !extension.items.every(declaration)
    )
      throw corrupt();
    declarations = { version: 1, items: extension.items };
  }
  const lines = value["lines"];
  const lineIds = new Set(lines.map((line) => line.id));
  const scope = {
    observationIds: value["scope"]["observationIds"],
    pendingAttachmentIds: value["scope"]["pendingAttachmentIds"],
  };
  const observations = new Set(scope["observationIds"]);
  const selected = new Set(value["selectedLineIds"]);
  if (
    lineIds.size !== lines.length ||
    !distinct(value["questions"].map((item) => item.id)) ||
    value["selectedLineIds"].some((item) => !lineIds.has(item)) ||
    value["questions"].some((item) =>
      item.lineIds.some((lineId) => !lineIds.has(lineId)),
    ) ||
    lines.some((line) =>
      line.observationIds.some((item) => !observations.has(item)),
    ) ||
    (declarations !== undefined &&
      (!distinct(
        declarations.items.map((item) =>
          JSON.stringify([item.lineId, item.observationId, item.field]),
        ),
      ) ||
        declarations.items.some(
          (item) =>
            !lines.some(
              (line) =>
                line.id === item.lineId &&
                line.observationIds.includes(item.observationId),
            ),
        ))) ||
    !distinct(
      lines
        .filter((line) => selected.has(line.id))
        .flatMap((line) => line.observationIds),
    )
  )
    throw corrupt();
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    LIMITS.jsonBytesPerDraftOrProposal
  )
    throw corrupt();
  return {
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    lines,
    selectedLineIds: value["selectedLineIds"],
    questions: value["questions"],
    ...(declarations === undefined ? {} : { declarations }),
    scope: {
      observationIds: scope["observationIds"],
      pendingAttachmentIds: scope["pendingAttachmentIds"],
    },
  };
}

type PlannedLine = ImportSessionProposalV1["lines"][number];
function scheduleMatches(
  value: unknown,
  total: number,
  creating = false,
): boolean {
  try {
    const schedule = parseExpenseSchedule(value);
    return (
      (!creating ||
        (schedule.occurrences.length <= LIMITS.installmentsPerPurchase &&
          schedule.occurrences.every(
            (item) => item.invoiceDueMonth !== null,
          ))) &&
      schedule.occurrences.reduce((sum, item) => sum + item.valor, 0) === total
    );
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function plannedLine(value: unknown): value is PlannedLine {
  if (!record(value) || !id(value["lineId"]) || !cents(value["totalCents"]))
    return false;
  if (value["kind"] === "KEEP_EXISTING") {
    return (
      exact(value, [
        "kind",
        "lineId",
        "sourceExpenseId",
        "totalCents",
        "schedule",
      ]) &&
      id(value["sourceExpenseId"]) &&
      scheduleMatches(value["schedule"], value["totalCents"])
    );
  }
  if (
    value["kind"] !== "CREATE" ||
    !exact(value, [
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
    ]) ||
    !purchaseCents(value["totalCents"]) ||
    !text(value["titulo"], 1, PRIMITIVES.maxTitleLength) ||
    !(
      value["fornecedor"] === null ||
      text(value["fornecedor"], 0, PRIMITIVES.maxSupplierLength)
    ) ||
    !oneOf(value["tipoDespesa"], Object.values(ExpenseType)) ||
    !(
      value["categoriaMaoDeObra"] === null ||
      oneOf(value["categoriaMaoDeObra"], Object.values(LaborCategory))
    ) ||
    !dateOnly(value["dataCompra"]) ||
    !Array.isArray(value["targets"]) ||
    value["targets"].length > LIMITS.targetsPerPurchase ||
    !scheduleMatches(value["schedule"], value["totalCents"], true)
  )
    return false;
  const targets = value["targets"];
  if (
    !targets.every((item: unknown): item is ImportSessionTargetInputV1 => {
      if (
        !record(item) ||
        !exact(item, ["projectId", "roomId", "amountCents", "schedule"])
      )
        return false;
      return (
        target({
          projectId: item["projectId"],
          roomId: item["roomId"],
          amountCents: item["amountCents"],
        }) &&
        typeof item["amountCents"] === "number" &&
        scheduleMatches(item["schedule"], item["amountCents"], true)
      );
    })
  )
    return false;
  return (
    distinct(targets.map((item) => item.projectId)) &&
    (targets.length === 0 ||
      targets.reduce((sum, item) => sum + item.amountCents, 0) ===
        value["totalCents"])
  );
}

function invoiceDelta(
  value: unknown,
): value is ImportSessionProposalV1["invoiceDeltas"][number] {
  return (
    record(value) &&
    exact(value, ["invoiceDueMonth", "amountCents"]) &&
    isInvoiceDueMonth(value["invoiceDueMonth"]) &&
    cents(value["amountCents"])
  );
}

function ignoredAuditItem(
  value: unknown,
): value is ImportSessionProposalV1["auditItems"][number] {
  return (
    record(value) &&
    exact(value, AUDIT_ITEM_KEYS) &&
    id(value["observationId"]) &&
    value["outcome"] === IMPORT_SESSION_AUDIT_OUTCOME.IGNORED &&
    value["reason"] === CARD_IMPORT_IGNORED_REASON.INVOICE_PAYMENT &&
    text(value["title"], 1, PRIMITIVES.maxTitleLength) &&
    (value["amountCents"] === null ||
      integer(value["amountCents"], PRIMITIVES.minCents, -1))
  );
}

export function validateProposal(
  value: unknown,
  sessionId: string,
  proposalHash: string | null,
): ImportSessionProposalV1 {
  const corrupt = () => new ImportSessionCorruptStateError("proposal");
  if (
    !record(value) ||
    !(exact(value, PROPOSAL_KEYS) || exact(value, HISTORICAL_PROPOSAL_KEYS)) ||
    value["version"] !== IMPORT_SESSION_PROTOCOL_VERSION ||
    value["kind"] !== IMPORT_SESSION_KIND ||
    !id(value["sessionId"]) ||
    value["sessionId"] !== sessionId ||
    !integer(
      value["revision"],
      PRIMITIVES.minRevision,
      PRIMITIVES.maxRevision,
    ) ||
    typeof value["proposalHash"] !== "string" ||
    !HASH.test(value["proposalHash"]) ||
    (proposalHash !== null && proposalHash !== value["proposalHash"]) ||
    !Array.isArray(value["lines"]) ||
    value["lines"].length === 0 ||
    value["lines"].length > LIMITS.selectedLines ||
    !value["lines"].every(plannedLine) ||
    !(
      value["auditItems"] === undefined ||
      (Array.isArray(value["auditItems"]) &&
        value["auditItems"].every(ignoredAuditItem) &&
        distinct(
          value["auditItems"].map(
            (item: ImportSessionProposalV1["auditItems"][number]) =>
              item.observationId,
          ),
        ))
    ) ||
    !ids(value["deferredObservationIds"], 0, LIMITS.parsedRowsPerSession) ||
    !ids(value["deferredAttachmentIds"], 0, LIMITS.filesPerSession) ||
    !(value["retainUntil"] === null || instant(value["retainUntil"])) ||
    !integer(value["createdEconomicTotalCents"], 0, PRIMITIVES.maxCents) ||
    value["bankCashDeltaCents"] !== 0 ||
    !Array.isArray(value["invoiceDeltas"]) ||
    !value["invoiceDeltas"].every(invoiceDelta)
  )
    throw corrupt();
  const lines = value["lines"];
  const auditItems = value["auditItems"] ?? [];
  const hasDeferred =
    value["deferredObservationIds"].length +
      value["deferredAttachmentIds"].length >
    0;
  if (
    !distinct(lines.map((line) => line.lineId)) ||
    hasDeferred !== (value["retainUntil"] !== null) ||
    lines.reduce(
      (sum, line) => sum + (line.kind === "CREATE" ? line.totalCents : 0),
      0,
    ) !== value["createdEconomicTotalCents"]
  )
    throw corrupt();
  return {
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    kind: IMPORT_SESSION_KIND,
    sessionId,
    revision: value["revision"],
    proposalHash: value["proposalHash"],
    lines,
    auditItems,
    deferredObservationIds: value["deferredObservationIds"],
    deferredAttachmentIds: value["deferredAttachmentIds"],
    retainUntil: value["retainUntil"],
    createdEconomicTotalCents: value["createdEconomicTotalCents"],
    bankCashDeltaCents: 0,
    invoiceDeltas: value["invoiceDeltas"],
  };
}

/** Bind IDs to the persisted scope, not to current financial rows or inferred values. */
export function assertProposalDraftReferences(
  proposal: ImportSessionProposalV1,
  draft: ImportSessionStoredDraftV1,
): void {
  const sameIds = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((item) => right.includes(item));
  const selected = draft.lines.filter((line) =>
    draft.selectedLineIds.includes(line.id),
  );
  const usedObservations = new Set(
    selected.flatMap((line) => line.observationIds),
  );
  const auditedObservations = new Set(
    proposal.auditItems.map((item) => item.observationId),
  );
  if (
    !sameIds(
      proposal.lines.map((line) => line.lineId),
      draft.selectedLineIds,
    ) ||
    proposal.lines.some((line) => {
      const decision = selected.find(
        (item) => item.id === line.lineId,
      )?.decision;
      return (
        decision?.kind !== line.kind ||
        (line.kind === "KEEP_EXISTING" &&
          (decision.kind !== "KEEP_EXISTING" ||
            decision.expenseId !== line.sourceExpenseId))
      );
    }) ||
    !sameIds(
      proposal.deferredObservationIds,
      draft.scope.observationIds.filter(
        (item) => !usedObservations.has(item) && !auditedObservations.has(item),
      ),
    ) ||
    proposal.auditItems.some(
      (item) =>
        !draft.scope.observationIds.includes(item.observationId) ||
        usedObservations.has(item.observationId),
    ) ||
    !sameIds(proposal.deferredAttachmentIds, draft.scope.pendingAttachmentIds)
  )
    throw new ImportSessionCorruptStateError("proposal");
}
