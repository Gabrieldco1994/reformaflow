import { createHash } from "node:crypto";
import {
  IMPORT_CHAT_CHANNEL,
  IMPORT_SESSION_PROTOCOL_VERSION,
  IMPORT_SESSION_PRIMITIVES as P,
  PDF_OCR_CONSENT_POLICY_VERSION,
  PDF_OCR_CONSENT_PURPOSE,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
  PDF_OCR_RETENTION_DAYS,
  ImportSessionErrorCode as Code,
  normalizeImportDeclaration,
  type ImportDeclarationContextV1,
  type ImportHumanFactFieldV1,
  type ImportSessionDocumentaryAnswerRequestV1,
  type ImportSessionFactDocumentaryAnswerRequestV1,
  type ImportSessionOcrConsentAnswerRequestV1,
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
const QUESTION_ID = /^(?:oq|ocrq)_[0-9a-f]{64}$/;
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
      "channel",
      "input",
      "answer",
    ]) ||
    body.version !== IMPORT_SESSION_PROTOCOL_VERSION ||
    typeof body.answerRequestId !== "string" ||
    !REQUEST_ID.test(body.answerRequestId) ||
    typeof body.questionId !== "string" ||
    !QUESTION_ID.test(body.questionId) ||
    (body.channel !== IMPORT_CHAT_CHANNEL.TEXT &&
      body.channel !== IMPORT_CHAT_CHANNEL.VOICE) ||
    !record(body.input) ||
    !record(body.answer)
  )
    throw invalid();
  const answer = body.answer;
  const input = body.input;
  if (answer.field === "externalOcrConsent") {
    if (
      body.channel !== IMPORT_CHAT_CHANNEL.TEXT ||
      !exact(input, ["kind", "text"]) ||
      input.kind !== "VALUE" ||
      input.text !== "ALLOW_EXTERNAL_PROCESSING" ||
      !exact(answer, [
        "field",
        "value",
        "attachmentId",
        "requestId",
        "consentPolicyVersion",
        "provider",
        "purpose",
        "region",
        "retentionDays",
        "sendsFullOriginal",
        "includesMetadataAndEmbeddedContent",
        "includesPotentiallyNonVisibleContent",
      ]) ||
      answer.value !== "ALLOW_EXTERNAL_PROCESSING" ||
      typeof answer.attachmentId !== "string" ||
      !new RegExp(P.idPattern).test(answer.attachmentId) ||
      typeof answer.requestId !== "string" ||
      !REQUEST_ID.test(answer.requestId) ||
      answer.consentPolicyVersion !== PDF_OCR_CONSENT_POLICY_VERSION ||
      answer.provider !== PDF_OCR_PROVIDER_ID ||
      answer.purpose !== PDF_OCR_CONSENT_PURPOSE ||
      answer.region !== PDF_OCR_REGION ||
      answer.retentionDays !== PDF_OCR_RETENTION_DAYS ||
      answer.sendsFullOriginal !== true ||
      answer.includesMetadataAndEmbeddedContent !== true ||
      answer.includesPotentiallyNonVisibleContent !== true
    )
      throw invalid();
    return structuredClone({
      version: IMPORT_SESSION_PROTOCOL_VERSION,
      answerRequestId: body.answerRequestId,
      ...parseRevisionRequest({ expectedRevision: body.expectedRevision }),
      questionId: body.questionId,
      channel: body.channel,
      input,
      answer,
    }) as ImportSessionOcrConsentAnswerRequestV1;
  }
  if (
    !exact(answer, ["field", "value", "meaningContext"]) ||
    !FIELDS.some((field) => field === answer.field)
  )
    throw invalid();
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
    channel: body.channel,
    input,
    answer: body.answer,
  }) as ImportSessionFactDocumentaryAnswerRequestV1;
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
