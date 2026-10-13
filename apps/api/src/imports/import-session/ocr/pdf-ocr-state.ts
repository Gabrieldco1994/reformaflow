import { createHash } from "node:crypto";
import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  PDF_OCR_CONSENT_POLICY_VERSION,
  PDF_OCR_CONSENT_PURPOSE,
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
  PDF_OCR_RETENTION_DAYS,
  PDF_OCR_VERSION,
} from "@reformaflow/domain";
import { canonical } from "../../../common/canonical";
import { ImportSessionCorruptStateError } from "../import-session.errors";

export type PdfOcrAnalyzeRequestV2 = Readonly<{
  version: typeof PDF_OCR_VERSION;
  expectedRevision: number;
  requestId: string;
  consentExternalProcessing: true;
}>;

export const PDF_OCR_CONSENT_DECISION = "ALLOW_EXTERNAL_PROCESSING" as const;
export const PDF_OCR_RETENTION_MS =
  PDF_OCR_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Durable affirmative declaration plus a reference to the canonical usage
 * ledger. Provider result, outcome, usage and purge state deliberately live
 * only in ImportOcrUsage.
 */
export interface StoredPdfOcrConsentV2 {
  readonly attachmentId: string;
  readonly artifactSha256: string;
  readonly requestId: string;
  readonly requestPayloadHash: string;
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly consentPolicyVersion: typeof PDF_OCR_CONSENT_POLICY_VERSION;
  readonly consentDecision: typeof PDF_OCR_CONSENT_DECISION;
  readonly consentedAt: string;
  readonly provider: typeof PDF_OCR_PROVIDER_ID;
  readonly model: typeof PDF_OCR_MODEL_ID;
  readonly purpose: typeof PDF_OCR_CONSENT_PURPOSE;
  readonly region: typeof PDF_OCR_REGION;
  readonly retentionDays: typeof PDF_OCR_RETENTION_DAYS;
  readonly sendsFullOriginal: true;
  readonly includesMetadataAndEmbeddedContent: true;
  readonly includesPotentiallyNonVisibleContent: true;
  readonly usageId: string | null;
}

export interface StoredPdfOcrStateV2 {
  readonly version: typeof PDF_OCR_VERSION;
  readonly consents: readonly StoredPdfOcrConsentV2[];
}

const EMPTY: StoredPdfOcrStateV2 = Object.freeze({
  version: PDF_OCR_VERSION,
  consents: Object.freeze([]),
});
const REQUEST_ID = new RegExp(IMPORT_SESSION_PRIMITIVES.requestIdPattern);
const HASH = new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern);
const ID = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);
const STATE_KEYS = ["version", "consents"];
const CONSENT_KEYS = [
  "attachmentId",
  "artifactSha256",
  "requestId",
  "requestPayloadHash",
  "expectedRevision",
  "actorId",
  "consentPolicyVersion",
  "consentDecision",
  "consentedAt",
  "provider",
  "model",
  "purpose",
  "region",
  "retentionDays",
  "sendsFullOriginal",
  "includesMetadataAndEmbeddedContent",
  "includesPotentiallyNonVisibleContent",
  "usageId",
];

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function pdfOcrRequestPayloadHash(
  request: PdfOcrAnalyzeRequestV2,
): string {
  return createHash("sha256").update(canonical(request)).digest("hex");
}

export function pdfOcrConsentQuestionId(input: {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly attachmentId: string;
  readonly artifactSha256: string;
}): string {
  return (
    "ocrq_" +
    createHash("sha256")
      .update(
        canonical({
          version: PDF_OCR_CONSENT_POLICY_VERSION,
          ...input,
          provider: PDF_OCR_PROVIDER_ID,
          purpose: PDF_OCR_CONSENT_PURPOSE,
          region: PDF_OCR_REGION,
          retentionDays: PDF_OCR_RETENTION_DAYS,
          sendsFullOriginal: true,
          includesMetadataAndEmbeddedContent: true,
          includesPotentiallyNonVisibleContent: true,
        }),
      )
      .digest("hex")
  );
}

export function parseStoredPdfOcrState(
  raw: string | null,
): StoredPdfOcrStateV2 {
  if (raw === null) return EMPTY;
  if (
    Buffer.byteLength(raw, "utf8") >
    IMPORT_SESSION_LIMITS.jsonBytesPerDraftOrProposal
  )
    throw new ImportSessionCorruptStateError("ocr_json");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ImportSessionCorruptStateError("ocr_json");
  }
  if (
    !record(value) ||
    !exact(value, STATE_KEYS) ||
    value.version !== PDF_OCR_VERSION ||
    !Array.isArray(value.consents) ||
    value.consents.length > IMPORT_SESSION_LIMITS.filesPerSession
  )
    throw new ImportSessionCorruptStateError("ocr_json");
  const attachments = new Set<string>();
  for (const consent of value.consents) {
    if (
      !record(consent) ||
      !exact(consent, CONSENT_KEYS) ||
      typeof consent.attachmentId !== "string" ||
      !ID.test(consent.attachmentId) ||
      attachments.has(consent.attachmentId) ||
      typeof consent.artifactSha256 !== "string" ||
      !HASH.test(consent.artifactSha256) ||
      typeof consent.requestId !== "string" ||
      !REQUEST_ID.test(consent.requestId) ||
      typeof consent.requestPayloadHash !== "string" ||
      !HASH.test(consent.requestPayloadHash) ||
      !Number.isSafeInteger(consent.expectedRevision) ||
      (consent.expectedRevision as number) < 1 ||
      typeof consent.actorId !== "string" ||
      !ID.test(consent.actorId) ||
      consent.consentPolicyVersion !== PDF_OCR_CONSENT_POLICY_VERSION ||
      consent.consentDecision !== PDF_OCR_CONSENT_DECISION ||
      !instant(consent.consentedAt) ||
      consent.provider !== PDF_OCR_PROVIDER_ID ||
      consent.model !== PDF_OCR_MODEL_ID ||
      consent.purpose !== PDF_OCR_CONSENT_PURPOSE ||
      consent.region !== PDF_OCR_REGION ||
      consent.retentionDays !== PDF_OCR_RETENTION_DAYS ||
      consent.sendsFullOriginal !== true ||
      consent.includesMetadataAndEmbeddedContent !== true ||
      consent.includesPotentiallyNonVisibleContent !== true ||
      !(
        consent.usageId === null ||
        (typeof consent.usageId === "string" && ID.test(consent.usageId))
      )
    )
      throw new ImportSessionCorruptStateError("ocr_json");
    attachments.add(consent.attachmentId);
  }
  return structuredClone(value) as unknown as StoredPdfOcrStateV2;
}

export function serializePdfOcrState(state: StoredPdfOcrStateV2): string {
  const raw = canonical(state);
  if (
    Buffer.byteLength(raw, "utf8") >
    IMPORT_SESSION_LIMITS.jsonBytesPerDraftOrProposal
  )
    throw new ImportSessionCorruptStateError("ocr_json");
  parseStoredPdfOcrState(raw);
  return raw;
}
