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

export type OcrCapabilityV1 = NonNullable<ImportSessionViewV1["ocrCapability"]>;

export type ImportOcrSessionViewV1 = Omit<
  ImportSessionViewV1,
  "lines" | "ocrCapability"
> & {
  lines: OcrReviewLineV1[];
  ocrCapability: OcrCapabilityV1;
};

export type OcrUiState =
  | { kind: "CONSENT_REQUIRED" }
  | { kind: "REQUESTING" }
  | { kind: "OCR_UNAVAILABLE" }
  | { kind: "OCR_SAFETY_BLOCKED" }
  | { kind: "OCR_MALFORMED_RESPONSE" }
  | { kind: "OCR_ATTEMPT_UNKNOWN" }
  | { kind: "OCR_BUDGET_EXHAUSTED" }
  | { kind: "DOCUMENT_UNREADABLE" }
  | { kind: "PDF_PASSWORD_REQUIRED" }
  | { kind: "UNSUPPORTED_DOCUMENT" };

export type OcrTerminalUiState = Exclude<
  OcrUiState["kind"],
  "CONSENT_REQUIRED" | "REQUESTING"
>;

export type OcrUiPresentation = OcrUiState & {
  attachmentId: string;
};

export interface OcrUiScope {
  /** Opaque render identity only; it is never rendered or sent. */
  key: string;
  fileName: string;
}
