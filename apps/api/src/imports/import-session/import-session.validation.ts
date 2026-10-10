import {
  ExpenseType,
  LaborCategory,
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
  type ImportSessionEffectsV1,
  type ImportSessionNoWriteRowV1,
  type ImportObservationQuestionV1,
  type ImportSessionQuestionV1,
  type ImportSessionStoredDraftV1,
  type ImportSessionTargetInputV1,
  type ImportStoredDeclarationV1,
} from "@reformaflow/domain";
import { ImportSessionCorruptStateError } from "./import-session.errors";

const ID = new RegExp(PRIMITIVES.idPattern);
const HASH = new RegExp(PRIMITIVES.hashPattern);
const INSTANT = new RegExp(PRIMITIVES.instantPattern);
const REQUEST_ID = new RegExp(PRIMITIVES.requestIdPattern);
const DOCUMENTARY_OPERATIONS = [
  "DECLARE",
  "RESOLVE",
  "DEFER",
  "REACTIVATE",
  "CONTINUE_ANSWERING",
  "PREPARE_CURRENT_LOT",
] as const;
const DOCUMENTARY_OUTCOMES = [
  "APPLIED",
  "NO_CHANGE",
  "NEEDS_INPUT",
  "CURRENT_LOT_READY",
] as const;
const INTERPRETATION_FAILURE_CODES = [
  "PROVIDER_UNAVAILABLE",
  "MODEL_OUTPUT_INVALID",
] as const;
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
const HUMAN_FACT_FIELDS: readonly ImportObservationQuestionV1["field"][] = [
  "dataCompra",
  "merchant",
  "amountMeaning",
  "amountCents",
  "installmentCount",
  "installmentIndex",
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
  "noWriteRows",
  "effects",
  "deferredObservationIds",
  "deferredAttachmentIds",
  "retainUntil",
  "createdEconomicTotalCents",
  "bankCashDeltaCents",
  "invoiceDeltas",
];
const EFFECT_KEYS: readonly (keyof ImportSessionEffectsV1)[] = [
  "personalSourceCreates",
  "reformaTargetCreates",
  "expenseCreates",
  "cashFlowEntryCreates",
  "rateioAllocationCreates",
  "keptExistingCount",
  "deferredCount",
  "excludedCount",
  "ignoredCount",
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
    case "DEFER":
    case "EXCLUDE":
      return exact(value, ["kind"]);
    case "IGNORED_POLICY":
      return (
        exact(value, ["kind", "reason", "policyVersion"]) &&
        oneOf(value["reason"], ["INVOICE_PAYMENT", "CARD_PAYS_CARD"]) &&
        value["policyVersion"] === 1
      );
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
  if (
    !(
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
      oneOf(
        value["amountMeaning"],
        Object.values(ImportSessionAmountMeaning),
      ) &&
      (value["amountCents"] === null || cents(value["amountCents"])) &&
      (value["installmentCount"] === null ||
        integer(
          value["installmentCount"],
          1,
          LIMITS.installmentsPerPurchase,
        )) &&
      (value["dataCompra"] === null || dateOnly(value["dataCompra"])) &&
      (value["firstDueDate"] === null || dateOnly(value["firstDueDate"])) &&
      (value["targets"] === null ||
        (Array.isArray(value["targets"]) &&
          value["targets"].length <= LIMITS.targetsPerPurchase &&
          value["targets"].every(target) &&
          distinct(value["targets"].map((item) => item.projectId)))) &&
      decision(value["decision"])
    )
  )
    return false;
  const targets = value["targets"] as ImportSessionDraftLineV1["targets"];
  const lineDecision = value["decision"] as ImportSessionDecisionV1;
  if (lineDecision.kind === "UNRESOLVED") return targets === null;
  if (lineDecision.kind === "CREATE")
    return (
      (value["amountCents"] === null || purchaseCents(value["amountCents"])) &&
      (targets === null ||
        targets.length === 0 ||
        value["amountCents"] === null ||
        value["amountMeaning"] !== ImportSessionAmountMeaning.TOTAL_PURCHASE ||
        (value["amountCents"] !== null &&
          targets[0]!.amountCents === value["amountCents"]))
    );
  return Array.isArray(targets) && targets.length === 0;
}

function draftQuestion(value: unknown): value is ImportSessionDraftQuestionV1 {
  return (
    record(value) &&
    exact(value, ["id", "lineIds", "field", "text"]) &&
    id(value["id"]) &&
    ids(value["lineIds"], 1, LIMITS.editableLines) &&
    oneOf(value["field"], QUESTION_FIELDS) &&
    text(value["text"], 1, PRIMITIVES.maxQuestionLength)
  );
}

function observationQuestion(
  value: unknown,
): value is ImportObservationQuestionV1 {
  if (
    !record(value) ||
    !exact(value, [
      "id",
      "lineIds",
      "field",
      "text",
      "subject",
      "answerState",
    ]) ||
    !id(value["id"]) ||
    !ids(value["lineIds"], 1, 1) ||
    !oneOf(value["field"], HUMAN_FACT_FIELDS) ||
    !text(value["text"], 1, PRIMITIVES.maxQuestionLength) ||
    !record(value["subject"]) ||
    !exact(value["subject"], ["kind", "observationId", "meaningContext"]) ||
    value["subject"]["kind"] !== "OBSERVATION" ||
    !id(value["subject"]["observationId"]) ||
    !oneOf(value["answerState"], ["UNANSWERED", "DECLARED", "UNKNOWN"])
  )
    return false;
  return value["field"] === "amountCents"
    ? oneOf(value["subject"]["meaningContext"], [
        "TOTAL_PURCHASE",
        "INSTALLMENT_CHARGE",
      ])
    : value["subject"]["meaningContext"] === null;
}

function question(value: unknown): value is ImportSessionQuestionV1 {
  return draftQuestion(value) || observationQuestion(value);
}

function validFieldProvenance(value: unknown): boolean {
  if (
    !record(value) ||
    !exact(value, [
      "origin",
      "lineId",
      "field",
      "recordedRevision",
      ...(Object.prototype.hasOwnProperty.call(value, "interpretationRequestId")
        ? ["interpretationRequestId"]
        : []),
    ]) ||
    !oneOf(value.origin, ["FILE", "USER", "AI_CONFIRMED"]) ||
    !id(value.lineId) ||
    !oneOf(value.field, QUESTION_FIELDS) ||
    !integer(
      value.recordedRevision,
      PRIMITIVES.minRevision,
      PRIMITIVES.maxRevision,
    ) ||
    (Object.prototype.hasOwnProperty.call(value, "interpretationRequestId") &&
      (typeof value.interpretationRequestId !== "string" ||
        !REQUEST_ID.test(value.interpretationRequestId)))
  )
    return false;
  return (
    value.origin === "AI_CONFIRMED" ||
    !Object.prototype.hasOwnProperty.call(value, "interpretationRequestId")
  );
}

function declaration(value: unknown): value is ImportStoredDeclarationV1 {
  if (
    !record(value) ||
    !exact(value, [
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
    ]) ||
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

function commandRecord(value: unknown): boolean {
  if (
    !record(value) ||
    !exact(value, [
      "requestId",
      "operation",
      "payloadHash",
      "expectedRevision",
      "result",
      "actorUserId",
      "recordedAt",
    ]) ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID.test(value.requestId) ||
    !oneOf(value.operation, DOCUMENTARY_OPERATIONS) ||
    typeof value.payloadHash !== "string" ||
    !HASH.test(value.payloadHash) ||
    !integer(
      value.expectedRevision,
      PRIMITIVES.minRevision,
      PRIMITIVES.maxRevision,
    ) ||
    !id(value.actorUserId) ||
    !instant(value.recordedAt) ||
    !record(value.result) ||
    !exact(value.result, [
      "version",
      "requestId",
      "operation",
      "outcome",
      "revision",
    ]) ||
    value.result.version !== IMPORT_SESSION_PROTOCOL_VERSION ||
    value.result.requestId !== value.requestId ||
    value.result.operation !== value.operation ||
    !oneOf(value.result.outcome, DOCUMENTARY_OUTCOMES) ||
    !integer(
      value.result.revision,
      PRIMITIVES.minRevision,
      PRIMITIVES.maxRevision,
    )
  )
    return false;
  return true;
}

function guidedAnswer(value: unknown): boolean {
  if (!record(value) || typeof value.kind !== "string") return false;
  if (value.kind === "UNKNOWN" || value.kind === "REMOVE")
    return exact(value, ["kind"]);
  return (
    value.kind === "KNOWN" &&
    exact(value, ["kind", "value"]) &&
    ((typeof value.value === "string" && value.value.length <= 4000) ||
      (typeof value.value === "number" && Number.isSafeInteger(value.value)))
  );
}

function interpretationRecord(value: unknown): boolean {
  if (
    !record(value) ||
    !exact(value, [
      "requestId",
      "payloadHash",
      "expectedRevision",
      "status",
      ...(Object.prototype.hasOwnProperty.call(value, "result")
        ? ["result"]
        : []),
      ...(Object.prototype.hasOwnProperty.call(value, "failureCode")
        ? ["failureCode"]
        : []),
      "recordedAt",
    ]) ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID.test(value.requestId) ||
    typeof value.payloadHash !== "string" ||
    !HASH.test(value.payloadHash) ||
    !integer(
      value.expectedRevision,
      PRIMITIVES.minRevision,
      PRIMITIVES.maxRevision,
    ) ||
    !oneOf(value.status, ["PENDING", "COMPLETE", "FAILED"]) ||
    !instant(value.recordedAt)
  )
    return false;
  if (value.status === "PENDING")
    return (
      !Object.prototype.hasOwnProperty.call(value, "result") &&
      !Object.prototype.hasOwnProperty.call(value, "failureCode")
    );
  if (value.status === "FAILED")
    return (
      !Object.prototype.hasOwnProperty.call(value, "result") &&
      oneOf(value.failureCode, INTERPRETATION_FAILURE_CODES)
    );
  if (
    Object.prototype.hasOwnProperty.call(value, "failureCode") ||
    !record(value.result) ||
    !exact(value.result, [
      "version",
      "requestId",
      "outcome",
      ...(Object.prototype.hasOwnProperty.call(value.result, "candidate")
        ? ["candidate"]
        : []),
    ]) ||
    value.result.version !== IMPORT_SESSION_PROTOCOL_VERSION ||
    value.result.requestId !== value.requestId ||
    !oneOf(value.result.outcome, ["CANDIDATE", "CLARIFY"])
  )
    return false;
  return value.result.outcome === "CANDIDATE"
    ? guidedAnswer(value.result.candidate)
    : !Object.prototype.hasOwnProperty.call(value.result, "candidate");
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
      ...(Object.prototype.hasOwnProperty.call(value, "commandLedger")
        ? ["commandLedger"]
        : []),
      ...(Object.prototype.hasOwnProperty.call(value, "interpretationLedger")
        ? ["interpretationLedger"]
        : []),
      ...(Object.prototype.hasOwnProperty.call(value, "fieldProvenance")
        ? ["fieldProvenance"]
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
  let commandLedger: ImportSessionStoredDraftV1["commandLedger"];
  if (Object.prototype.hasOwnProperty.call(value, "commandLedger")) {
    const extension = value.commandLedger;
    if (
      !record(extension) ||
      !exact(extension, ["version", "items"]) ||
      extension.version !== IMPORT_SESSION_PROTOCOL_VERSION ||
      !Array.isArray(extension.items) ||
      extension.items.length > LIMITS.documentaryCommandReceipts ||
      !extension.items.every(commandRecord) ||
      !distinct(extension.items.map((item) => item.requestId))
    )
      throw corrupt();
    commandLedger = { version: 1, items: extension.items };
  }
  let interpretationLedger: ImportSessionStoredDraftV1["interpretationLedger"];
  if (Object.prototype.hasOwnProperty.call(value, "interpretationLedger")) {
    const extension = value.interpretationLedger;
    if (
      !record(extension) ||
      !exact(extension, ["version", "items"]) ||
      extension.version !== IMPORT_SESSION_PROTOCOL_VERSION ||
      !Array.isArray(extension.items) ||
      extension.items.length > LIMITS.interpretationReceipts ||
      !extension.items.every(interpretationRecord) ||
      !distinct(extension.items.map((item) => item.requestId))
    )
      throw corrupt();
    interpretationLedger = { version: 1, items: extension.items };
  }
  let fieldProvenance: ImportSessionStoredDraftV1["fieldProvenance"];
  if (Object.prototype.hasOwnProperty.call(value, "fieldProvenance")) {
    const extension = value.fieldProvenance;
    if (
      !Array.isArray(extension) ||
      extension.length > LIMITS.editableLines * QUESTION_FIELDS.length ||
      !extension.every(validFieldProvenance) ||
      !distinct(
        extension.map((item) => JSON.stringify([item.lineId, item.field])),
      )
    )
      throw corrupt();
    fieldProvenance = extension;
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
    value["questions"].some(
      (item) =>
        "subject" in item &&
        !lines.some(
          (line) =>
            line.id === item.lineIds[0] &&
            line.observationIds.includes(item.subject.observationId),
        ),
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
    (fieldProvenance !== undefined &&
      fieldProvenance.some((item) => !lineIds.has(item.lineId))) ||
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
    ...(commandLedger === undefined ? {} : { commandLedger }),
    ...(interpretationLedger === undefined ? {} : { interpretationLedger }),
    ...(fieldProvenance === undefined ? {} : { fieldProvenance }),
    scope: {
      observationIds: scope["observationIds"],
      pendingAttachmentIds: scope["pendingAttachmentIds"],
    },
  };
}

function noWriteRow(
  value: unknown,
): value is NonNullable<ImportSessionProposalV1["noWriteRows"]>[number] {
  return (
    record(value) &&
    exact(value, ["lineId", "outcome", "reason", "title", "amountCents"]) &&
    id(value.lineId) &&
    oneOf(value.outcome, ["DEFERRED", "EXCLUDED", "IGNORED"]) &&
    oneOf(value.reason, [
      "USER_DEFERRED",
      "USER_EXCLUDED",
      "INVOICE_PAYMENT",
      "CARD_PAYS_CARD",
    ]) &&
    text(value.title, 1, PRIMITIVES.maxTitleLength) &&
    (value.amountCents === null || cents(value.amountCents)) &&
    ((value.outcome === "DEFERRED" && value.reason === "USER_DEFERRED") ||
      (value.outcome === "EXCLUDED" && value.reason === "USER_EXCLUDED") ||
      (value.outcome === "IGNORED" &&
        ["INVOICE_PAYMENT", "CARD_PAYS_CARD"].includes(value.reason)))
  );
}

function effects(
  value: unknown,
): value is NonNullable<ImportSessionProposalV1["effects"]> {
  return (
    record(value) &&
    exact(value, EFFECT_KEYS) &&
    EFFECT_KEYS.every((key) =>
      integer(value[key], 0, LIMITS.financialAndCoordinationWritesPerBatch),
    ) &&
    value.expenseCreates ===
      Number(value.personalSourceCreates) + Number(value.reformaTargetCreates)
  );
}

type PlannedLine = ImportSessionProposalV1["lines"][number];

export function deriveImportSessionEffects(
  lines: readonly PlannedLine[],
  noWriteRows: readonly ImportSessionNoWriteRowV1[],
): NonNullable<ImportSessionProposalV1["effects"]> {
  const creates = lines.filter((line) => line.kind === "CREATE");
  return {
    personalSourceCreates: creates.length,
    reformaTargetCreates: creates.reduce(
      (sum, line) => sum + line.targets.length,
      0,
    ),
    expenseCreates: creates.reduce(
      (sum, line) => sum + 1 + line.targets.length,
      0,
    ),
    cashFlowEntryCreates: creates.reduce(
      (sum, line) =>
        sum +
        line.schedule.occurrences.length +
        line.targets.reduce(
          (targetSum, target) => targetSum + target.schedule.occurrences.length,
          0,
        ),
      0,
    ),
    rateioAllocationCreates: creates.reduce(
      (sum, line) => sum + line.targets.length,
      0,
    ),
    keptExistingCount: lines.filter((line) => line.kind === "KEEP_EXISTING")
      .length,
    deferredCount: noWriteRows.filter((line) => line.outcome === "DEFERRED")
      .length,
    excludedCount: noWriteRows.filter((line) => line.outcome === "EXCLUDED")
      .length,
    ignoredCount: noWriteRows.filter((line) => line.outcome === "IGNORED")
      .length,
  };
}

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

export function validateProposal(
  value: unknown,
  sessionId: string,
  proposalHash: string | null,
): ImportSessionProposalV1 {
  const corrupt = () => new ImportSessionCorruptStateError("proposal");
  if (
    !record(value) ||
    !exact(value, PROPOSAL_KEYS) ||
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
    value["lines"].length > LIMITS.selectedLines ||
    !value["lines"].every(plannedLine) ||
    !Array.isArray(value["noWriteRows"]) ||
    !value["noWriteRows"].every(noWriteRow) ||
    !effects(value["effects"]) ||
    value["lines"].length + value["noWriteRows"].length === 0 ||
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
  const noWriteRows = value["noWriteRows"];
  const proposalEffects = value["effects"];
  const expectedEffects = deriveImportSessionEffects(lines, noWriteRows);
  const hasDeferred =
    value["deferredObservationIds"].length +
      value["deferredAttachmentIds"].length >
    0;
  if (
    !distinct([...lines, ...noWriteRows].map((line) => line.lineId)) ||
    hasDeferred !== (value["retainUntil"] !== null) ||
    lines.reduce(
      (sum, line) => sum + (line.kind === "CREATE" ? line.totalCents : 0),
      0,
    ) !== value["createdEconomicTotalCents"] ||
    EFFECT_KEYS.some((key) => proposalEffects[key] !== expectedEffects[key])
  )
    throw corrupt();
  return {
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    kind: IMPORT_SESSION_KIND,
    sessionId,
    revision: value["revision"],
    proposalHash: value["proposalHash"],
    lines,
    noWriteRows,
    effects: proposalEffects,
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
    draft.lines
      .filter(
        (line) =>
          draft.selectedLineIds.includes(line.id) ||
          line.decision.kind === "EXCLUDE" ||
          line.decision.kind === "IGNORED_POLICY",
      )
      .flatMap((line) => line.observationIds),
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
      draft.scope.observationIds.filter((item) => !usedObservations.has(item)),
    ) ||
    !sameIds(proposal.deferredAttachmentIds, draft.scope.pendingAttachmentIds)
  )
    throw new ImportSessionCorruptStateError("proposal");
}
