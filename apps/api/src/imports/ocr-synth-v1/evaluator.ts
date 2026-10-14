import {
  OCR_SYNTH_DATASET,
  OCR_SYNTH_ROUTING_CASES,
  OCR_SYNTH_SCANNED_RELEASE_CASES,
} from "./corpus";
import {
  IMPORT_SESSION_PRIMITIVES,
  PDF_OCR_CONSENT_POLICY_VERSION,
  PDF_OCR_CONSENT_PURPOSE,
  PDF_OCR_LIMITS,
  PDF_OCR_MAX_OUTPUT_TOKENS,
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
  PDF_OCR_VERTEX_ENDPOINT,
} from "@reformaflow/domain";
import { artifactSha256, generateArtifact } from "./fixture-generator";
import {
  SAFETY_PROBE_IDS,
  SAFETY_PROBE_SCENARIOS,
  type OcrEvalCase,
  type OcrEvalExpected,
  type OcrEvalPrediction,
  type OcrProviderNativeCandidate,
  type OcrEvalRegion,
  type OcrRoutingEvidence,
  type OcrEvalRow,
  type OcrSafetyProbeEvidence,
} from "./types";
import policy from "./quality-closure-policy.json";
import { isCanonicalQualityClosure } from "./quality-closure-attestation";
import { isStructurallyValidatedLiveEvidence } from "./live-evidence-parser";
import type { OcrQualityClosure } from "./types";

const REQUEST_ID = new RegExp(IMPORT_SESSION_PRIMITIVES.requestIdPattern);

export const DIRECT_PDF_VERTEX_CONFIG = Object.freeze({
  provider: PDF_OCR_PROVIDER_ID,
  model: PDF_OCR_MODEL_ID,
  region: PDF_OCR_REGION,
  endpoint: PDF_OCR_VERTEX_ENDPOINT,
  mimeType: "application/pdf",
  seam: "VertexPdfOcrProvider.extractPdf",
  maxPages: PDF_OCR_LIMITS.pagesPerFile,
  maxOutputTokens: PDF_OCR_MAX_OUTPUT_TOKENS,
});

export const KNOWN_SAFETY_FINISH_REASONS = Object.freeze([
  "SAFETY",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "RECITATION",
  "IMAGE_SAFETY",
]);

export const OCR_SYNTH_THRESHOLDS = Object.freeze({
  ...policy.thresholds,
  maxPeakRssBytes: policy.declaredLimits.maxVmHwmBytes,
});

export interface OcrEvalRunConfig {
  mode: "OFFLINE_ORACLE" | "LIVE_CAPTURE";
  candidateSha: string | null;
  configurationSha256: string | null;
  adapterSha256: string | null;
  provider: string | null;
  model: string | null;
  modelVersion: string | null;
  region: string | null;
  endpoint: string | null;
  promptSha256: string | null;
  baseline: {
    sha: string;
    behavior: "OCR_REQUIRED";
    sampleCount: 18;
  };
  declaredLimits: {
    maxP95LatencyMs: number | null;
    maxTotalCostMicros: number | null;
    maxRequestBodyBytes: number | null;
    maxProviderDeadlineMs: number | null;
  };
  durableBudgets: null | {
    policySha256: string;
    tenantLimitMicros: number;
    globalLimitMicros: number;
    storage: "DATABASE";
  };
  residualRiskAcceptance: null | {
    decision: "OPTION_1_COMPLETE_ORIGINAL_PDF";
    dataOwnerAcceptanceSha256: string;
    noLocalDerivative: true;
  };
  finalReviews: null | {
    securityReviewSha256: string;
    privacyReviewSha256: string;
    dataOwnerReviewSha256: string;
  };
  pricing: null | {
    source: string;
    effectiveDate: string;
    inputMicrosPerMillionTokens: number;
    outputMicrosPerMillionTokens: number;
  };
}

export interface OcrEvalInput {
  datasetVersion: string;
  run: OcrEvalRunConfig;
  predictions: OcrEvalPrediction[];
  routingCases: OcrRoutingEvidence[];
  safetyProbes: OcrSafetyProbeEvidence[];
  qualityClosure?: unknown;
  rawResponses?: readonly unknown[];
  attemptLedger?: unknown;
}

interface Counters {
  expectedRows: number;
  readableMoneyRows: number;
  moneyMatches: number;
  signMatches: number;
  dateMatches: number;
  explicitnessMatches: number;
  installmentMatches: number;
  expectedUnknownFields: number;
  preservedUnknownFields: number;
  expectedEvidenceRows: number;
  visibleEvidenceMatches: number;
  inventedRows: number;
  omittedRows: number;
  tenantLeaks: number;
  schemaValidCases: number;
  falseAutomations: number;
  financialWrites: number;
}

export interface OcrEvalReport {
  reportSchemaVersion: 4;
  historicalComparison: "NOT_PERFORMED_P1_DEFERRED";
  datasetVersion: "ocr-synth-v1-direct-pdf-vertex-v3";
  corpusSampleCount: 52;
  releaseScannedPdfSampleCount: 18;
  routingSafetySampleCount: 10;
  futureImageSampleCount: 12;
  baseline: OcrEvalRunConfig["baseline"];
  candidate: Omit<OcrEvalRunConfig, "baseline" | "declaredLimits" | "pricing">;
  thresholds: typeof OCR_SYNTH_THRESHOLDS;
  metrics: {
    scannedTaskSuccessRate: number;
    exactMoneyRate: number;
    exactSignRate: number;
    exactDateRate: number;
    exactDateExplicitnessRate: number;
    exactInstallmentRate: number;
    unknownPreservationRate: number;
    visibleEvidenceRate: number;
    schemaValidityRate: number;
    inventedRows: number;
    omittedRows: number;
    tenantLeaks: number;
    falseAutomations: number;
    financialWrites: number;
    p95LatencyMs: number | null;
    peakRssBytes: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    totalCostMicros: number | null;
    costCurrency: "USD";
  };
  perCase: Array<{ caseId: string; pass: boolean; issues: string[] }>;
  regressions: Array<{ caseId: string; issues: string[] }>;
  routingCases: Array<{ caseId: string; pass: boolean; issues: string[] }>;
  safetyProbes: Array<{ id: string; pass: boolean; issues: string[] }>;
  fallbackSafety: {
    explicitFailures: boolean;
    emptySuccessAccepted: false;
    financialWritesPerformed: number;
    tenantLeakCount: number;
    routingProviderCalls: number;
  };
  liveEvidenceGaps: string[];
  functionalStatus: "PASS" | "FAIL";
  releaseStatus: "PASS" | "GAPS";
}

const expectedArtifactHashes = new Map<string, Promise<string>>();
function expectedArtifactSha256(testCase: OcrEvalCase): Promise<string> {
  const cached = expectedArtifactHashes.get(testCase.id);
  if (cached) return cached;
  const computed = generateArtifact(testCase).then(artifactSha256);
  expectedArtifactHashes.set(testCase.id, computed);
  return computed;
}
function finiteNonNegative(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function safeRate(matches: number, total: number): number {
  return total === 0 ? 1 : matches / total;
}
function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

function compareRow(
  expected: OcrEvalRow,
  actual: OcrEvalRow | undefined,
  counters: Counters,
  issues: string[],
): void {
  if (!actual) return;

  counters.expectedEvidenceRows++;
  if (
    expected.evidenceText.length > 0 &&
    actual.evidenceText === expected.evidenceText
  )
    counters.visibleEvidenceMatches++;
  else issues.push("VISIBLE_EVIDENCE_MISMATCH");

  if (expected.amountCents === null || expected.sign === "UNKNOWN") {
    counters.expectedUnknownFields++;
    if (
      actual.amountCents === null &&
      actual.sign === "UNKNOWN" &&
      actual.amountMeaning === "UNKNOWN"
    )
      counters.preservedUnknownFields++;
    else {
      counters.inventedRows++;
      issues.push("UNKNOWN_AMOUNT_INVENTED");
    }
  } else {
    counters.readableMoneyRows++;
    if (actual.amountCents === expected.amountCents) counters.moneyMatches++;
    else issues.push("MONEY_MISMATCH");
    if (actual.sign === expected.sign) counters.signMatches++;
    else issues.push("SIGN_MISMATCH");
  }

  if (expected.amountMeaning === "UNKNOWN") {
    counters.expectedUnknownFields++;
    if (actual.amountMeaning === "UNKNOWN") counters.preservedUnknownFields++;
    else issues.push("AMOUNT_MEANING_INVENTED");
  } else if (actual.amountMeaning !== expected.amountMeaning)
    issues.push("AMOUNT_MEANING_MISMATCH");

  if (
    actual.dateText === expected.dateText &&
    actual.normalizedDate === expected.normalizedDate
  )
    counters.dateMatches++;
  else issues.push("DATE_MISMATCH");
  if (actual.dateExplicitness === expected.dateExplicitness)
    counters.explicitnessMatches++;
  else issues.push("DATE_EXPLICITNESS_MISMATCH");
  if (expected.dateExplicitness === "UNKNOWN") {
    counters.expectedUnknownFields++;
    if (
      actual.dateText === null &&
      actual.normalizedDate === null &&
      actual.dateExplicitness === "UNKNOWN"
    )
      counters.preservedUnknownFields++;
    else issues.push("UNKNOWN_DATE_INVENTED");
  }

  if (
    actual.installmentText === expected.installmentText &&
    actual.installmentCurrent === expected.installmentCurrent &&
    actual.installmentTotal === expected.installmentTotal &&
    actual.installmentMeaning === expected.installmentMeaning
  )
    counters.installmentMatches++;
  else issues.push("INSTALLMENT_MISMATCH");
  if (expected.installmentMeaning === "UNKNOWN") {
    counters.expectedUnknownFields++;
    if (actual.installmentMeaning === "UNKNOWN")
      counters.preservedUnknownFields++;
    else issues.push("INSTALLMENT_MEANING_INVENTED");
  }

  if (actual.candidateDisposition !== "RAW_UNCLASSIFIED") {
    counters.falseAutomations++;
    issues.push("PROMPT_FINANCIAL_DECISION");
  }
  if (actual.selected !== false || actual.verificationStatus !== "UNVERIFIED") {
    counters.falseAutomations++;
    issues.push("UNSAFE_CANDIDATE_DEFAULT");
  }
  if (
    actual.rowId !== expected.rowId ||
    actual.page !== expected.page ||
    actual.order !== expected.order ||
    actual.description !== expected.description ||
    actual.amountText !== expected.amountText ||
    JSON.stringify(actual.bbox) !== JSON.stringify(expected.bbox)
  )
    issues.push("ROW_SCHEMA_OR_PROVENANCE_MISMATCH");
}

function compareRegion(
  expected: OcrEvalRegion,
  actual: OcrEvalRegion | undefined,
  counters: Counters,
  issues: string[],
): void {
  if (!actual) {
    counters.omittedRows += expected.rows.length;
    issues.push("MISSING_REGION");
    return;
  }
  if (
    actual.regionId !== expected.regionId ||
    actual.page !== expected.page ||
    actual.order !== expected.order ||
    JSON.stringify(actual.bbox) !== JSON.stringify(expected.bbox)
  )
    issues.push("REGION_ORDER_OR_PROVENANCE_MISMATCH");
  const common = Math.min(expected.rows.length, actual.rows.length);
  for (let index = 0; index < common; index++)
    compareRow(expected.rows[index]!, actual.rows[index], counters, issues);
  if (actual.rows.length > expected.rows.length) {
    counters.inventedRows += actual.rows.length - expected.rows.length;
    issues.push("INVENTED_ROW");
  }
  if (actual.rows.length < expected.rows.length) {
    counters.omittedRows += expected.rows.length - actual.rows.length;
    issues.push("OMITTED_ROW");
  }
}

function compareOutcome(
  testCase: OcrEvalCase,
  prediction: OcrEvalPrediction,
  counters: Counters,
  issues: string[],
  strictProviderDateTriples: boolean,
): void {
  if (testCase.expected.kind !== prediction.outcome.kind) {
    issues.push("OUTCOME_KIND_MISMATCH");
    if (testCase.expected.kind === "SUCCESS") {
      const missing = testCase.expected.regions.flatMap(
        (region) => region.rows,
      ).length;
      counters.expectedRows += missing;
      counters.omittedRows += missing;
    }
    return;
  }
  if (testCase.expected.kind === "ERROR") {
    const actual = prediction.outcome as Extract<
      typeof prediction.outcome,
      { kind: "ERROR" }
    >;
    if (
      actual.errorCode !== testCase.expected.errorCode ||
      actual.retryable !== testCase.expected.retryable
    )
      issues.push("TERMINAL_OUTCOME_MISMATCH");
    return;
  }
  const expected = testCase.expected;
  const actual = prediction.outcome as Extract<
    typeof prediction.outcome,
    { kind: "SUCCESS" }
  >;
  if ("candidates" in actual) {
    compareProviderNativeOutcome(expected, actual.candidates, counters, issues);
    return;
  }
  counters.expectedRows += expected.regions.flatMap(
    (region) => region.rows,
  ).length;
  const common = Math.min(expected.regions.length, actual.regions.length);
  for (let index = 0; index < common; index++)
    compareRegion(
      expected.regions[index]!,
      actual.regions[index],
      counters,
      issues,
    );
  if (actual.regions.length > expected.regions.length) {
    counters.inventedRows += actual.regions
      .slice(expected.regions.length)
      .flatMap((region) => region.rows).length;
    issues.push("UNEXPECTED_REGION");
  }

  function compareProviderNativeRow(
    expected: OcrEvalRow,
    actual: OcrProviderNativeCandidate | undefined,
    expectedPageOccurrenceIndex: number,
    counters: Counters,
    issues: string[],
  ): void {
    if (!actual) return;
    counters.expectedEvidenceRows++;
    if (
      expected.evidenceText.length > 0 &&
      actual.evidenceText === expected.evidenceText
    )
      counters.visibleEvidenceMatches++;
    else issues.push("VISIBLE_EVIDENCE_MISMATCH");

    if (expected.amountCents === null || expected.sign === "UNKNOWN") {
      counters.expectedUnknownFields++;
      if (
        actual.amountCents === null &&
        actual.sign === "UNKNOWN" &&
        actual.amountMeaning === "UNKNOWN"
      )
        counters.preservedUnknownFields++;
      else {
        counters.inventedRows++;
        issues.push("UNKNOWN_AMOUNT_INVENTED");
      }
    } else {
      counters.readableMoneyRows++;
      if (actual.amountCents === expected.amountCents) counters.moneyMatches++;
      else issues.push("MONEY_MISMATCH");
      if (actual.sign === expected.sign) counters.signMatches++;
      else issues.push("SIGN_MISMATCH");
    }
    if (expected.amountMeaning === "UNKNOWN") {
      counters.expectedUnknownFields++;
      if (actual.amountMeaning === "UNKNOWN") counters.preservedUnknownFields++;
      else issues.push("AMOUNT_MEANING_INVENTED");
    } else if (actual.amountMeaning !== expected.amountMeaning)
      issues.push("AMOUNT_MEANING_MISMATCH");

    const expectedNormalizedDate =
      strictProviderDateTriples && expected.dateExplicitness !== "FULL"
        ? null
        : expected.normalizedDate;
    if (
      actual.dateText === expected.dateText &&
      actual.normalizedDate === expectedNormalizedDate
    )
      counters.dateMatches++;
    else issues.push("DATE_MISMATCH");
    if (actual.dateExplicitness === expected.dateExplicitness)
      counters.explicitnessMatches++;
    else issues.push("DATE_EXPLICITNESS_MISMATCH");
    if (expected.dateExplicitness === "UNKNOWN") {
      counters.expectedUnknownFields++;
      if (
        actual.normalizedDate === null &&
        actual.dateExplicitness === "UNKNOWN"
      )
        counters.preservedUnknownFields++;
      else issues.push("UNKNOWN_DATE_INVENTED");
    }

    if (
      actual.installment?.index === expected.installmentCurrent &&
      actual.installment?.total === expected.installmentTotal
    )
      counters.installmentMatches++;
    else if (
      actual.installment === null &&
      expected.installmentCurrent === null &&
      expected.installmentTotal === null
    )
      counters.installmentMatches++;
    else issues.push("INSTALLMENT_MISMATCH");
    if (expected.installmentMeaning === "UNKNOWN") {
      counters.expectedUnknownFields++;
      if (actual.installment === null) counters.preservedUnknownFields++;
      else issues.push("INSTALLMENT_MEANING_INVENTED");
    }

    if (
      actual.pageNumber !== expected.page ||
      actual.pageOccurrenceIndex !== expectedPageOccurrenceIndex ||
      actual.description !== expected.description
    )
      issues.push("ROW_SCHEMA_OR_PROVENANCE_MISMATCH");
    if (actual.selected !== false || actual.verificationStatus !== "UNVERIFIED")
      issues.push("UNSAFE_CANDIDATE_DEFAULT");
    if (actual.candidateDisposition !== "RAW_UNCLASSIFIED")
      issues.push("PROMPT_FINANCIAL_DECISION");
  }

  function compareProviderNativeOutcome(
    expected: Extract<OcrEvalExpected, { kind: "SUCCESS" }>,
    actual: readonly OcrProviderNativeCandidate[],
    counters: Counters,
    issues: string[],
  ): void {
    const expectedRows = expected.regions
      .flatMap((region) => region.rows)
      .sort(
        (left, right) => left.page - right.page || left.order - right.order,
      );
    counters.expectedRows += expectedRows.length;
    const pageOccurrences = new Map<number, number>();
    const common = Math.min(expectedRows.length, actual.length);
    for (let index = 0; index < common; index++) {
      const page = expectedRows[index]!.page;
      const pageOccurrenceIndex = (pageOccurrences.get(page) ?? 0) + 1;
      pageOccurrences.set(page, pageOccurrenceIndex);
      compareProviderNativeRow(
        expectedRows[index]!,
        actual[index],
        pageOccurrenceIndex,
        counters,
        issues,
      );
    }
    if (actual.length > expectedRows.length) {
      counters.inventedRows += actual.length - expectedRows.length;
      issues.push("INVENTED_ROW");
    }
    if (actual.length < expectedRows.length) {
      counters.omittedRows += expectedRows.length - actual.length;
      issues.push("OMITTED_ROW");
    }
  }
  for (const region of expected.regions.slice(common))
    compareRegion(region, undefined, counters, issues);
  if (
    JSON.stringify(actual.blankPages) !== JSON.stringify(expected.blankPages) ||
    JSON.stringify(actual.unreadablePages) !==
      JSON.stringify(expected.unreadablePages)
  )
    issues.push("PAGE_STATUS_MISMATCH");
}

function addTraceIssues(
  prediction: OcrEvalPrediction,
  expectedHash: string,
  run: OcrEvalRunConfig,
  counters: Counters,
  issues: string[],
): void {
  const trace = prediction.adapterTrace;
  if (!trace) {
    issues.push("MISSING_REAL_ADAPTER_TRACE");
    return;
  }
  if (trace.seam !== DIRECT_PDF_VERTEX_CONFIG.seam)
    issues.push("WRONG_ADAPTER_SEAM");
  if (!REQUEST_ID.test(trace.requestId)) issues.push("INVALID_REQUEST_ID");
  if (trace.endpoint !== DIRECT_PDF_VERTEX_CONFIG.endpoint)
    issues.push("WRONG_ENDPOINT");
  if (trace.region !== DIRECT_PDF_VERTEX_CONFIG.region)
    issues.push("WRONG_REGION");
  if (trace.model !== DIRECT_PDF_VERTEX_CONFIG.model)
    issues.push("WRONG_MODEL");
  if (
    (trace.authTrace !== "LOCAL_ADC" &&
      trace.authTrace !== "SERVICE_ACCOUNT_FILE_ADC" &&
      trace.authTrace !== "GITHUB_OIDC_WIF") ||
    trace.apiKeyUsed
  )
    issues.push("API_KEY_OR_AUTH_VIOLATION");
  if (
    JSON.stringify(trace.adcScopes) !==
    JSON.stringify(["https://www.googleapis.com/auth/cloud-platform"])
  )
    issues.push("UNBOUNDED_ADC_SCOPE");
  if (
    !finiteNonNegative(trace.requestBodyBytes) ||
    trace.requestBodyBytes === 0 ||
    !finiteNonNegative(run.declaredLimits.maxRequestBodyBytes) ||
    trace.requestBodyBytes > run.declaredLimits.maxRequestBodyBytes
  )
    issues.push("REQUEST_BODY_LIMIT_NOT_MET");
  if (
    !finiteNonNegative(trace.deadlineMs) ||
    trace.deadlineMs === 0 ||
    !finiteNonNegative(run.declaredLimits.maxProviderDeadlineMs) ||
    trace.deadlineMs > run.declaredLimits.maxProviderDeadlineMs
  )
    issues.push("DEADLINE_LIMIT_NOT_MET");
  if (trace.finishReason !== "STOP") issues.push("MISSING_STOP_FINISH_REASON");
  if (trace.maxOutputTokens !== DIRECT_PDF_VERTEX_CONFIG.maxOutputTokens)
    issues.push("MISSING_8K_OUTPUT_LIMIT_EVIDENCE");
  if (
    !trace.promptContract.rawCandidatesOnly ||
    !trace.promptContract.allVisibleOccurrences ||
    !trace.promptContract.allPagesInOrder ||
    !trace.promptContract.preserveDuplicates ||
    !trace.promptContract.signedAmountIncludesNegativeZeroUnknown ||
    !trace.promptContract.noFinancialExclusionsOrClassification
  )
    issues.push("PROMPT_COMPLETENESS_CONTRACT_MISSING");
  if (trace.globalEndpointFallbackUsed) issues.push("GLOBAL_ENDPOINT_FALLBACK");
  if (
    trace.inputMimeType !== DIRECT_PDF_VERTEX_CONFIG.mimeType ||
    trace.inputMode !== "INLINE_ORIGINAL_BYTES" ||
    trace.originalBytesSha256 !== expectedHash
  )
    issues.push("NOT_ORIGINAL_DIRECT_PDF_BYTES");
  if (trace.toolsPresent) issues.push("TOOLS_PRESENT");
  if (trace.fileUri !== null) issues.push("FILE_URI_PRESENT");
  if (trace.cachedContent !== null) issues.push("CACHE_PRESENT");
  if (trace.providerCallCount !== 2) issues.push("WRONG_PROVIDER_CALL_COUNT");
  if (!trace.responseId) issues.push("MISSING_PROVIDER_RESPONSE_ID");
  if (trace.attempts !== 1 || trace.ambiguousTimeoutRetried)
    issues.push("AMBIGUOUS_RETRY");
  if (trace.textualPdf) issues.push("TEXTUAL_PDF_SENT_TO_PROVIDER");
  if (trace.localFinancialRowsMerged !== 0) {
    counters.inventedRows += trace.localFinancialRowsMerged;
    issues.push("DUPLICATED_LOCAL_PROVIDER_ROWS");
  }
  if (prediction.capturePath === "REAL_IMPORT_SERVICE") {
    if (prediction.consentRecorded !== true) issues.push("MISSING_CONSENT");
    if (prediction.attestationRequired !== true)
      issues.push("ATTESTATION_NOT_REQUIRED");
    const consent = prediction.consentCapability as
      | typeof prediction.consentCapability
      | null;
    if (
      !consent ||
      consent.capability !== "ANALYZE_ATTACHMENT_V2" ||
      consent.consentPolicyVersion !== PDF_OCR_CONSENT_POLICY_VERSION ||
      consent.decision !== "ALLOW_EXTERNAL_PROCESSING" ||
      consent.purpose !== PDF_OCR_CONSENT_PURPOSE ||
      consent.provider !== DIRECT_PDF_VERTEX_CONFIG.provider ||
      consent.model !== DIRECT_PDF_VERTEX_CONFIG.model ||
      consent.region !== DIRECT_PDF_VERTEX_CONFIG.region ||
      consent.actorId !== `actor-${prediction.tenantId}` ||
      consent.sessionRevision !== 2 ||
      consent.attachmentId !== `attachment-${prediction.caseId}` ||
      consent.artifactSha256 !== expectedHash ||
      consent.requestId !== trace.requestId ||
      consent.completeOriginalFile !== true ||
      consent.includesMetadataAndEmbeddedContent !== true ||
      consent.includesPotentiallyNonVisibleContent !== true ||
      consent.externalContentRetentionDays !== 7
    )
      issues.push("CONSENT_CAPABILITY_MISMATCH");
    if (prediction.financialWrites !== 0) issues.push("FINANCIAL_WRITE");
    counters.financialWrites += prediction.financialWrites;
  }
}

export const REAL_SERVICE_CONTEXT_PROBE_IDS = Object.freeze([
  "EXACT_CONSENT_CAPABILITY",
  "PRIOR_CONSENT_DECLARATION",
  "MISSING_CONSENT",
  "MISSING_ATTESTATION",
  "SELECTED_TRUE_DEFAULT",
  "VERIFIED_DEFAULT",
] as const);
export const REAL_SERVICE_CONTEXT_TEST =
  "apps/api/src/imports/import-session/ocr/pdf-ocr-analyze.integration.spec.ts";

export const OCR_PROVIDER_CALL_PROBE_IDS = new Set([
  "ADC_SCOPE_BOUNDED",
  "REQUEST_BODY_BOUNDED",
  "DEADLINE_BOUNDED",
  "MIXED_LOCAL_PROVIDER_DUPLICATION",
  "PARTIAL_RESPONSE",
  "MALFORMED_RESPONSE",
  "TRUNCATED_RESPONSE",
  "SAFETY_BLOCKED_RESPONSE",
  "AMBIGUOUS_TIMEOUT_RETRY",
  "UNKNOWN_OUTCOME_NO_RETRY",
  "SELECTED_TRUE_DEFAULT",
  "VERIFIED_DEFAULT",
  "KNOWN_SAFETY_FINISH_REASONS",
]);

export const OCR_DURABLE_PROBE_IDS = new Set([
  "DURABLE_TENANT_BUDGET",
  "DURABLE_GLOBAL_BUDGET",
  "ACTIVE_SESSION_CONTENT_PURGE_AFTER_7_DAYS",
  "TERMINAL_FAILURE_REPLAY_NO_CALL",
]);

export function buildOracleSafetyProbes(): OcrSafetyProbeEvidence[] {
  return SAFETY_PROBE_IDS.map((id) => ({
    id,
    source: "OFFLINE_EVALUATOR_SELF_TEST",
    blocked: true,
    explicitError: true,
    errorCode: `BLOCKED_${id}`,
    providerCalls: OCR_PROVIDER_CALL_PROBE_IDS.has(id) ? 1 : 0,
    financialWrites: 0,
    durableStateVerified: OCR_DURABLE_PROBE_IDS.has(id),
    finishReasonsTested:
      id === "KNOWN_SAFETY_FINISH_REASONS"
        ? [...KNOWN_SAFETY_FINISH_REASONS]
        : [],
    ...(id === "PARTIAL_RESPONSE"
      ? {
          scenarios: [...SAFETY_PROBE_SCENARIOS.PARTIAL_RESPONSE],
        }
      : id === "MALFORMED_RESPONSE"
        ? {
            scenarios: [...SAFETY_PROBE_SCENARIOS.MALFORMED_RESPONSE],
          }
        : {}),
    testFile:
      "apps/api/src/imports/ocr-synth-v1/direct-pdf-vertex-safety.spec.ts",
  }));
}

export async function buildOracleRoutingCases(): Promise<OcrRoutingEvidence[]> {
  const results: OcrRoutingEvidence[] = [];
  for (const testCase of OCR_SYNTH_ROUTING_CASES) {
    const detectedReasons: OcrRoutingEvidence["detectedReasons"] = [
      "MIXED",
      "SEARCHABLE",
    ];
    if (testCase.tags.includes("raster-logo"))
      detectedReasons.push("RASTER_LOGO");
    if (testCase.tags.includes("hidden-text"))
      detectedReasons.push("HIDDEN_TEXT");
    results.push({
      caseId: testCase.id,
      tenantId: testCase.tenantId,
      artifactSha256: await expectedArtifactSha256(testCase),
      source: "OFFLINE_EVALUATOR_SELF_TEST",
      detectedReasons,
      providerCalls: 0,
      routedLocally: true,
      explicitFallback: true,
      financialWrites: 0,
      testFile:
        "apps/api/src/imports/ocr-synth-v1/direct-pdf-vertex-safety.spec.ts",
    });
  }
  return results;
}

export async function buildOraclePredictions(
  liveFields = false,
): Promise<OcrEvalPrediction[]> {
  const results: OcrEvalPrediction[] = [];
  for (const [index, testCase] of OCR_SYNTH_SCANNED_RELEASE_CASES.entries()) {
    const hash = await expectedArtifactSha256(testCase);
    const fixtureRequestId = `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const outcome = structuredClone(testCase.expected);
    if (outcome.kind === "SUCCESS")
      for (const row of outcome.regions.flatMap((region) => region.rows)) {
        row.selected = false;
        row.verificationStatus = "UNVERIFIED";
      }
    results.push({
      caseId: testCase.id,
      tenantId: testCase.tenantId,
      artifactSha256: hash,
      outcome,
      provider: liveFields ? DIRECT_PDF_VERTEX_CONFIG.provider : null,
      model: liveFields ? DIRECT_PDF_VERTEX_CONFIG.model : null,
      modelVersion: liveFields ? "evaluator-fixture-version" : null,
      promptSha256: liveFields ? "a".repeat(64) : null,
      schemaValid: true,
      latencyMs: liveFields ? 1 : null,
      peakRssBytes: liveFields ? 1 : null,
      usage: {
        inputTokens: liveFields ? 1 : null,
        outputTokens: liveFields ? 1 : null,
        totalTokens: liveFields ? 2 : null,
      },
      cost: { currency: "USD", amountMicros: liveFields ? 2 : null },
      adapterTrace: liveFields
        ? {
            seam: DIRECT_PDF_VERTEX_CONFIG.seam,
            requestId: fixtureRequestId,
            endpoint: DIRECT_PDF_VERTEX_CONFIG.endpoint,
            region: DIRECT_PDF_VERTEX_CONFIG.region,
            model: DIRECT_PDF_VERTEX_CONFIG.model,
            authTrace: "SERVICE_ACCOUNT_FILE_ADC",
            adcScopes: ["https://www.googleapis.com/auth/cloud-platform"],
            apiKeyUsed: false,
            globalEndpointFallbackUsed: false,
            inputMimeType: DIRECT_PDF_VERTEX_CONFIG.mimeType,
            inputMode: "INLINE_ORIGINAL_BYTES",
            originalBytesSha256: hash,
            requestBodyBytes: 1,
            deadlineMs: 1,
            finishReason: "STOP",
            maxOutputTokens: DIRECT_PDF_VERTEX_CONFIG.maxOutputTokens,
            promptContract: {
              rawCandidatesOnly: true,
              allVisibleOccurrences: true,
              allPagesInOrder: true,
              preserveDuplicates: true,
              signedAmountIncludesNegativeZeroUnknown: true,
              noFinancialExclusionsOrClassification: true,
            },
            toolsPresent: false,
            fileUri: null,
            cachedContent: null,
            providerCallCount: 2,
            responseId: `evaluator-only-${testCase.id}`,
            attempts: 1,
            ambiguousTimeoutRetried: false,
            textualPdf: false,
            localFinancialRowsMerged: 0,
          }
        : null,
      ...(liveFields
        ? {
            capturePath: "REAL_IMPORT_SERVICE" as const,
            consentRecorded: true as const,
            consentCapability: {
              capability: "ANALYZE_ATTACHMENT_V2",
              consentPolicyVersion: PDF_OCR_CONSENT_POLICY_VERSION,
              decision: "ALLOW_EXTERNAL_PROCESSING",
              purpose: PDF_OCR_CONSENT_PURPOSE,
              provider: PDF_OCR_PROVIDER_ID,
              model: PDF_OCR_MODEL_ID,
              region: PDF_OCR_REGION,
              actorId: `actor-${testCase.tenantId}`,
              sessionRevision: 2,
              attachmentId: `attachment-${testCase.id}`,
              artifactSha256: hash,
              requestId: fixtureRequestId,
              requestPayloadHash: artifactSha256(Buffer.from(fixtureRequestId)),
              completeOriginalFile: true,
              includesMetadataAndEmbeddedContent: true,
              includesPotentiallyNonVisibleContent: true,
              externalContentRetentionDays: 7,
            },
            attestationRequired: true as const,
          }
        : {
            capturePath: "DIRECT_PROVIDER_CAPTURE" as const,
            consentRecorded: false as const,
            consentCapability: null,
            attestationRequired: null,
          }),
      financialWrites: 0,
    });
  }
  return results;
}

export async function evaluateOcrSynth(
  input: OcrEvalInput,
  _activationAuthority?: unknown,
): Promise<OcrEvalReport> {
  const structurallyValidatedLiveEvidence =
    isStructurallyValidatedLiveEvidence(input);
  const mechanicalObservations = structurallyValidatedLiveEvidence
    ? (input.qualityClosure as OcrQualityClosure).tests
    : [];
  const mechanicalObservationNames = new Set(
    mechanicalObservations.map(({ name }) => name),
  );
  const routingEvidence = input.routingCases ?? [];
  const safetyEvidence = input.safetyProbes ?? [];
  const counters: Counters = {
    expectedRows: 0,
    readableMoneyRows: 0,
    moneyMatches: 0,
    signMatches: 0,
    dateMatches: 0,
    explicitnessMatches: 0,
    installmentMatches: 0,
    expectedUnknownFields: 0,
    preservedUnknownFields: 0,
    expectedEvidenceRows: 0,
    visibleEvidenceMatches: 0,
    inventedRows: 0,
    omittedRows: 0,
    tenantLeaks: 0,
    schemaValidCases: 0,
    falseAutomations: 0,
    financialWrites: 0,
  };
  const byId = new Map(
    input.predictions.map((prediction) => [prediction.caseId, prediction]),
  );
  const expectedIds = new Set(
    OCR_SYNTH_SCANNED_RELEASE_CASES.map((item) => item.id),
  );
  const structuralIssues =
    input.predictions.length -
    byId.size +
    [...byId.keys()].filter((id) => !expectedIds.has(id)).length;
  const perCase: OcrEvalReport["perCase"] = [];
  for (const testCase of OCR_SYNTH_SCANNED_RELEASE_CASES) {
    const issues: string[] = [];
    const prediction = byId.get(testCase.id);
    if (!prediction) {
      issues.push("MISSING_CASE");
      if (testCase.expected.kind === "SUCCESS") {
        const missing = testCase.expected.regions.flatMap(
          (region) => region.rows,
        ).length;
        counters.expectedRows += missing;
        counters.omittedRows += missing;
      }
      perCase.push({ caseId: testCase.id, pass: false, issues });
      continue;
    }
    const expectedHash = await expectedArtifactSha256(testCase);
    if (prediction.artifactSha256 !== expectedHash)
      issues.push("ARTIFACT_HASH_MISMATCH");
    if (prediction.tenantId !== testCase.tenantId) {
      counters.tenantLeaks++;
      issues.push("TENANT_BINDING_MISMATCH");
    }
    compareOutcome(
      testCase,
      prediction,
      counters,
      issues,
      structurallyValidatedLiveEvidence,
    );
    if (!prediction.schemaValid) issues.push("SCHEMA_INVALID");
    if (input.run.mode === "LIVE_CAPTURE")
      addTraceIssues(prediction, expectedHash, input.run, counters, issues);
    if (issues.length === 0) counters.schemaValidCases++;
    perCase.push({
      caseId: testCase.id,
      pass: issues.length === 0,
      issues: [...new Set(issues)],
    });
  }
  const routingById = new Map(
    routingEvidence.map((route) => [route.caseId, route]),
  );
  const routingExpectedIds = new Set(
    OCR_SYNTH_ROUTING_CASES.map((item) => item.id),
  );
  const routeObservationNames = mechanicalObservations
    .filter(({ name }) => name.startsWith("[ROUTE] "))
    .map(({ name }) => name.slice("[ROUTE] ".length));
  const routingStructuralIssues = structurallyValidatedLiveEvidence
    ? routeObservationNames.length -
      new Set(routeObservationNames).size +
      routeObservationNames.filter((id) => !routingExpectedIds.has(id)).length
    : routingEvidence.length -
      routingById.size +
      [...routingById.keys()].filter((id) => !routingExpectedIds.has(id))
        .length;
  const routingCases: OcrEvalReport["routingCases"] = [];
  for (const testCase of OCR_SYNTH_ROUTING_CASES) {
    const issues: string[] = [];
    if (structurallyValidatedLiveEvidence) {
      if (!mechanicalObservationNames.has(`[ROUTE] ${testCase.id}`))
        issues.push("MISSING_ROUTING_CASE");
      routingCases.push({
        caseId: testCase.id,
        pass: issues.length === 0,
        issues,
      });
      continue;
    }
    const route = routingById.get(testCase.id);
    if (!route) {
      issues.push("MISSING_ROUTING_CASE");
      routingCases.push({ caseId: testCase.id, pass: false, issues });
      continue;
    }
    const expectedHash = await expectedArtifactSha256(testCase);
    const expectedReasons: OcrRoutingEvidence["detectedReasons"] = [
      "MIXED",
      "SEARCHABLE",
    ];
    if (testCase.tags.includes("raster-logo"))
      expectedReasons.push("RASTER_LOGO");
    if (testCase.tags.includes("hidden-text"))
      expectedReasons.push("HIDDEN_TEXT");
    if (route.tenantId !== testCase.tenantId) {
      counters.tenantLeaks++;
      issues.push("TENANT_BINDING_MISMATCH");
    }
    if (route.artifactSha256 !== expectedHash)
      issues.push("ARTIFACT_HASH_MISMATCH");
    if (
      JSON.stringify(route.detectedReasons) !== JSON.stringify(expectedReasons)
    )
      issues.push("ROUTING_REASON_MISMATCH");
    if (route.providerCalls !== 0) issues.push("ROUTING_PROVIDER_CALL");
    if (!route.routedLocally || !route.explicitFallback)
      issues.push("ROUTING_FALLBACK_NOT_VISIBLE");
    if (route.financialWrites !== 0) issues.push("FINANCIAL_WRITE");
    counters.financialWrites += route.financialWrites;
    routingCases.push({
      caseId: testCase.id,
      pass: issues.length === 0,
      issues: [...new Set(issues)],
    });
  }

  const responseIds = input.predictions.flatMap((item) =>
    item.adapterTrace?.responseId ? [item.adapterTrace.responseId] : [],
  );
  if (
    input.run.mode === "LIVE_CAPTURE" &&
    new Set(responseIds).size !== responseIds.length
  ) {
    counters.tenantLeaks++;
    perCase[0]?.issues.push("REUSED_PROVIDER_RESPONSE_ID");
    if (perCase[0]) perCase[0].pass = false;
  }

  const probesById = new Map(safetyEvidence.map((probe) => [probe.id, probe]));
  const safetyProbes = SAFETY_PROBE_IDS.map((id) => {
    if (structurallyValidatedLiveEvidence) {
      const issues = mechanicalObservationNames.has(`[PROBE] ${id}`)
        ? []
        : ["MISSING_SAFETY_PROBE"];
      return { id, pass: issues.length === 0, issues };
    }
    const probe = probesById.get(id);
    const issues: string[] = [];
    if (!probe) issues.push("MISSING_SAFETY_PROBE");
    else {
      if (!probe.blocked) issues.push("MUTATION_NOT_BLOCKED");
      if (!probe.explicitError) issues.push("SUCCESS_SHAPED_OR_HIDDEN_ERROR");
      if (!/^[A-Z][A-Z0-9_]+$/.test(probe.errorCode))
        issues.push("UNTYPED_ERROR");
      if (OCR_DURABLE_PROBE_IDS.has(id) && !probe.durableStateVerified)
        issues.push("DURABLE_STATE_NOT_PROVED");
      if (
        id === "KNOWN_SAFETY_FINISH_REASONS" &&
        JSON.stringify(probe.finishReasonsTested) !==
          JSON.stringify(KNOWN_SAFETY_FINISH_REASONS)
      )
        issues.push("KNOWN_SAFETY_FINISH_REASONS_NOT_PROVED");
      if (probe.financialWrites !== 0) issues.push("FINANCIAL_WRITE");
      const expectedCalls = OCR_PROVIDER_CALL_PROBE_IDS.has(id) ? 1 : 0;
      if (probe.providerCalls !== expectedCalls)
        issues.push("WRONG_PROVIDER_CALL_COUNT");
    }
    return { id, pass: issues.length === 0, issues };
  });
  const probeObservationNames = mechanicalObservations
    .filter(({ name }) => name.startsWith("[PROBE] "))
    .map(({ name }) => name.slice("[PROBE] ".length));
  const probeStructureIssues = structurallyValidatedLiveEvidence
    ? probeObservationNames.length -
      new Set(probeObservationNames).size +
      probeObservationNames.filter((id) => !SAFETY_PROBE_IDS.includes(id))
        .length
    : safetyEvidence.length -
      probesById.size +
      [...probesById.keys()].filter((id) => !SAFETY_PROBE_IDS.includes(id))
        .length;
  const latencies = input.predictions.flatMap((item) =>
    finiteNonNegative(item.latencyMs) ? [item.latencyMs] : [],
  );
  const rssValues = input.predictions.flatMap((item) =>
    finiteNonNegative(item.peakRssBytes) ? [item.peakRssBytes] : [],
  );
  const sumComplete = (values: Array<number | null>): number | null =>
    values.every(finiteNonNegative)
      ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null;
  const inputTokens = sumComplete(
    input.predictions.map((item) => item.usage.inputTokens),
  );
  const outputTokens = sumComplete(
    input.predictions.map((item) => item.usage.outputTokens),
  );
  const totalTokens = sumComplete(
    input.predictions.map((item) => item.usage.totalTokens),
  );
  const totalCostMicros = sumComplete(
    input.predictions.map((item) => item.cost.amountMicros),
  );
  const p95LatencyMs = p95(latencies);
  const peakRssBytes = rssValues.length ? Math.max(...rssValues) : null;
  const scannedTaskSuccessRate =
    perCase.filter((item) => item.pass).length /
    OCR_SYNTH_SCANNED_RELEASE_CASES.length;
  const metrics: OcrEvalReport["metrics"] = {
    scannedTaskSuccessRate,
    exactMoneyRate: safeRate(counters.moneyMatches, counters.readableMoneyRows),
    exactSignRate: safeRate(counters.signMatches, counters.readableMoneyRows),
    exactDateRate: safeRate(counters.dateMatches, counters.expectedRows),
    exactDateExplicitnessRate: safeRate(
      counters.explicitnessMatches,
      counters.expectedRows,
    ),
    exactInstallmentRate: safeRate(
      counters.installmentMatches,
      counters.expectedRows,
    ),
    unknownPreservationRate: safeRate(
      counters.preservedUnknownFields,
      counters.expectedUnknownFields,
    ),
    visibleEvidenceRate: safeRate(
      counters.visibleEvidenceMatches,
      counters.expectedEvidenceRows,
    ),
    schemaValidityRate:
      counters.schemaValidCases / OCR_SYNTH_SCANNED_RELEASE_CASES.length,
    inventedRows: counters.inventedRows,
    omittedRows: counters.omittedRows,
    tenantLeaks: counters.tenantLeaks,
    falseAutomations: counters.falseAutomations,
    financialWrites: counters.financialWrites,
    p95LatencyMs,
    peakRssBytes,
    inputTokens,
    outputTokens,
    totalTokens,
    totalCostMicros,
    costCurrency: "USD",
  };
  const functionalPass =
    structuralIssues === 0 &&
    routingStructuralIssues === 0 &&
    routingCases.every((route) => route.pass) &&
    probeStructureIssues === 0 &&
    safetyProbes.every((probe) => probe.pass) &&
    scannedTaskSuccessRate >= OCR_SYNTH_THRESHOLDS.scannedTaskSuccessRate &&
    metrics.exactMoneyRate >= OCR_SYNTH_THRESHOLDS.exactMoneyRate &&
    metrics.exactSignRate >= OCR_SYNTH_THRESHOLDS.exactSignRate &&
    metrics.exactDateRate >= OCR_SYNTH_THRESHOLDS.exactDateRate &&
    metrics.exactDateExplicitnessRate >=
      OCR_SYNTH_THRESHOLDS.exactDateExplicitnessRate &&
    metrics.exactInstallmentRate >= OCR_SYNTH_THRESHOLDS.exactInstallmentRate &&
    metrics.unknownPreservationRate >=
      OCR_SYNTH_THRESHOLDS.unknownPreservationRate &&
    metrics.visibleEvidenceRate >= OCR_SYNTH_THRESHOLDS.visibleEvidenceRate &&
    metrics.schemaValidityRate >= OCR_SYNTH_THRESHOLDS.schemaValidityRate &&
    metrics.inventedRows <= OCR_SYNTH_THRESHOLDS.inventedRows &&
    metrics.omittedRows <= OCR_SYNTH_THRESHOLDS.omittedRows &&
    metrics.tenantLeaks <= OCR_SYNTH_THRESHOLDS.tenantLeaks &&
    metrics.falseAutomations <= OCR_SYNTH_THRESHOLDS.falseAutomations &&
    metrics.financialWrites <= OCR_SYNTH_THRESHOLDS.financialWrites;

  const gaps: string[] = [];
  const qualityClosure = structurallyValidatedLiveEvidence
    ? (input.qualityClosure as OcrQualityClosure)
    : isCanonicalQualityClosure(input.qualityClosure)
      ? input.qualityClosure
      : undefined;
  if (
    input.run.mode === "LIVE_CAPTURE" &&
    qualityClosure &&
    (input.run.candidateSha !== qualityClosure.snapshot.headSha ||
      input.run.configurationSha256 !==
        qualityClosure.snapshot.configurationSha256 ||
      input.run.adapterSha256 !== qualityClosure.snapshot.adapterSha256)
  )
    gaps.push("QUALITY_CLOSURE_RUN_MISMATCH");
  if (input.datasetVersion !== OCR_SYNTH_DATASET.datasetVersion)
    gaps.push("DATASET_VERSION_MISMATCH");
  if (input.run.mode !== "LIVE_CAPTURE")
    gaps.push("LIVE_PROVIDER_RUN_NOT_SUPPLIED");
  if (
    input.run.baseline.sha !== OCR_SYNTH_DATASET.baseSha ||
    input.run.baseline.behavior !== "OCR_REQUIRED" ||
    input.run.baseline.sampleCount !== 18
  )
    gaps.push("BASELINE_PROVENANCE_MISMATCH");
  for (const field of [
    "candidateSha",
    "configurationSha256",
    "adapterSha256",
    "modelVersion",
    "promptSha256",
  ] as const)
    if (!input.run[field]) gaps.push(`MISSING_${field.toUpperCase()}`);
  if (
    input.run.candidateSha !== null &&
    !/^[0-9a-f]{40}$/.test(input.run.candidateSha)
  )
    gaps.push("INVALID_CANDIDATE_SHA");
  for (const field of [
    "configurationSha256",
    "adapterSha256",
    "promptSha256",
  ] as const)
    if (input.run[field] !== null && !/^[0-9a-f]{64}$/.test(input.run[field]!))
      gaps.push(`INVALID_${field.toUpperCase()}`);
  if (input.run.provider !== DIRECT_PDF_VERTEX_CONFIG.provider)
    gaps.push("WRONG_RUN_PROVIDER");
  if (input.run.model !== DIRECT_PDF_VERTEX_CONFIG.model)
    gaps.push("WRONG_RUN_MODEL");
  if (input.run.region !== DIRECT_PDF_VERTEX_CONFIG.region)
    gaps.push("WRONG_RUN_REGION");
  if (input.run.endpoint !== DIRECT_PDF_VERTEX_CONFIG.endpoint)
    gaps.push("WRONG_RUN_ENDPOINT");
  if (input.predictions.length !== 18)
    gaps.push("INCOMPLETE_LIVE_SCANNED_PDF_SAMPLE");
  if (routingCases.length !== 10) gaps.push("INCOMPLETE_ROUTING_SAFETY_SAMPLE");
  if (latencies.length !== 18) gaps.push("MISSING_LATENCY_EVIDENCE");
  if (rssValues.length !== 18) gaps.push("MISSING_RSS_EVIDENCE");
  if (inputTokens === null || outputTokens === null || totalTokens === null)
    gaps.push("MISSING_USAGE_EVIDENCE");
  if (
    input.predictions.some(
      (item) =>
        item.usage.inputTokens !== null &&
        item.usage.outputTokens !== null &&
        item.usage.totalTokens !==
          item.usage.inputTokens + item.usage.outputTokens,
    )
  )
    gaps.push("INVALID_USAGE_TOTAL");
  if (totalCostMicros === null) gaps.push("MISSING_COST_EVIDENCE");
  if (
    input.run.pricing &&
    input.predictions.some((item) => {
      const { inputTokens: usedInput, outputTokens: usedOutput } = item.usage;
      if (
        usedInput === null ||
        usedOutput === null ||
        item.cost.amountMicros === null
      )
        return false;
      const expected = Math.ceil(
        (usedInput * input.run.pricing!.inputMicrosPerMillionTokens +
          usedOutput * input.run.pricing!.outputMicrosPerMillionTokens) /
          1_000_000,
      );
      return item.cost.amountMicros !== expected;
    })
  )
    gaps.push("INVALID_COST_CALCULATION");
  if (
    !input.run.pricing?.source ||
    !input.run.pricing.effectiveDate ||
    !finiteNonNegative(input.run.pricing.inputMicrosPerMillionTokens) ||
    !finiteNonNegative(input.run.pricing.outputMicrosPerMillionTokens)
  )
    gaps.push("MISSING_DECLARED_VERTEX_PRICING");
  if (!finiteNonNegative(input.run.declaredLimits.maxP95LatencyMs))
    gaps.push("MISSING_DECLARED_LATENCY_LIMIT");
  if (!finiteNonNegative(input.run.declaredLimits.maxTotalCostMicros))
    gaps.push("MISSING_DECLARED_COST_LIMIT");
  if (!finiteNonNegative(input.run.declaredLimits.maxRequestBodyBytes))
    gaps.push("MISSING_DECLARED_BODY_LIMIT");
  if (!finiteNonNegative(input.run.declaredLimits.maxProviderDeadlineMs))
    gaps.push("MISSING_DECLARED_DEADLINE_LIMIT");
  if (
    input.run.mode === "LIVE_CAPTURE" &&
    JSON.stringify(input.run.declaredLimits) !==
      JSON.stringify({
        maxP95LatencyMs: policy.declaredLimits.maxP95LatencyMs,
        maxTotalCostMicros: policy.declaredLimits.maxTotalCostMicros,
        maxRequestBodyBytes: policy.declaredLimits.maxRequestBodyBytes,
        maxProviderDeadlineMs: policy.declaredLimits.maxProviderDeadlineMs,
      })
  )
    gaps.push("DECLARED_LIMIT_POLICY_MISMATCH");
  if (
    input.run.mode === "LIVE_CAPTURE" &&
    JSON.stringify(input.run.pricing) !==
      JSON.stringify({
        source: policy.pricing.source,
        effectiveDate: policy.pricing.observedOn,
        inputMicrosPerMillionTokens: policy.pricing.inputMicrosPerMillionTokens,
        outputMicrosPerMillionTokens:
          policy.pricing.outputMicrosPerMillionTokens,
      })
  )
    gaps.push("PRICING_POLICY_MISMATCH");
  const residualRisk = input.run.residualRiskAcceptance;
  if (
    !residualRisk ||
    residualRisk.decision !== "OPTION_1_COMPLETE_ORIGINAL_PDF" ||
    !/^[0-9a-f]{64}$/.test(residualRisk.dataOwnerAcceptanceSha256) ||
    residualRisk.noLocalDerivative !== true
  )
    gaps.push("MISSING_DATA_OWNER_RESIDUAL_RISK_ACCEPTANCE");
  const finalReviews = input.run.finalReviews;
  if (
    !finalReviews ||
    !/^[0-9a-f]{64}$/.test(finalReviews.securityReviewSha256) ||
    !/^[0-9a-f]{64}$/.test(finalReviews.privacyReviewSha256) ||
    !/^[0-9a-f]{64}$/.test(finalReviews.dataOwnerReviewSha256)
  )
    gaps.push("MISSING_FINAL_REVIEW_EVIDENCE");
  const budgets = input.run.durableBudgets;
  if (
    !budgets ||
    !/^[0-9a-f]{64}$/.test(budgets.policySha256) ||
    !finiteNonNegative(budgets.tenantLimitMicros) ||
    !finiteNonNegative(budgets.globalLimitMicros) ||
    budgets.tenantLimitMicros > budgets.globalLimitMicros ||
    budgets.storage !== "DATABASE"
  )
    gaps.push("MISSING_DURABLE_BUDGET_POLICY");
  if (
    input.run.mode === "LIVE_CAPTURE" &&
    (!qualityClosure ||
      JSON.stringify(input.run.durableBudgets) !==
        JSON.stringify({
          policySha256: qualityClosure.snapshot.policySha256,
          tenantLimitMicros: policy.durableBudgets.tenantLimitMicros,
          globalLimitMicros: policy.durableBudgets.globalLimitMicros,
          storage: policy.durableBudgets.storage,
        }))
  )
    gaps.push("DURABLE_BUDGET_POLICY_MISMATCH");
  if (
    peakRssBytes === null ||
    peakRssBytes > OCR_SYNTH_THRESHOLDS.maxPeakRssBytes
  )
    gaps.push("RSS_LIMIT_NOT_MET");
  if (
    p95LatencyMs !== null &&
    finiteNonNegative(input.run.declaredLimits.maxP95LatencyMs) &&
    p95LatencyMs > input.run.declaredLimits.maxP95LatencyMs
  )
    gaps.push("LATENCY_LIMIT_NOT_MET");
  if (
    totalCostMicros !== null &&
    finiteNonNegative(input.run.declaredLimits.maxTotalCostMicros) &&
    totalCostMicros > input.run.declaredLimits.maxTotalCostMicros
  )
    gaps.push("COST_LIMIT_NOT_MET");
  if (
    input.run.mode === "LIVE_CAPTURE" &&
    !structurallyValidatedLiveEvidence &&
    safetyEvidence.some(
      (probe) =>
        probe.source !== "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED",
    )
  )
    gaps.push("SAFETY_PROBES_NOT_FROM_REAL_SERVICE_SEAM");
  if (
    input.run.mode === "LIVE_CAPTURE" &&
    !structurallyValidatedLiveEvidence &&
    routingEvidence.some(
      (route) =>
        route.source !== "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED",
    )
  )
    gaps.push("ROUTING_CASES_NOT_FROM_REAL_SERVICE_SEAM");
  if (
    input.run.mode === "LIVE_CAPTURE" &&
    !structurallyValidatedLiveEvidence &&
    [...safetyEvidence, ...routingEvidence].some(
      (item) => !/^apps\/api\/src\/imports\/.+\.spec\.ts$/.test(item.testFile),
    )
  )
    gaps.push("MISSING_LIVE_SERVICE_TEST_PATH");
  const probesByIdForContext = new Map(
    safetyEvidence.map((probe) => [probe.id, probe]),
  );
  if (
    input.run.mode === "LIVE_CAPTURE" &&
    (structurallyValidatedLiveEvidence
      ? REAL_SERVICE_CONTEXT_PROBE_IDS.some(
          (id) => !mechanicalObservationNames.has(`[PROBE] ${id}`),
        )
      : REAL_SERVICE_CONTEXT_PROBE_IDS.some((id) => {
          const probe = probesByIdForContext.get(id);
          return (
            !probe ||
            probe.source !== "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED" ||
            probe.testFile !== REAL_SERVICE_CONTEXT_TEST
          );
        }))
  )
    gaps.push("MISSING_REAL_SERVICE_CONSENT_EVIDENCE");
  const requestIds = input.predictions.flatMap((item) =>
    item.adapterTrace ? [item.adapterTrace.requestId] : [],
  );
  if (
    input.run.mode === "LIVE_CAPTURE" &&
    (requestIds.length !== OCR_SYNTH_SCANNED_RELEASE_CASES.length ||
      new Set(requestIds).size !== requestIds.length)
  )
    gaps.push("INVALID_OR_REUSED_REQUEST_ID");
  if (
    input.run.mode === "LIVE_CAPTURE" &&
    input.predictions.some(
      (item) =>
        item.adapterTrace?.authTrace !== "SERVICE_ACCOUNT_FILE_ADC" &&
        item.adapterTrace?.authTrace !== "GITHUB_OIDC_WIF",
    )
  )
    gaps.push("PRODUCTION_SERVICE_ACCOUNT_AUTH_NOT_PROVED");
  const metadataMismatch = input.predictions.some(
    (item) =>
      item.provider !== input.run.provider ||
      item.model !== input.run.model ||
      item.modelVersion !== input.run.modelVersion ||
      item.promptSha256 !== input.run.promptSha256,
  );
  if (metadataMismatch) gaps.push("MISSING_OR_MISMATCHED_CASE_PROVENANCE");

  const uniqueGaps = [...new Set(gaps)];
  return {
    reportSchemaVersion: 4,
    historicalComparison: "NOT_PERFORMED_P1_DEFERRED",
    datasetVersion: OCR_SYNTH_DATASET.datasetVersion,
    corpusSampleCount: OCR_SYNTH_DATASET.cases.length as 52,
    releaseScannedPdfSampleCount: OCR_SYNTH_SCANNED_RELEASE_CASES.length as 18,
    routingSafetySampleCount: OCR_SYNTH_ROUTING_CASES.length as 10,
    futureImageSampleCount: OCR_SYNTH_DATASET.cases.filter(
      (item) => item.partition === "IMAGE",
    ).length as 12,
    baseline: input.run.baseline,
    candidate: {
      mode: input.run.mode,
      candidateSha: input.run.candidateSha,
      configurationSha256: input.run.configurationSha256,
      adapterSha256: input.run.adapterSha256,
      provider: input.run.provider,
      model: input.run.model,
      modelVersion: input.run.modelVersion,
      region: input.run.region,
      endpoint: input.run.endpoint,
      promptSha256: input.run.promptSha256,
      durableBudgets: input.run.durableBudgets,
      residualRiskAcceptance: input.run.residualRiskAcceptance,
      finalReviews: input.run.finalReviews,
    },
    thresholds: OCR_SYNTH_THRESHOLDS,
    metrics,
    perCase,
    regressions: perCase
      .filter((item) => !item.pass)
      .map(({ caseId, issues }) => ({ caseId, issues })),
    routingCases,
    safetyProbes,
    fallbackSafety: {
      explicitFailures: safetyProbes.every((probe) => probe.pass),
      emptySuccessAccepted: false,
      financialWritesPerformed: metrics.financialWrites,
      tenantLeakCount: metrics.tenantLeaks,
      routingProviderCalls: routingEvidence.reduce(
        (sum, route) => sum + route.providerCalls,
        0,
      ),
    },
    liveEvidenceGaps: uniqueGaps,
    functionalStatus: functionalPass ? "PASS" : "FAIL",
    releaseStatus: functionalPass && uniqueGaps.length === 0 ? "PASS" : "GAPS",
  };
}

export function assertReleaseQualified(report: OcrEvalReport): void {
  if (report.releaseStatus !== "PASS")
    throw new Error(
      `OCR direct-PDF Vertex release is not qualified: ${[...report.regressions.flatMap((item) => item.issues), ...report.routingCases.flatMap((item) => item.issues), ...report.safetyProbes.flatMap((item) => item.issues), ...report.liveEvidenceGaps].join(",") || "UNKNOWN_GAP"}`,
    );
}
