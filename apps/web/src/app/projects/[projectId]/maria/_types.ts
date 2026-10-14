import type {
  ImportOcrReviewEvidenceV1,
  ImportSessionLineViewV1,
  ImportSessionOcrConsentAnswerRequestV1,
  ImportSessionViewV1,
} from "@reformaflow/domain";

/** Exact user-intent body for the existing attachment analyze endpoint. */
export interface OcrAnalyzeRequestV2 {
  version: 2;
  expectedRevision: number;
  requestId: string;
  consentExternalProcessing: true;
}

export type OcrConsentAnswerRequestV1 = ImportSessionOcrConsentAnswerRequestV1;
export type OcrReviewEvidenceV1 = ImportOcrReviewEvidenceV1;

export type OcrReviewLineV1 = ImportSessionLineViewV1;

export type OcrTerminalOutcomeCode =
  | "OCR_UNAVAILABLE"
  | "OCR_SAFETY_BLOCKED"
  | "OCR_MALFORMED_RESPONSE"
  | "OCR_ATTEMPT_UNKNOWN"
  | "LIMIT_EXCEEDED"
  | "DOCUMENT_UNREADABLE";

export interface OcrTerminalOutcomeV1 {
  attachmentId: string;
  code: OcrTerminalOutcomeCode;
}

type DomainOcrCapabilityV1 = NonNullable<ImportSessionViewV1["ocrCapability"]>;

/** Approved additive server projection until the domain package lands independently. */
export type OcrCapabilityV1 = DomainOcrCapabilityV1 & {
  terminalOutcomes: OcrTerminalOutcomeV1[];
};

export type ImportOcrSessionViewV1 = Omit<
  ImportSessionViewV1,
  "lines" | "ocrCapability"
> & {
  lines: OcrReviewLineV1[];
  ocrCapability: OcrCapabilityV1;
};

export type OcrUiState =
  | { kind: "CONSENT_REQUIRED" }
  | { kind: "CONSENTED_READY" }
  | { kind: "REQUESTING" }
  | { kind: "OCR_UNAVAILABLE" }
  | { kind: "OCR_SAFETY_BLOCKED" }
  | { kind: "OCR_MALFORMED_RESPONSE" }
  | { kind: "OCR_ATTEMPT_UNKNOWN" }
  | { kind: "OCR_BUDGET_EXHAUSTED" }
  | { kind: "LIMIT_EXCEEDED" }
  | { kind: "DOCUMENT_UNREADABLE" }
  | { kind: "PDF_PASSWORD_REQUIRED" }
  | { kind: "UNSUPPORTED_DOCUMENT" };

export type OcrTerminalUiState = Exclude<
  OcrUiState["kind"],
  "CONSENT_REQUIRED" | "CONSENTED_READY" | "REQUESTING"
>;

export type OcrUiPresentation = OcrUiState & {
  attachmentId: string;
};

export interface OcrUiScope {
  /** Opaque render identity only; it is never rendered or sent. */
  key: string;
  fileName: string;
}
