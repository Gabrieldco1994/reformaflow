/** Exact user-intent body for the existing attachment analyze endpoint. */
export interface OcrAnalyzeRequestV2 {
  version: 2;
  expectedRevision: number;
  requestId: string;
  consentExternalProcessing: true;
}

export interface OcrUiScope {
  /** Opaque render identity only; it is never rendered or sent. */
  key: string;
  fileName: string;
}
