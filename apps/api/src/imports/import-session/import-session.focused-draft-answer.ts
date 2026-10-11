import { createHash } from "node:crypto";
import {
  IMPORT_CHAT_CHANNEL,
  IMPORT_SESSION_PROTOCOL_VERSION,
  IMPORT_SESSION_PRIMITIVES as P,
  ExpenseType,
  LaborCategory,
  ImportSessionErrorCode as Code,
  parseImportFocusedLiteral,
  type ImportFocusedLiteralField,
  type ImportSessionFocusedDraftAnswerRequestV1,
} from "@reformaflow/domain";
import { canonical } from "../../common/canonical";
import type { UiImportGrantScope } from "./import-session.contract";
import { ImportSessionError } from "./import-session.errors";
import { parseRevisionRequest } from "./import-session.service";

const REQUEST_ID = new RegExp(P.requestIdPattern);
const ID = new RegExp(P.idPattern);
const invalid = (): ImportSessionError =>
  new ImportSessionError(Code.INVALID_INPUT);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

/** Dispatch only; strict parsing below decides validity and precedes grant issuance. */
export function isFocusedDraftAnswerRequest(body: unknown): boolean {
  return (
    record(body) &&
    ["version", "answerRequestId", "answer"].some((key) =>
      Object.prototype.hasOwnProperty.call(body, key),
    )
  );
}

/** Exact typed UI input. No guessed year, enum label interpretation or cycle adjustment. */
export function parseFocusedDraftAnswerRequest(
  body: unknown,
): ImportSessionFocusedDraftAnswerRequestV1 {
  if (
    !record(body) ||
    !exact(body, [
      "version",
      "answerRequestId",
      "expectedRevision",
      "questionId",
      "channel",
      "answer",
    ]) ||
    body.version !== IMPORT_SESSION_PROTOCOL_VERSION ||
    typeof body.answerRequestId !== "string" ||
    !REQUEST_ID.test(body.answerRequestId) ||
    typeof body.questionId !== "string" ||
    !ID.test(body.questionId) ||
    (body.channel !== IMPORT_CHAT_CHANNEL.TEXT &&
      body.channel !== IMPORT_CHAT_CHANNEL.VOICE) ||
    !record(body.answer) ||
    typeof body.answer.field !== "string"
  )
    throw invalid();
  const answer = body.answer;
  const field = answer.field as string;
  if (
    [
      "amountMeaning",
      "amountCents",
      "installmentCount",
      "dataCompra",
      "firstDueDate",
    ].includes(field)
  ) {
    if (
      !exact(answer, ["field", "literal", "value"]) ||
      typeof answer.literal !== "string" ||
      parseImportFocusedLiteral(
        field as ImportFocusedLiteralField,
        answer.literal,
      ) !== answer.value
    )
      throw invalid();
  } else if (field === "tipoDespesa") {
    if (
      !exact(answer, ["field", "value"]) ||
      !Object.values(ExpenseType).some((value) => value === answer.value)
    )
      throw invalid();
  } else if (field === "categoriaMaoDeObra") {
    if (
      !exact(answer, ["field", "value"]) ||
      !Object.values(LaborCategory).some((value) => value === answer.value)
    )
      throw invalid();
  } else if (field === "decision") {
    if (!exact(answer, ["field", "value"]) || !record(answer.value))
      throw invalid();
    if (answer.value.kind === "CREATE") {
      if (
        !exact(answer.value, ["kind", "acceptNaturalDuplicate"]) ||
        typeof answer.value.acceptNaturalDuplicate !== "boolean"
      )
        throw invalid();
    } else if (
      answer.value.kind !== "KEEP_EXISTING" ||
      !exact(answer.value, ["kind", "expenseId"]) ||
      typeof answer.value.expenseId !== "string" ||
      !ID.test(answer.value.expenseId)
    )
      throw invalid();
  } else if (field === "targets") {
    if (!exact(answer, ["field", "value"]) || !record(answer.value))
      throw invalid();
    if (answer.value.kind === "NO_TARGETS") {
      if (!exact(answer.value, ["kind"])) throw invalid();
    } else if (
      answer.value.kind !== "TARGET" ||
      !exact(answer.value, [
        "kind",
        "projectId",
        "roomId",
        "amountCents",
        "literal",
      ]) ||
      typeof answer.value.projectId !== "string" ||
      !ID.test(answer.value.projectId) ||
      !(
        answer.value.roomId === null ||
        (typeof answer.value.roomId === "string" &&
          ID.test(answer.value.roomId))
      ) ||
      typeof answer.value.amountCents !== "number" ||
      !Number.isSafeInteger(answer.value.amountCents) ||
      answer.value.amountCents < P.minPurchaseCents ||
      answer.value.amountCents > P.maxCents ||
      typeof answer.value.literal !== "string" ||
      parseImportFocusedLiteral("amountCents", answer.value.literal) !==
        answer.value.amountCents
    )
      throw invalid();
  } else throw invalid();
  return structuredClone({
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    answerRequestId: body.answerRequestId,
    ...parseRevisionRequest({ expectedRevision: body.expectedRevision }),
    questionId: body.questionId,
    channel: body.channel,
    answer,
  }) as ImportSessionFocusedDraftAnswerRequestV1;
}

export function focusedDraftAnswerScope(
  sessionId: string,
  request: ImportSessionFocusedDraftAnswerRequestV1,
): Extract<UiImportGrantScope, { operation: "FOCUSED_DRAFT_ANSWER" }> {
  return {
    operation: "FOCUSED_DRAFT_ANSWER",
    sessionId,
    expectedRevision: request.expectedRevision,
    questionId: request.questionId,
    requestHash: createHash("sha256").update(canonical(request)).digest("hex"),
  };
}
