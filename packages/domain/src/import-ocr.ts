import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  type ImportSessionDateOnly,
  type ImportSessionHash,
} from "./import-session";

/** Analyze/consent request protocol; retained for deployed v2 clients. */
export const PDF_OCR_VERSION = 2 as const;
/** Strict provider document/parser contract. */
export const PDF_OCR_DOCUMENT_VERSION = 3 as const;
export const PDF_OCR_PROVIDER_ID = "GOOGLE_VERTEX_AI" as const;
export const PDF_OCR_MODEL_ID = "gemini-2.5-flash" as const;
export const PDF_OCR_REGION = "southamerica-east1" as const;
export const PDF_OCR_VERTEX_ENDPOINT =
  "https://southamerica-east1-aiplatform.googleapis.com" as const;
export const PDF_OCR_MAX_OUTPUT_TOKENS = 8192 as const;
export const PDF_OCR_MAX_INPUT_TOKENS = 24576 as const;
export const PDF_OCR_RESERVED_TOKEN_UNITS =
  PDF_OCR_MAX_INPUT_TOKENS + PDF_OCR_MAX_OUTPUT_TOKENS;
export const PDF_OCR_PARSER_VERSION = "card-vertex-ocr-v3" as const;
export const PDF_OCR_LEGACY_PARSER_VERSION = "card-vertex-ocr-v2" as const;
export const PDF_OCR_CONSENT_POLICY_VERSION = 1 as const;
export const PDF_OCR_CONSENT_PURPOSE =
  "DOCUMENT_LINE_TRANSCRIPTION_FOR_HUMAN_REVIEW" as const;
export const PDF_OCR_RETENTION_DAYS = 7 as const;
export const PDF_OCR_MODEL_VERSION_PATTERN = "^[\\x21-\\x7e]{1,192}$" as const;
export const PDF_OCR_PROVIDER_CANDIDATE_KEYS = Object.freeze([
  "pageNumber",
  "pageOccurrenceIndex",
  "description",
  "amountCents",
  "sign",
  "amountMeaning",
  "dateText",
  "normalizedDate",
  "dateExplicitness",
  "installment",
  "evidenceText",
] as const);

export const PDF_OCR_LIMITS = Object.freeze({
  pagesPerFile: 10,
  candidatesPerFile: 24,
  installmentsPerPurchase: IMPORT_SESSION_LIMITS.installmentsPerPurchase,
  descriptionLength: IMPORT_SESSION_PRIMITIVES.maxObservationTextLength,
  evidenceLength: IMPORT_SESSION_PRIMITIVES.maxObservationTextLength,
  providerRequestIdLength: IMPORT_SESSION_PRIMITIVES.maxReferenceLength,
  providerResponseBytes: IMPORT_SESSION_LIMITS.jsonBytesPerDraftOrProposal,
  providerLatencyMs: IMPORT_SESSION_LIMITS.parserDeadlineSeconds * 1000,
});

export type PdfOcrAmountMeaningV2 = "LINE_AMOUNT" | "UNKNOWN";
export type PdfOcrSignV3 = "NEGATIVE" | "ZERO" | "POSITIVE" | "UNKNOWN";
export type PdfOcrDateExplicitnessV3 =
  | "FULL"
  | "YEARLESS"
  | "MISSING"
  | "UNKNOWN";

export interface PdfOcrUsageV2 {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export type VertexAuthTraceV2 = "LOCAL_ADC" | "SERVICE_ACCOUNT_FILE_ADC";

export interface PdfOcrProviderRequestTraceV2 {
  readonly requestId: string;
  readonly endpoint: string;
  readonly authTrace: VertexAuthTraceV2;
  readonly adcScopes: readonly string[];
  readonly inputMimeType: "application/pdf";
  readonly inputMode: "INLINE_ORIGINAL_BYTES";
  readonly originalBytesSha256: string;
  readonly requestBodyBytes: number;
  readonly requestPlanSha256?: string;
  readonly countRequestBodySha256?: string;
  readonly generationRequestBodySha256?: string;
  readonly deadlineMs: number;
  readonly finishReason: "STOP";
  readonly maxOutputTokens: number;
  readonly promptSha256: string;
  readonly toolsPresent: false;
  readonly fileUri: null;
  readonly cachedContent: null;
}

export interface PdfOcrProviderProvenanceV2 {
  readonly provider: typeof PDF_OCR_PROVIDER_ID;
  readonly model: typeof PDF_OCR_MODEL_ID;
  /** Opaque provider-returned revision; it is not a compatibility signal. */
  readonly modelVersion: string;
  readonly region: typeof PDF_OCR_REGION;
  readonly requestId: string;
  readonly responseId: string;
  readonly usage: PdfOcrUsageV2;
  readonly latencyMs: number;
  /** Sanitized adapter evidence; never contains request bytes or credentials. */
  readonly requestTrace?: PdfOcrProviderRequestTraceV2;
}

export interface PdfOcrInstallmentV2 {
  readonly index: number;
  readonly total: number;
}

/** Visible line evidence retained for human documentary review. */
export interface PdfOcrEvidenceV2 {
  readonly pageNumber: number;
  readonly text: string;
}

export interface PdfOcrCandidateV2 {
  readonly pageNumber: number;
  readonly pageOccurrenceIndex: number;
  readonly description: string | null;
  /** Canonical signed cents string, including zero, or null when unreadable. */
  readonly amountCents: string | null;
  readonly sign: PdfOcrSignV3;
  readonly amountMeaning: PdfOcrAmountMeaningV2;
  readonly dateText: string | null;
  readonly normalizedDate: ImportSessionDateOnly | null;
  readonly dateExplicitness: PdfOcrDateExplicitnessV3;
  /** Compatibility projection. V3 populates it only for a FULL date. */
  readonly date: ImportSessionDateOnly | null;
  /** Financial projection. YEARLESS/MISSING/UNKNOWN never invent a year. */
  readonly dateOnly: ImportSessionDateOnly | null;
  readonly installment: PdfOcrInstallmentV2 | null;
  readonly evidenceText: string;
  readonly evidence: PdfOcrEvidenceV2;
  readonly selected: false;
  readonly verificationStatus: "UNVERIFIED";
}

export interface PdfOcrDocumentV2 {
  readonly version: typeof PDF_OCR_VERSION | typeof PDF_OCR_DOCUMENT_VERSION;
  readonly artifactSha256: ImportSessionHash;
  readonly pageCount: number;
  readonly provenance: PdfOcrProviderProvenanceV2;
  readonly candidates: readonly PdfOcrCandidateV2[];
}

/** Provider-controlled JSON before strict parsing and server identity derivation. */
export interface PdfOcrEnvelopeV2 {
  readonly candidates: readonly {
    readonly pageNumber: number;
    readonly description: string | null;
    readonly amountCents: string | null;
    readonly amountMeaning: PdfOcrAmountMeaningV2;
    readonly sign: PdfOcrSignV3;
    readonly dateText: string | null;
    readonly normalizedDate: string | null;
    readonly dateExplicitness: PdfOcrDateExplicitnessV3;
    readonly installment: PdfOcrInstallmentV2 | null;
    readonly evidenceText: string;
  }[];
}

/** V2 names remain source-compatible while the wire/document contract is V3. */
export type PdfOcrCandidateV3 = PdfOcrCandidateV2;
export type PdfOcrDocumentV3 = PdfOcrDocumentV2;
export type PdfOcrEnvelopeV3 = PdfOcrEnvelopeV2;
