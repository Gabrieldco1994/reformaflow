import { createHash } from "node:crypto";
import {
  IMPORT_SESSION_PROTOCOL_VERSION,
  IMPORT_SESSION_PRIMITIVES as P,
  ExpenseType,
  ImportSessionErrorCode as Code,
  parseInstallmentDateOnlyUtc,
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
      "answer",
    ]) ||
    body.version !== IMPORT_SESSION_PROTOCOL_VERSION ||
    typeof body.answerRequestId !== "string" ||
    !REQUEST_ID.test(body.answerRequestId) ||
    typeof body.questionId !== "string" ||
    !ID.test(body.questionId) ||
    !record(body.answer) ||
    !exact(body.answer, ["field", "value"])
  )
    throw invalid();
  const answer = body.answer;
  if (answer.field === "firstDueDate") {
    if (answer.value !== null) {
      if (typeof answer.value !== "string") throw invalid();
      const date = parseInstallmentDateOnlyUtc(answer.value);
      if (
        !date ||
        date.getUTCFullYear() < P.minYear ||
        date.getUTCFullYear() > P.maxYear
      )
        throw invalid();
    }
  } else if (answer.field === "tipoDespesa") {
    if (
      answer.value !== null &&
      !Object.values(ExpenseType).some((value) => value === answer.value)
    )
      throw invalid();
  } else throw invalid();
  return structuredClone({
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    answerRequestId: body.answerRequestId,
    ...parseRevisionRequest({ expectedRevision: body.expectedRevision }),
    questionId: body.questionId,
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
