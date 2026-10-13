/** Exact user-intent body for the existing attachment analyze endpoint. */
export interface OcrAnalyzeRequestV2 {
  version: 2;
  expectedRevision: number;
  requestId: string;
  consentExternalProcessing: true;
}

export type OcrUiState =
  | { kind: "CONSENT_REQUIRED" }
  | { kind: "REQUESTING" }
  | { kind: "PRE_CALL_UNAVAILABLE" }
  | { kind: "DOCUMENT_UNSAFE" }
  | { kind: "SAFETY_OR_MALFORMED" }
  | { kind: "BUDGET_OR_RATE_LIMIT" }
  | { kind: "ATTEMPT_UNKNOWN" };

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
