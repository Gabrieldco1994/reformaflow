import policy from "./quality-closure-policy.json";

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
  evidenceText: string;
  candidateDisposition: "RAW_UNCLASSIFIED";
  amountText: string | null;
  amountCents: string | null;
  sign: "NEGATIVE" | "ZERO" | "POSITIVE" | "UNKNOWN";
  amountMeaning: "LINE_AMOUNT" | "UNKNOWN";
  dateText: string | null;
  normalizedDate: string | null;
  dateExplicitness: "FULL" | "YEARLESS" | "MISSING" | "UNKNOWN";
  installmentText: string | null;
  installmentCurrent: number | null;
  installmentTotal: number | null;
  installmentMeaning: "EXPLICIT" | "ABSENT" | "UNKNOWN";
  selected?: false;
  verificationStatus?: "UNVERIFIED";
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
  | { kind: "ERROR"; errorCode: string; retryable: boolean };

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
  fixtureRows?: Array<{
    page: number;
    evidenceText: string;
  }>;
  fixtureBlankPages?: number[];
  fixtureUnreadablePages?: number[];
  expected: OcrEvalExpected;
}

export interface OcrEvalDataset {
  datasetVersion: "ocr-synth-v1-direct-pdf-vertex-v3";
  schemaVersion: 4;
  baseSha: string;
  description: string;
  limits: { maxPages: 10; maxPixels: number; maxBytes: number };
  cases: OcrEvalCase[];
}

export interface OcrUsageEvidence {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface OcrCostEvidence {
  currency: "USD";
  amountMicros: number | null;
}

export interface OcrPromptContractEvidence {
  rawCandidatesOnly: boolean;
  allVisibleOccurrences: boolean;
  allPagesInOrder: boolean;
  preserveDuplicates: boolean;
  signedAmountIncludesNegativeZeroUnknown: boolean;
  noFinancialExclusionsOrClassification: boolean;
}

export interface DirectPdfAdapterTrace {
  seam: "VertexPdfOcrProvider.extractPdf";
  requestId: string;
  endpoint: string;
  region: string;
  model: string;
  authTrace: "LOCAL_ADC" | "SERVICE_ACCOUNT_FILE_ADC";
  adcScopes: string[];
  apiKeyUsed: boolean;
  globalEndpointFallbackUsed: boolean;
  inputMimeType: string;
  inputMode: "INLINE_ORIGINAL_BYTES";
  originalBytesSha256: string;
  requestBodyBytes: number;
  deadlineMs: number;
  finishReason: string | null;
  maxOutputTokens: number | null;
  promptContract: OcrPromptContractEvidence;
  toolsPresent: boolean;
  fileUri: string | null;
  cachedContent: string | null;
  providerCallCount: number;
  responseId: string | null;
  attempts: number;
  ambiguousTimeoutRetried: boolean;
  textualPdf: boolean;
  localFinancialRowsMerged: number;
}

export interface OcrConsentCapabilityEvidence {
  capability: "ANALYZE_ATTACHMENT_V2";
  consentPolicyVersion: 1;
  decision: "ALLOW_EXTERNAL_PROCESSING";
  purpose: "DOCUMENT_LINE_TRANSCRIPTION_FOR_HUMAN_REVIEW";
  provider: string;
  model: string;
  region: string;
  actorId: string;
  sessionRevision: number;
  attachmentId: string;
  artifactSha256: string;
  requestId: string;
  requestPayloadHash: string;
  completeOriginalFile: true;
  includesMetadataAndEmbeddedContent: true;
  includesPotentiallyNonVisibleContent: true;
  externalContentRetentionDays: 7;
}

export type OcrProviderSign = "NEGATIVE" | "ZERO" | "POSITIVE" | "UNKNOWN";

/** Exact projection of provider-returned candidate fields plus derived sign. */
export interface OcrProviderNativeCandidate {
  pageNumber: number;
  description: string | null;
  amountCents: string | null;
  sign: OcrProviderSign;
  amountMeaning: "LINE_AMOUNT" | "UNKNOWN";
  date: string | null;
  installment: { index: number; total: number } | null;
  evidenceText: string;
}

export type OcrProviderNativeOutcome =
  | { kind: "SUCCESS"; candidates: OcrProviderNativeCandidate[] }
  | { kind: "ERROR"; errorCode: string; retryable: boolean };

interface OcrEvalPredictionBase {
  caseId: string;
  tenantId: string;
  artifactSha256: string;
  outcome: OcrEvalExpected | OcrProviderNativeOutcome;
  provider: string | null;
  model: string | null;
  modelVersion: string | null;
  promptSha256: string | null;
  schemaValid: boolean;
  latencyMs: number | null;
  peakRssBytes: number | null;
  usage: OcrUsageEvidence;
  cost: OcrCostEvidence;
  adapterTrace: DirectPdfAdapterTrace | null;
  financialWrites: number;
}

export type OcrEvalPrediction = OcrEvalPredictionBase &
  (
    | {
        capturePath: "DIRECT_PROVIDER_CAPTURE";
        consentRecorded: false;
        consentCapability: null;
        attestationRequired: null;
      }
    | {
        capturePath: "REAL_IMPORT_SERVICE";
        consentRecorded: true;
        consentCapability: OcrConsentCapabilityEvidence;
        attestationRequired: true;
      }
  );

export interface OcrRoutingEvidence {
  caseId: string;
  tenantId: string;
  artifactSha256: string;
  source:
    | "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED"
    | "OFFLINE_EVALUATOR_SELF_TEST";
  detectedReasons: Array<
    "MIXED" | "SEARCHABLE" | "RASTER_LOGO" | "HIDDEN_TEXT"
  >;
  providerCalls: number;
  routedLocally: boolean;
  explicitFallback: boolean;
  financialWrites: number;
  testFile: string;
}

export const SAFETY_PROBE_IDS = Object.freeze(
  policy.qualificationTests
    .filter((item) => item.name.startsWith("[PROBE] "))
    .map((item) => item.name.slice("[PROBE] ".length)),
);

export type SafetyProbeId = string;

export const SAFETY_PROBE_SCENARIOS = Object.freeze({
  PARTIAL_RESPONSE: Object.freeze([
    "EMPTY_DECEPTION",
    "OMITTED_PAGE",
    "DUPLICATE_PAGE",
    "DECREASING_PAGE",
    "PAGE_COUNT_MISMATCH",
    "PAGE_OCCURRENCE_INDEX_GAP",
    "PAGE_OCCURRENCE_ORDER",
  ]),
  MALFORMED_RESPONSE: Object.freeze([
    "OUTER_DUPLICATE_KEY",
    "EMBEDDED_DUPLICATE_KEY",
  ]),
});

export interface OcrSafetyProbeEvidence {
  id: SafetyProbeId;
  source:
    | "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED"
    | "OFFLINE_EVALUATOR_SELF_TEST";
  blocked: boolean;
  explicitError: boolean;
  errorCode: string;
  providerCalls: number;
  financialWrites: number;
  durableStateVerified: boolean;
  finishReasonsTested: string[];
  scenarios?: string[];
  testFile: string;
}

export interface OcrQualityClosureTestEvidence {
  readonly name: string;
  readonly status: "PASS";
  readonly sourcePath: string;
}

export interface OcrRepositorySnapshot {
  readonly headSha: string;
  readonly treeSha: string;
  readonly clean: true;
  readonly policySha256: string;
  readonly corpusSha256: string;
  readonly configurationSha256: string;
  readonly adapterSha256: string;
  readonly runtimeSha256: string;
  readonly suiteSha256: string;
}

export interface OcrQualityClosure {
  readonly version: 2;
  readonly policyVersion: string;
  readonly snapshot: OcrRepositorySnapshot;
  readonly tests: readonly OcrQualityClosureTestEvidence[];
}
