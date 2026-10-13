export type CorpusPartition =
  | "SCANNED_PDF"
  | "MIXED_PDF"
  | "IMAGE"
  | "INVALID_ADMISSION"
  | "PROVIDER_TENANT_ADVERSARIAL";

export type ArtifactKind =
  | "PDF_SCAN"
  | "PDF_MIXED"
  | "PNG"
  | "JPEG"
  | "WEBP"
  | "GIF"
  | "PNG_NAMED_JPEG"
  | "TRUNCATED_PNG"
  | "OVERSIZED_DIMENSIONS"
  | "PDF_TOO_MANY_PAGES"
  | "OVERSIZED_BYTES"
  | "PROVIDER_ENVELOPE"
  | "TENANT_BYTES";

export interface OcrEvalRow {
  rowId: string;
  page: number;
  order: number;
  bbox: [number, number, number, number];
  description: string;
  amountText: string;
  amountCents: string;
  sign: "NEGATIVE" | "ZERO" | "POSITIVE";
  dateText: string | null;
  normalizedDate: string | null;
  dateExplicitness: "FULL" | "YEARLESS" | "MISSING";
  installmentText: string | null;
  installmentCurrent: number | null;
  installmentTotal: number | null;
}

export interface OcrEvalRegion {
  regionId: string;
  page: number;
  order: number;
  bbox: [number, number, number, number];
  rows: OcrEvalRow[];
}

export type OcrEvalExpected =
  | {
      kind: "SUCCESS";
      regions: OcrEvalRegion[];
      blankPages: number[];
      unreadablePages: number[];
      ignoredText: string[];
    }
  | {
      kind: "ERROR";
      errorCode: string;
      retryable: boolean;
    };

export interface OcrEvalCase {
  id: string;
  partition: CorpusPartition;
  tenantId: string;
  tags: string[];
  artifact: {
    kind: ArtifactKind;
    artifactSeed: string;
    pageCount: number;
    rotationDegrees: number;
    degradation: {
      blurRadius: number;
      contrastPercent: number;
      noisePercent: number;
      compressionQuality: number;
    };
    decorativeRasterLogo: boolean;
  };
  providerScenario?: string;
  adversarialText?: string;
  expected: OcrEvalExpected;
}

export interface OcrEvalDataset {
  datasetVersion: "ocr-synth-v1";
  schemaVersion: 1;
  baseSha: string;
  description: string;
  limits: {
    maxPages: number;
    maxPixels: number;
    maxBytes: number;
  };
  cases: OcrEvalCase[];
}

export interface OcrUsageEvidence {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface OcrCostEvidence {
  currency: "USD";
  amountMicros: number | null;
}

export interface OcrEvalPrediction {
  caseId: string;
  tenantId: string;
  artifactSha256: string;
  outcome: OcrEvalExpected;
  provider: string | null;
  model: string | null;
  modelVersion: string | null;
  promptSha256: string | null;
  latencyMs: number | null;
  peakRssBytes: number | null;
  usage: OcrUsageEvidence;
  cost: OcrCostEvidence;
  /** Unique provider request. Reuse across tenants is forbidden. */
  requestId: string | null;
}
