import { createHash } from "node:crypto";
import {
  IMPORT_SESSION_PROTOCOL_VERSION,
  IMPORT_SESSION_PRIMITIVES as P,
  ImportSessionErrorCode as Code,
  normalizeImportDeclaration,
  type ImportDeclarationContextV1,
  type ImportHumanFactFieldV1,
  type ImportSessionDocumentaryAnswerRequestV1,
} from "@reformaflow/domain";
import { canonical } from "../../common/canonical";
import type { UiImportGrantScope } from "./import-session.contract";
import { ImportSessionError } from "./import-session.errors";
import { parseRevisionRequest } from "./import-session.service";

const FIELDS: readonly ImportHumanFactFieldV1[] = [
  "dataCompra",
  "merchant",
  "amountMeaning",
  "amountCents",
  "installmentCount",
  "installmentIndex",
];
const REQUEST_ID = new RegExp(P.requestIdPattern);
const QUESTION_ID = /^oq_[0-9a-f]{64}$/;
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

/**
 * Strict structural/preview validation before minting a grant. The writer must repeat
 * normalization with LIVE server context: this parse confers no subject authority.
 */
export function parseDocumentaryAnswerRequest(
  body: unknown,
): ImportSessionDocumentaryAnswerRequestV1 {
  if (
    !record(body) ||
    !exact(body, [
      "version",
      "answerRequestId",
      "expectedRevision",
      "questionId",
      "input",
      "answer",
    ]) ||
    body.version !== IMPORT_SESSION_PROTOCOL_VERSION ||
    typeof body.answerRequestId !== "string" ||
    !REQUEST_ID.test(body.answerRequestId) ||
    typeof body.questionId !== "string" ||
    !QUESTION_ID.test(body.questionId) ||
    !record(body.input) ||
    !record(body.answer) ||
    !exact(body.answer, ["field", "value", "meaningContext"])
  )
    throw invalid();
  const answer = body.answer;
  if (!FIELDS.some((field) => field === answer.field)) throw invalid();
  const input = body.input;
  if (input.kind === "VALUE") {
    if (!exact(input, ["kind", "text"]) || typeof input.text !== "string")
      throw invalid();
  } else if (
    (input.kind !== "UNKNOWN" && input.kind !== "REMOVE") ||
    !exact(input, ["kind"])
  )
    throw invalid();
  const request = structuredClone({
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    answerRequestId: body.answerRequestId,
    ...parseRevisionRequest({ expectedRevision: body.expectedRevision }),
    questionId: body.questionId,
    input,
    answer: body.answer,
  }) as ImportSessionDocumentaryAnswerRequestV1;
  const preview = normalizeImportDeclaration(
    {
      field: request.answer.field,
      meaningContext: request.answer.meaningContext,
      effectiveInstallmentCount: null,
    } as ImportDeclarationContextV1,
    request.input,
  );
  if (
    preview.kind !== "VALID" ||
    canonical(preview.answer) !== canonical(request.answer)
  )
    throw invalid();
  // Stored documentary strings are NFC. Reject instead of silently changing the
  // human's accepted preview (the original VALUE evidence remains byte-exact).
  if (
    typeof request.answer.value === "string" &&
    request.answer.value.normalize("NFC") !== request.answer.value
  )
    throw invalid();
  return request;
}

export function documentaryAnswerScope(
  sessionId: string,
  request: ImportSessionDocumentaryAnswerRequestV1,
): Extract<UiImportGrantScope, { operation: "DOCUMENTARY_ANSWER" }> {
  return {
    operation: "DOCUMENTARY_ANSWER",
    sessionId,
    expectedRevision: request.expectedRevision,
    questionId: request.questionId,
    requestHash: createHash("sha256").update(canonical(request)).digest("hex"),
  };
}
