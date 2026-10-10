import { createHash } from "node:crypto";
import {
  ExpenseType,
  LaborCategory,
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  IMPORT_SESSION_PROTOCOL_VERSION,
  ImportSessionAmountMeaning,
  ImportSessionErrorCode,
  parseInstallmentDateOnlyUtc,
  type ContinueAnsweringCommandV1,
  type ImportDeclarationCommandV1,
  type ImportDocumentaryOperationV1,
  type ImportDraftResolutionCommandV1,
  type ImportInterpretationRequestV1,
  type ImportLineDocumentaryCommandV1,
  type ImportTypedDraftAnswerV1,
  type ImportTypedGuidedAnswerV1,
  type PrepareCurrentLotCommandV1,
} from "@reformaflow/domain";
import { canonical } from "../../common/canonical";
import { ImportSessionError } from "./import-session.errors";

const ID = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);
const REQUEST_ID = new RegExp(IMPORT_SESSION_PRIMITIVES.requestIdPattern);
const MAX_INTERPRETATION_TEXT_LENGTH = 4000;
const INVALID = () =>
  new ImportSessionError(ImportSessionErrorCode.INVALID_INPUT);

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: JsonRecord, keys: readonly string[]): boolean =>
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const id = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
const requestId = (value: unknown): value is string =>
  typeof value === "string" && REQUEST_ID.test(value);
const revision = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= IMPORT_SESSION_PRIMITIVES.minRevision &&
  value <= IMPORT_SESSION_PRIMITIVES.maxRevision;

function parseCommon(
  body: unknown,
  keys: readonly string[],
): JsonRecord & {
  version: 1;
  requestId: string;
  expectedRevision: number;
} {
  if (
    !record(body) ||
    !exact(body, keys) ||
    body.version !== IMPORT_SESSION_PROTOCOL_VERSION ||
    !requestId(body.requestId) ||
    !revision(body.expectedRevision)
  )
    throw INVALID();
  return body as JsonRecord & {
    version: 1;
    requestId: string;
    expectedRevision: number;
  };
}

function parseGuidedAnswer(value: unknown): ImportTypedGuidedAnswerV1 {
  if (!record(value) || typeof value.kind !== "string") throw INVALID();
  if (value.kind === "UNKNOWN" || value.kind === "REMOVE") {
    if (!exact(value, ["kind"])) throw INVALID();
    return { kind: value.kind };
  }
  if (
    value.kind !== "KNOWN" ||
    !exact(value, ["kind", "value"]) ||
    !(
      (typeof value.value === "string" &&
        value.value.length <= MAX_INTERPRETATION_TEXT_LENGTH) ||
      (typeof value.value === "number" && Number.isSafeInteger(value.value))
    )
  )
    throw INVALID();
  return { kind: "KNOWN", value: value.value };
}

export function parseDeclarationCommand(
  body: unknown,
): ImportDeclarationCommandV1 {
  const value = parseCommon(body, [
    "version",
    "requestId",
    "expectedRevision",
    "questionId",
    "answer",
  ]);
  if (!id(value.questionId)) throw INVALID();
  return {
    version: 1,
    requestId: value.requestId,
    expectedRevision: value.expectedRevision,
    questionId: value.questionId,
    answer: parseGuidedAnswer(value.answer),
  };
}

function parseDraftAnswer(value: unknown): ImportTypedDraftAnswerV1 {
  if (!record(value) || typeof value.kind !== "string") throw INVALID();
  if (value.kind === "UNKNOWN" || value.kind === "REMOVE") {
    if (!exact(value, ["kind"])) throw INVALID();
    return { kind: value.kind };
  }
  if (!exact(value, ["kind", "value"])) throw INVALID();
  switch (value.kind) {
    case "CENTS":
      if (
        typeof value.value !== "number" ||
        !Number.isInteger(value.value) ||
        value.value < IMPORT_SESSION_PRIMITIVES.minPurchaseCents ||
        value.value > IMPORT_SESSION_PRIMITIVES.maxCents
      )
        throw INVALID();
      return { kind: value.kind, value: value.value };
    case "POSITIVE_INTEGER":
      if (
        typeof value.value !== "number" ||
        !Number.isInteger(value.value) ||
        value.value < 1 ||
        value.value > IMPORT_SESSION_LIMITS.installmentsPerPurchase
      )
        throw INVALID();
      return { kind: value.kind, value: value.value };
    case "DATE": {
      if (typeof value.value !== "string") throw INVALID();
      const parsed = parseInstallmentDateOnlyUtc(value.value);
      if (
        parsed === null ||
        parsed.getUTCFullYear() < IMPORT_SESSION_PRIMITIVES.minYear ||
        parsed.getUTCFullYear() > IMPORT_SESSION_PRIMITIVES.maxYear
      )
        throw INVALID();
      return { kind: value.kind, value: value.value };
    }
    case "AMOUNT_MEANING":
      if (
        value.value !== ImportSessionAmountMeaning.TOTAL_PURCHASE &&
        value.value !== ImportSessionAmountMeaning.INSTALLMENT_CHARGE
      )
        throw INVALID();
      return { kind: value.kind, value: value.value };
    case "TEXT":
      if (
        typeof value.value !== "string" ||
        value.value.trim() !== value.value ||
        value.value.length < 1 ||
        value.value.length > IMPORT_SESSION_PRIMITIVES.maxTitleLength
      )
        throw INVALID();
      return { kind: value.kind, value: value.value };
    case "EXPENSE_TYPE":
      if (
        typeof value.value !== "string" ||
        !Object.values(ExpenseType).includes(value.value as ExpenseType)
      )
        throw INVALID();
      return { kind: value.kind, value: value.value as ExpenseType };
    case "LABOR_CATEGORY":
      if (
        value.value !== null &&
        (typeof value.value !== "string" ||
          !Object.values(LaborCategory).includes(value.value as LaborCategory))
      )
        throw INVALID();
      return {
        kind: value.kind,
        value: value.value as LaborCategory | null,
      };
    case "TARGETS":
      if (
        !Array.isArray(value.value) ||
        value.value.length > IMPORT_SESSION_LIMITS.targetsPerPurchase ||
        !value.value.every(
          (target) =>
            record(target) &&
            exact(target, ["projectId", "roomId", "amountCents"]) &&
            id(target.projectId) &&
            (target.roomId === null || id(target.roomId)) &&
            typeof target.amountCents === "number" &&
            Number.isInteger(target.amountCents) &&
            target.amountCents >= IMPORT_SESSION_PRIMITIVES.minPurchaseCents &&
            target.amountCents <= IMPORT_SESSION_PRIMITIVES.maxCents,
        )
      )
        throw INVALID();
      return {
        kind: value.kind,
        value: structuredClone(value.value) as ImportTypedDraftAnswerV1 & never,
      };
    case "DECISION":
      if (!record(value.value) || typeof value.value.kind !== "string")
        throw INVALID();
      if (
        value.value.kind === "CREATE" &&
        exact(value.value, ["kind", "acceptNaturalDuplicate"]) &&
        typeof value.value.acceptNaturalDuplicate === "boolean"
      )
        return {
          kind: value.kind,
          value: {
            kind: "CREATE",
            acceptNaturalDuplicate: value.value.acceptNaturalDuplicate,
          },
        };
      if (
        value.value.kind === "KEEP_EXISTING" &&
        exact(value.value, ["kind", "expenseId"]) &&
        id(value.value.expenseId)
      )
        return {
          kind: value.kind,
          value: {
            kind: "KEEP_EXISTING",
            expenseId: value.value.expenseId,
          },
        };
      if (value.value.kind === "EXCLUDE" && exact(value.value, ["kind"]))
        return { kind: value.kind, value: { kind: "EXCLUDE" } };
      throw INVALID();
    default:
      throw INVALID();
  }
}

export function parseResolutionCommand(
  body: unknown,
): ImportDraftResolutionCommandV1 {
  const value = parseCommon(body, [
    "version",
    "requestId",
    "expectedRevision",
    "questionId",
    "answer",
  ]);
  if (!id(value.questionId)) throw INVALID();
  return {
    version: 1,
    requestId: value.requestId,
    expectedRevision: value.expectedRevision,
    questionId: value.questionId,
    answer: parseDraftAnswer(value.answer),
  };
}

function parseLineCommand(body: unknown): ImportLineDocumentaryCommandV1 {
  const value = parseCommon(body, [
    "version",
    "requestId",
    "expectedRevision",
    "lineId",
  ]);
  if (!id(value.lineId)) throw INVALID();
  return {
    version: 1,
    requestId: value.requestId,
    expectedRevision: value.expectedRevision,
    lineId: value.lineId,
  };
}

export const parseDeferCommand = parseLineCommand;
export const parseReactivateCommand = parseLineCommand;

export function parsePrepareCurrentLotCommand(
  body: unknown,
): PrepareCurrentLotCommandV1 {
  const value = parseCommon(body, ["version", "requestId", "expectedRevision"]);
  return {
    version: 1,
    requestId: value.requestId,
    expectedRevision: value.expectedRevision,
  };
}

export function parseContinueAnsweringCommand(
  body: unknown,
): ContinueAnsweringCommandV1 {
  const value = parseCommon(body, ["version", "requestId", "expectedRevision"]);
  return {
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    requestId: value.requestId,
    expectedRevision: value.expectedRevision,
  };
}

export function parseInterpretationRequest(
  body: unknown,
): ImportInterpretationRequestV1 {
  const value = parseCommon(body, [
    "version",
    "requestId",
    "expectedRevision",
    "questionId",
    "text",
    "consentExternalProcessing",
  ]);
  if (
    !id(value.questionId) ||
    typeof value.text !== "string" ||
    value.text.length < 1 ||
    value.text.length > MAX_INTERPRETATION_TEXT_LENGTH ||
    value.consentExternalProcessing !== true
  )
    throw INVALID();
  return {
    version: 1,
    requestId: value.requestId,
    expectedRevision: value.expectedRevision,
    questionId: value.questionId,
    text: value.text,
    consentExternalProcessing: true,
  };
}

export function documentaryPayloadHash(
  sessionId: string,
  operation: ImportDocumentaryOperationV1 | "INTERPRET_QUESTION",
  command:
    | ImportDeclarationCommandV1
    | ImportDraftResolutionCommandV1
    | ImportLineDocumentaryCommandV1
    | ContinueAnsweringCommandV1
    | PrepareCurrentLotCommandV1
    | ImportInterpretationRequestV1,
): string {
  const { requestId: _requestId, ...content } = command;
  return createHash("sha256")
    .update(
      canonical({
        operation,
        sessionId,
        ...content,
      }),
    )
    .digest("hex");
}
