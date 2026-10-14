import {
  IMPORT_SESSION_PRIMITIVES,
  PDF_OCR_MODEL_VERSION_PATTERN,
} from "@reformaflow/domain";
import {
  OCR_SYNTH_DATASET,
  OCR_SYNTH_ROUTING_CASES,
  OCR_SYNTH_SCANNED_RELEASE_CASES,
} from "./corpus";
import type { OcrEvalInput } from "./evaluator";
import { SAFETY_PROBE_IDS } from "./types";

const HASH = new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern);
const REQUEST_ID = new RegExp(IMPORT_SESSION_PRIMITIVES.requestIdPattern);
const MODEL_VERSION = new RegExp(PDF_OCR_MODEL_VERSION_PATTERN);
const SAFE_CODE = /^[A-Z][A-Z0-9_]+$/;

const fail = (): never => {
  throw new Error("LIVE_EVIDENCE_INVALID");
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exact = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> => {
  if (!object(value)) return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    own.every((key) => typeof key === "string" && keys.includes(key))
  );
};
const string = (value: unknown): value is string => typeof value === "string";
const nullableString = (value: unknown): value is string | null =>
  value === null || string(value);
const bool = (value: unknown): value is boolean => typeof value === "boolean";
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableNumber = (value: unknown): value is number | null =>
  value === null || number(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(string);
const oneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T => string(value) && allowed.includes(value as T);

export function isValidLiveRun(value: unknown): boolean {
  if (
    !exact(value, [
      "mode",
      "candidateSha",
      "configurationSha256",
      "adapterSha256",
      "provider",
      "model",
      "modelVersion",
      "region",
      "endpoint",
      "promptSha256",
      "baseline",
      "declaredLimits",
      "durableBudgets",
      "residualRiskAcceptance",
      "finalReviews",
      "pricing",
    ])
  )
    return false;
  if (
    value.mode !== "LIVE_CAPTURE" ||
    !string(value.candidateSha) ||
    !/^[0-9a-f]{40}$/.test(value.candidateSha) ||
    !string(value.configurationSha256) ||
    !HASH.test(value.configurationSha256) ||
    !string(value.adapterSha256) ||
    !HASH.test(value.adapterSha256) ||
    !string(value.provider) ||
    !string(value.model) ||
    !string(value.modelVersion) ||
    !MODEL_VERSION.test(value.modelVersion) ||
    !string(value.region) ||
    !string(value.endpoint) ||
    !string(value.promptSha256) ||
    !HASH.test(value.promptSha256)
  )
    return false;
  if (
    !exact(value.baseline, ["sha", "behavior", "sampleCount"]) ||
    !string(value.baseline.sha) ||
    value.baseline.behavior !== "OCR_REQUIRED" ||
    value.baseline.sampleCount !== 18
  )
    return false;
  if (
    !exact(value.declaredLimits, [
      "maxP95LatencyMs",
      "maxTotalCostMicros",
      "maxRequestBodyBytes",
      "maxProviderDeadlineMs",
    ]) ||
    !number(value.declaredLimits.maxP95LatencyMs) ||
    !number(value.declaredLimits.maxTotalCostMicros) ||
    !number(value.declaredLimits.maxRequestBodyBytes) ||
    !number(value.declaredLimits.maxProviderDeadlineMs)
  )
    return false;
  if (
    !exact(value.durableBudgets, [
      "policySha256",
      "tenantLimitMicros",
      "globalLimitMicros",
      "storage",
    ]) ||
    !string(value.durableBudgets.policySha256) ||
    !HASH.test(value.durableBudgets.policySha256) ||
    !number(value.durableBudgets.tenantLimitMicros) ||
    !number(value.durableBudgets.globalLimitMicros) ||
    value.durableBudgets.storage !== "DATABASE"
  )
    return false;
  if (
    !exact(value.residualRiskAcceptance, [
      "decision",
      "dataOwnerAcceptanceSha256",
      "noLocalDerivative",
    ]) ||
    value.residualRiskAcceptance.decision !==
      "OPTION_1_COMPLETE_ORIGINAL_PDF" ||
    !string(value.residualRiskAcceptance.dataOwnerAcceptanceSha256) ||
    !HASH.test(value.residualRiskAcceptance.dataOwnerAcceptanceSha256) ||
    value.residualRiskAcceptance.noLocalDerivative !== true
  )
    return false;
  if (
    !exact(value.finalReviews, [
      "securityReviewSha256",
      "privacyReviewSha256",
      "dataOwnerReviewSha256",
    ]) ||
    !Object.values(value.finalReviews).every(
      (item) => string(item) && HASH.test(item),
    )
  )
    return false;
  return (
    exact(value.pricing, [
      "source",
      "effectiveDate",
      "inputMicrosPerMillionTokens",
      "outputMicrosPerMillionTokens",
    ]) &&
    string(value.pricing.source) &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(value.pricing.effectiveDate)) &&
    number(value.pricing.inputMicrosPerMillionTokens) &&
    number(value.pricing.outputMicrosPerMillionTokens)
  );
}

function validNativeOutcome(value: unknown): boolean {
  if (
    !exact(value, ["kind", "candidates"]) ||
    value.kind !== "SUCCESS" ||
    !Array.isArray(value.candidates)
  )
    return false;
  return value.candidates.every(
    (candidate) =>
      exact(candidate, [
        "pageNumber",
        "description",
        "amountCents",
        "sign",
        "amountMeaning",
        "date",
        "installment",
        "evidenceText",
      ]) &&
      number(candidate.pageNumber) &&
      candidate.pageNumber > 0 &&
      nullableString(candidate.description) &&
      nullableString(candidate.amountCents) &&
      oneOf(candidate.sign, ["NEGATIVE", "ZERO", "POSITIVE", "UNKNOWN"]) &&
      oneOf(candidate.amountMeaning, ["LINE_AMOUNT", "UNKNOWN"]) &&
      nullableString(candidate.date) &&
      (candidate.installment === null ||
        (exact(candidate.installment, ["index", "total"]) &&
          number(candidate.installment.index) &&
          candidate.installment.index > 0 &&
          number(candidate.installment.total) &&
          candidate.installment.total > 0)) &&
      string(candidate.evidenceText),
  );
}

function validTrace(value: unknown): boolean {
  return (
    exact(value, [
      "seam",
      "requestId",
      "endpoint",
      "region",
      "model",
      "auth",
      "adcScopes",
      "apiKeyUsed",
      "globalEndpointFallbackUsed",
      "inputMimeType",
      "inputMode",
      "originalBytesSha256",
      "requestBodyBytes",
      "deadlineMs",
      "finishReason",
      "maxOutputTokens",
      "promptContract",
      "toolsPresent",
      "fileUri",
      "cachedContent",
      "providerCallCount",
      "responseId",
      "attempts",
      "ambiguousTimeoutRetried",
      "textualPdf",
      "localFinancialRowsMerged",
    ]) &&
    string(value.seam) &&
    string(value.requestId) &&
    REQUEST_ID.test(value.requestId) &&
    string(value.endpoint) &&
    string(value.region) &&
    string(value.model) &&
    value.auth === "ADC_OAUTH" &&
    strings(value.adcScopes) &&
    bool(value.apiKeyUsed) &&
    bool(value.globalEndpointFallbackUsed) &&
    string(value.inputMimeType) &&
    value.inputMode === "INLINE_ORIGINAL_BYTES" &&
    string(value.originalBytesSha256) &&
    HASH.test(value.originalBytesSha256) &&
    number(value.requestBodyBytes) &&
    number(value.deadlineMs) &&
    value.finishReason === "STOP" &&
    number(value.maxOutputTokens) &&
    exact(value.promptContract, [
      "rawCandidatesOnly",
      "allVisibleOccurrences",
      "allPagesInOrder",
      "preserveDuplicates",
      "signedAmountIncludesNegativeZeroUnknown",
      "noFinancialExclusionsOrClassification",
    ]) &&
    Object.values(value.promptContract).every(bool) &&
    bool(value.toolsPresent) &&
    value.fileUri === null &&
    value.cachedContent === null &&
    value.providerCallCount === 1 &&
    string(value.responseId) &&
    value.responseId.length > 0 &&
    value.attempts === 1 &&
    bool(value.ambiguousTimeoutRetried) &&
    bool(value.textualPdf) &&
    number(value.localFinancialRowsMerged)
  );
}

function validConsent(value: unknown): boolean {
  return (
    exact(value, [
      "capability",
      "consentPolicyVersion",
      "decision",
      "purpose",
      "provider",
      "model",
      "region",
      "actorId",
      "sessionRevision",
      "attachmentId",
      "artifactSha256",
      "requestId",
      "requestPayloadHash",
      "completeOriginalFile",
      "includesMetadataAndEmbeddedContent",
      "includesPotentiallyNonVisibleContent",
      "externalContentRetentionDays",
    ]) &&
    value.capability === "ANALYZE_ATTACHMENT_V2" &&
    value.consentPolicyVersion === 1 &&
    value.decision === "ALLOW_EXTERNAL_PROCESSING" &&
    value.purpose === "DOCUMENT_LINE_TRANSCRIPTION_FOR_HUMAN_REVIEW" &&
    string(value.provider) &&
    string(value.model) &&
    string(value.region) &&
    string(value.actorId) &&
    number(value.sessionRevision) &&
    string(value.attachmentId) &&
    string(value.artifactSha256) &&
    HASH.test(value.artifactSha256) &&
    string(value.requestId) &&
    string(value.requestPayloadHash) &&
    HASH.test(value.requestPayloadHash) &&
    value.completeOriginalFile === true &&
    value.includesMetadataAndEmbeddedContent === true &&
    value.includesPotentiallyNonVisibleContent === true &&
    number(value.externalContentRetentionDays)
  );
}

function validCaptureContext(value: Record<string, unknown>): boolean {
  if (value.capturePath === "DIRECT_PROVIDER_CAPTURE")
    return (
      value.consentRecorded === false &&
      value.consentCapability === null &&
      value.attestationRequired === null
    );
  if (
    value.capturePath !== "REAL_IMPORT_SERVICE" ||
    value.consentRecorded !== true ||
    !validConsent(value.consentCapability) ||
    value.attestationRequired !== true ||
    !object(value.consentCapability) ||
    !object(value.adapterTrace)
  )
    return false;
  return value.consentCapability.requestId === value.adapterTrace.requestId;
}

function validPrediction(value: unknown): boolean {
  return (
    exact(value, [
      "caseId",
      "tenantId",
      "artifactSha256",
      "outcome",
      "provider",
      "model",
      "modelVersion",
      "promptSha256",
      "schemaValid",
      "latencyMs",
      "peakRssBytes",
      "usage",
      "cost",
      "adapterTrace",
      "capturePath",
      "consentRecorded",
      "consentCapability",
      "attestationRequired",
      "financialWrites",
    ]) &&
    string(value.caseId) &&
    string(value.tenantId) &&
    string(value.artifactSha256) &&
    HASH.test(value.artifactSha256) &&
    validNativeOutcome(value.outcome) &&
    string(value.provider) &&
    string(value.model) &&
    string(value.modelVersion) &&
    MODEL_VERSION.test(value.modelVersion) &&
    string(value.promptSha256) &&
    HASH.test(value.promptSha256) &&
    value.schemaValid === true &&
    nullableNumber(value.latencyMs) &&
    nullableNumber(value.peakRssBytes) &&
    exact(value.usage, ["inputTokens", "outputTokens", "totalTokens"]) &&
    nullableNumber(value.usage.inputTokens) &&
    nullableNumber(value.usage.outputTokens) &&
    nullableNumber(value.usage.totalTokens) &&
    exact(value.cost, ["currency", "amountMicros"]) &&
    value.cost.currency === "USD" &&
    nullableNumber(value.cost.amountMicros) &&
    validTrace(value.adapterTrace) &&
    validCaptureContext(value) &&
    number(value.financialWrites)
  );
}

export function isValidLiveRoute(value: unknown): boolean {
  return (
    exact(value, [
      "caseId",
      "tenantId",
      "artifactSha256",
      "source",
      "detectedReasons",
      "providerCalls",
      "routedLocally",
      "explicitFallback",
      "financialWrites",
      "testFile",
    ]) &&
    string(value.caseId) &&
    string(value.tenantId) &&
    string(value.artifactSha256) &&
    HASH.test(value.artifactSha256) &&
    value.source === "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED" &&
    Array.isArray(value.detectedReasons) &&
    value.detectedReasons.every((item) =>
      oneOf(item, ["MIXED", "SEARCHABLE", "RASTER_LOGO", "HIDDEN_TEXT"]),
    ) &&
    number(value.providerCalls) &&
    bool(value.routedLocally) &&
    bool(value.explicitFallback) &&
    number(value.financialWrites) &&
    string(value.testFile)
  );
}

export function isValidLiveProbe(value: unknown): boolean {
  return (
    exact(value, [
      "id",
      "source",
      "blocked",
      "explicitError",
      "errorCode",
      "providerCalls",
      "financialWrites",
      "durableStateVerified",
      "finishReasonsTested",
      "testFile",
    ]) &&
    oneOf(value.id, SAFETY_PROBE_IDS) &&
    value.source === "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED" &&
    bool(value.blocked) &&
    bool(value.explicitError) &&
    string(value.errorCode) &&
    SAFE_CODE.test(value.errorCode) &&
    number(value.providerCalls) &&
    number(value.financialWrites) &&
    bool(value.durableStateVerified) &&
    strings(value.finishReasonsTested) &&
    string(value.testFile)
  );
}

function exactIdSet(values: readonly string[], expected: readonly string[]) {
  return (
    values.length === expected.length &&
    new Set(values).size === values.length &&
    expected.every((id) => values.includes(id))
  );
}
const unique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

export function parseLiveEvidence(value: unknown): OcrEvalInput {
  if (
    !exact(value, [
      "datasetVersion",
      "run",
      "predictions",
      "routingCases",
      "safetyProbes",
    ]) ||
    value.datasetVersion !== OCR_SYNTH_DATASET.datasetVersion ||
    !isValidLiveRun(value.run) ||
    !Array.isArray(value.predictions) ||
    !value.predictions.every(validPrediction) ||
    !Array.isArray(value.routingCases) ||
    !value.routingCases.every(isValidLiveRoute) ||
    !Array.isArray(value.safetyProbes) ||
    !value.safetyProbes.every(isValidLiveProbe) ||
    !exactIdSet(
      value.predictions.map((item) => item.caseId),
      OCR_SYNTH_SCANNED_RELEASE_CASES.map((item) => item.id),
    ) ||
    !exactIdSet(
      value.routingCases.map((item) => item.caseId),
      OCR_SYNTH_ROUTING_CASES.map((item) => item.id),
    ) ||
    !exactIdSet(
      value.safetyProbes.map((item) => item.id),
      SAFETY_PROBE_IDS,
    ) ||
    !unique(value.predictions.map((item) => item.adapterTrace.requestId))
  )
    fail();
  return value as unknown as OcrEvalInput;
}

export function parseLiveEvidenceJson(raw: string): OcrEvalInput {
  return parseLiveEvidence(parseJson(raw));
}

export function parseJson(raw: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail();
  }
  return value;
}
