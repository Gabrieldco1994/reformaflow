import type {
  ImportSessionDraftLineV1,
  ImportSessionViewV1,
} from "@reformaflow/domain";

/** Exact user-intent body for the existing attachment analyze endpoint. */
export interface OcrAnalyzeRequestV2 {
  version: 2;
  expectedRevision: number;
  requestId: string;
  consentExternalProcessing: true;
}

export interface OcrConsentAnswerRequestV1 {
  version: 1;
  answerRequestId: string;
  expectedRevision: number;
  questionId: string;
  channel: "TEXT";
  input: { kind: "VALUE"; text: "ALLOW_EXTERNAL_PROCESSING" };
  answer: {
    field: "externalOcrConsent";
    value: "ALLOW_EXTERNAL_PROCESSING";
    attachmentId: string;
    requestId: string;
    consentPolicyVersion: 1;
    provider: "GOOGLE_VERTEX_AI";
    purpose: "DOCUMENT_LINE_TRANSCRIPTION_FOR_HUMAN_REVIEW";
    region: "southamerica-east1";
    retentionDays: 7;
    sendsFullOriginal: true;
    includesMetadataAndEmbeddedContent: true;
  };
}

export interface OcrReviewEvidenceV1 {
  origin: "GOOGLE_VERTEX_AI";
  model: "gemini-2.5-flash";
  region: "southamerica-east1";
  attachmentId: string;
  artifactFingerprint: string;
  candidateFingerprint: string;
  pageNumber: number;
  text: string;
}

export type OcrReviewLineV1 = ImportSessionDraftLineV1 & {
  ocrEvidence?: OcrReviewEvidenceV1;
};

export function lineOcrEvidence(
  line: Pick<ImportSessionDraftLineV1, "id" | "titulo">,
): OcrReviewEvidenceV1 | undefined {
  return (line as OcrReviewLineV1).ocrEvidence;
}

export interface OcrCapabilityV1 {
  status: "DISABLED" | "UNAVAILABLE" | "AVAILABLE";
  consentPolicyVersion: 1;
  provider: "GOOGLE_VERTEX_AI";
  purpose: "DOCUMENT_LINE_TRANSCRIPTION_FOR_HUMAN_REVIEW";
  region: "southamerica-east1";
  retentionDays: 7;
  sendsFullOriginal: true;
  includesMetadataAndEmbeddedContent: true;
  attachments: Array<{
    attachmentId: string;
    questionId: string;
    consentedRequestId: string | null;
    consentedRevision: number | null;
  }>;
}

export type ImportOcrSessionViewV1 = Omit<ImportSessionViewV1, "lines"> & {
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
