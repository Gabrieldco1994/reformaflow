import {
  IMPORT_SESSION_PRIMITIVES,
  PDF_OCR_MODEL_VERSION_PATTERN,
} from "@reformaflow/domain";
import { createHash } from "node:crypto";
import {
  PdfOcrFailureCode,
  parsePdfOcrV3,
} from "../import-session/ocr/pdf-ocr-parser";
import { parseStrictJson } from "../import-session/ocr/strict-json";
import {
  OCR_SYNTH_DATASET,
  OCR_SYNTH_ROUTING_CASES,
  OCR_SYNTH_SCANNED_RELEASE_CASES,
} from "./corpus";
import type { OcrEvalInput } from "./evaluator";
import policy from "./quality-closure-policy.json";
import { SAFETY_PROBE_IDS, SAFETY_PROBE_SCENARIOS } from "./types";
import { isStructurallyValidQualityClosureEnvelope } from "./quality-closure-attestation";
import { providerNativeOutcome } from "./provider-native-outcome";

const HASH = new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern);
const REQUEST_ID = new RegExp(IMPORT_SESSION_PRIMITIVES.requestIdPattern);
const MODEL_VERSION = new RegExp(PDF_OCR_MODEL_VERSION_PATTERN);
const SAFE_CODE = /^[A-Z][A-Z0-9_]+$/;
const QUALIFICATION_SOURCE_BY_NAME = new Map(
  policy.qualificationTests.map((item) => [item.name, item.sourcePath]),
);
const NON_AUTHORITY_SAFETY_EVIDENCE_SOURCE =
  "apps/api/src/imports/ocr-synth-v1/direct-pdf-vertex-safety.spec.ts";
const STRUCTURALLY_VALIDATED_LIVE_EVIDENCE = Symbol(
  "structurally-validated-live-evidence",
);

const fail = (): never => {
  throw new Error("LIVE_EVIDENCE_INVALID");
};
const object = (value: unknown): value is Record<string, unknown> =>
  (() => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return false;
    const prototype = Object.getPrototypeOf(value);
    return (
      prototype === null ||
      (typeof prototype === "object" &&
        prototype !== null &&
        Object.getPrototypeOf(prototype) === null)
    );
  })();
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
    value.residualRiskAcceptance !== null &&
    (!exact(value.residualRiskAcceptance, [
      "decision",
      "dataOwnerAcceptanceSha256",
      "noLocalDerivative",
    ]) ||
      value.residualRiskAcceptance.decision !==
        "OPTION_1_COMPLETE_ORIGINAL_PDF" ||
      !string(value.residualRiskAcceptance.dataOwnerAcceptanceSha256) ||
      !HASH.test(value.residualRiskAcceptance.dataOwnerAcceptanceSha256) ||
      value.residualRiskAcceptance.noLocalDerivative !== true)
  )
    return false;
  if (
    value.finalReviews !== null &&
    (!exact(value.finalReviews, [
      "securityReviewSha256",
      "privacyReviewSha256",
      "dataOwnerReviewSha256",
    ]) ||
      !Object.values(value.finalReviews).every(
        (item) => string(item) && HASH.test(item),
      ))
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
    exact(value, ["kind", "errorCode", "retryable"]) &&
    value.kind === "ERROR"
  )
    return (
      (value.errorCode === "DOCUMENT_UNREADABLE" ||
        value.errorCode === "LIMIT_EXCEEDED") &&
      value.retryable === false
    );
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
        "selected",
        "verificationStatus",
        "candidateDisposition",
      ]) &&
      number(candidate.pageNumber) &&
      candidate.pageNumber > 0 &&
      number(candidate.pageOccurrenceIndex) &&
      candidate.pageOccurrenceIndex > 0 &&
      nullableString(candidate.description) &&
      nullableString(candidate.amountCents) &&
      oneOf(candidate.sign, ["NEGATIVE", "ZERO", "POSITIVE", "UNKNOWN"]) &&
      oneOf(candidate.amountMeaning, ["LINE_AMOUNT", "UNKNOWN"]) &&
      nullableString(candidate.dateText) &&
      nullableString(candidate.normalizedDate) &&
      oneOf(candidate.dateExplicitness, [
        "FULL",
        "YEARLESS",
        "MISSING",
        "UNKNOWN",
      ]) &&
      (candidate.installment === null ||
        (exact(candidate.installment, ["index", "total"]) &&
          number(candidate.installment.index) &&
          candidate.installment.index > 0 &&
          number(candidate.installment.total) &&
          candidate.installment.total > 0)) &&
      string(candidate.evidenceText) &&
      candidate.selected === false &&
      candidate.verificationStatus === "UNVERIFIED" &&
      candidate.candidateDisposition === "RAW_UNCLASSIFIED",
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]))
    );
  if (object(left) || object(right))
    return (
      object(left) &&
      object(right) &&
      Reflect.ownKeys(left).length === Reflect.ownKeys(right).length &&
      Object.keys(left).every(
        (key) =>
          Object.prototype.hasOwnProperty.call(right, key) &&
          sameJsonValue(left[key], right[key]),
      )
    );
  return left === right;
}

function validQualificationOutcome(caseId: unknown, value: unknown): boolean {
  if (!string(caseId)) return false;
  const testCase = OCR_SYNTH_SCANNED_RELEASE_CASES.find(
    (item) => item.id === caseId,
  );
  if (!testCase) return false;
  const expected = structuredClone(testCase.expected);
  if (expected.kind === "SUCCESS")
    for (const row of expected.regions.flatMap((region) => region.rows)) {
      row.selected = false;
      row.verificationStatus = "UNVERIFIED";
    }
  return sameJsonValue(value, expected);
}

function validTrace(value: unknown): boolean {
  const baseKeys = [
    "seam",
    "requestId",
    "endpoint",
    "region",
    "model",
    "authTrace",
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
  ] as const;
  return (
    (exact(value, baseKeys) ||
      exact(value, [
        ...baseKeys,
        "requestPlanSha256",
        "countRequestBodySha256",
        "generationRequestBodySha256",
      ])) &&
    string(value.seam) &&
    string(value.requestId) &&
    REQUEST_ID.test(value.requestId) &&
    string(value.endpoint) &&
    string(value.region) &&
    string(value.model) &&
    (value.authTrace === "LOCAL_ADC" ||
      value.authTrace === "SERVICE_ACCOUNT_FILE_ADC") &&
    strings(value.adcScopes) &&
    bool(value.apiKeyUsed) &&
    bool(value.globalEndpointFallbackUsed) &&
    string(value.inputMimeType) &&
    value.inputMode === "INLINE_ORIGINAL_BYTES" &&
    string(value.originalBytesSha256) &&
    HASH.test(value.originalBytesSha256) &&
    (!("requestPlanSha256" in value) ||
      (string(value.requestPlanSha256) &&
        HASH.test(value.requestPlanSha256) &&
        string(value.countRequestBodySha256) &&
        HASH.test(value.countRequestBodySha256) &&
        string(value.generationRequestBodySha256) &&
        HASH.test(value.generationRequestBodySha256))) &&
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
    (value.providerCallCount === 1 || value.providerCallCount === 2) &&
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

function validPrediction(
  value: unknown,
  allowQualificationOutcome = false,
): boolean {
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
    (validNativeOutcome(value.outcome) ||
      (allowQualificationOutcome &&
        validQualificationOutcome(value.caseId, value.outcome))) &&
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

export function isValidLiveRoute(
  value: unknown,
  allowOfflineEvidence = false,
): boolean {
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
    (value.source === "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED" ||
      (allowOfflineEvidence &&
        value.source === "OFFLINE_EVALUATOR_SELF_TEST")) &&
    Array.isArray(value.detectedReasons) &&
    value.detectedReasons.every((item) =>
      oneOf(item, ["MIXED", "SEARCHABLE", "RASTER_LOGO", "HIDDEN_TEXT"]),
    ) &&
    number(value.providerCalls) &&
    bool(value.routedLocally) &&
    bool(value.explicitFallback) &&
    number(value.financialWrites) &&
    string(value.testFile) &&
    (value.source === "OFFLINE_EVALUATOR_SELF_TEST" ||
      value.testFile ===
        QUALIFICATION_SOURCE_BY_NAME.get(`[ROUTE] ${value.caseId}`))
  );
}

export function isValidLiveProbe(
  value: unknown,
  allowOfflineEvidence = false,
): boolean {
  const baseKeys = [
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
  ] as const;
  return (
    (exact(value, baseKeys) || exact(value, [...baseKeys, "scenarios"])) &&
    oneOf(value.id, SAFETY_PROBE_IDS) &&
    (value.source === "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED" ||
      (allowOfflineEvidence &&
        value.source === "OFFLINE_EVALUATOR_SELF_TEST")) &&
    bool(value.blocked) &&
    bool(value.explicitError) &&
    string(value.errorCode) &&
    SAFE_CODE.test(value.errorCode) &&
    number(value.providerCalls) &&
    number(value.financialWrites) &&
    bool(value.durableStateVerified) &&
    strings(value.finishReasonsTested) &&
    validProbeScenarios(value) &&
    string(value.testFile) &&
    (value.source === "OFFLINE_EVALUATOR_SELF_TEST" ||
      value.testFile ===
        QUALIFICATION_SOURCE_BY_NAME.get(`[PROBE] ${value.id}`) ||
      value.testFile === NON_AUTHORITY_SAFETY_EVIDENCE_SOURCE)
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
const exactStrings = (value: unknown, expected: readonly string[]): boolean =>
  strings(value) &&
  value.length === expected.length &&
  value.every((item, index) => item === expected[index]);

function validProbeScenarios(value: Record<string, unknown>): boolean {
  if (value.id === "PARTIAL_RESPONSE")
    return exactStrings(
      value.scenarios,
      SAFETY_PROBE_SCENARIOS.PARTIAL_RESPONSE,
    );
  if (value.id === "MALFORMED_RESPONSE")
    return exactStrings(
      value.scenarios,
      SAFETY_PROBE_SCENARIOS.MALFORMED_RESPONSE,
    );
  return !("scenarios" in value);
}

function validQualityClosure(value: unknown, candidateSha: unknown): boolean {
  if (
    object(value) &&
    exact(value, ["version", "policyVersion", "snapshot", "tests"]) &&
    value.version === 2 &&
    value.policyVersion === policy.policyVersion &&
    string(candidateSha) &&
    object(value.snapshot) &&
    exact(value.snapshot, [
      "headSha",
      "treeSha",
      "clean",
      "policySha256",
      "corpusSha256",
      "configurationSha256",
      "adapterSha256",
      "runtimeSha256",
      "suiteSha256",
    ]) &&
    value.snapshot.headSha === candidateSha &&
    string(value.snapshot.treeSha) &&
    value.snapshot.clean === true &&
    [
      value.snapshot.policySha256,
      value.snapshot.corpusSha256,
      value.snapshot.configurationSha256,
      value.snapshot.adapterSha256,
      value.snapshot.runtimeSha256,
      value.snapshot.suiteSha256,
    ].every((digest) => string(digest) && HASH.test(digest)) &&
    Array.isArray(value.tests) &&
    value.tests.length === policy.qualificationTests.length &&
    value.tests.every((item, index) => {
      const expected = policy.qualificationTests[index];
      return (
        exact(item, ["name", "status", "sourcePath"]) &&
        item.name === expected?.name &&
        item.status === "PASS" &&
        (item.sourcePath === expected?.sourcePath ||
          item.sourcePath === NON_AUTHORITY_SAFETY_EVIDENCE_SOURCE)
      );
    })
  )
    return true;
  if (
    !isStructurallyValidQualityClosureEnvelope(value) ||
    !string(candidateSha)
  )
    return false;
  return (
    value.policyVersion === policy.policyVersion &&
    value.snapshot.headSha === candidateSha &&
    value.tests.length === policy.qualificationTests.length &&
    value.tests.every(
      (item, index) =>
        item.name === policy.qualificationTests[index]?.name &&
        item.sourcePath === policy.qualificationTests[index]?.sourcePath,
    )
  );
}

function validCapturedQualityClosure(
  value: unknown,
  candidateSha: unknown,
): value is Record<string, unknown> {
  if (
    !isStructurallyValidQualityClosureEnvelope(value) ||
    !string(candidateSha) ||
    value.snapshot.headSha !== candidateSha ||
    value.tests.length !== policy.qualificationTests.length
  )
    return false;
  return value.tests.every((item, index) => {
    const expected = policy.qualificationTests[index];
    return (
      item.name === expected?.name && item.sourcePath === expected?.sourcePath
    );
  });
}

const hashBytes = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

function responseBytes(event: Record<string, unknown>): Buffer {
  if (
    !string(event.responseBytesBase64) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      event.responseBytesBase64,
    )
  )
    fail();
  const bytes = Buffer.from(event.responseBytesBase64 as string, "base64");
  if (
    !number(event.responseByteLength) ||
    bytes.length !== event.responseByteLength ||
    !string(event.responseSha256) ||
    hashBytes(bytes) !== event.responseSha256
  )
    fail();
  return bytes;
}

function parseWireBytes(bytes: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    fail();
  }
  if (!object(parsed)) fail();
  return parsed as Record<string, unknown>;
}

function replayGenerationOutcome(
  generationWire: Record<string, unknown>,
  expectedCase: (typeof OCR_SYNTH_SCANNED_RELEASE_CASES)[number],
  prediction: Record<string, unknown>,
  adapterTrace: Record<string, unknown>,
): unknown {
  if (
    !string(generationWire.responseId) ||
    !string(generationWire.modelVersion) ||
    !Array.isArray(generationWire.candidates) ||
    generationWire.candidates.length !== 1 ||
    !object(generationWire.candidates[0]) ||
    generationWire.candidates[0].finishReason !== "STOP" ||
    !object(generationWire.candidates[0].content) ||
    !Array.isArray(generationWire.candidates[0].content.parts) ||
    generationWire.candidates[0].content.parts.length !== 1 ||
    !object(generationWire.candidates[0].content.parts[0]) ||
    !exact(generationWire.candidates[0].content.parts[0], ["text"]) ||
    !string(generationWire.candidates[0].content.parts[0].text) ||
    !object(generationWire.usageMetadata) ||
    !number(generationWire.usageMetadata.promptTokenCount) ||
    !number(generationWire.usageMetadata.candidatesTokenCount) ||
    !number(generationWire.usageMetadata.totalTokenCount) ||
    generationWire.usageMetadata.promptTokenCount +
      generationWire.usageMetadata.candidatesTokenCount !==
      generationWire.usageMetadata.totalTokenCount ||
    !string(prediction.artifactSha256) ||
    !string(adapterTrace.requestId) ||
    !number(prediction.latencyMs)
  )
    return undefined;
  let payload: unknown;
  try {
    payload = parseStrictJson(
      generationWire.candidates[0].content.parts[0].text,
    );
  } catch {
    return undefined;
  }
  const parsed = parsePdfOcrV3(payload, {
    artifactSha256: prediction.artifactSha256,
    pageCount: expectedCase.artifact.pageCount,
    requestId: adapterTrace.requestId,
    responseId: generationWire.responseId,
    modelVersion: generationWire.modelVersion,
    usage: {
      inputTokens: generationWire.usageMetadata.promptTokenCount,
      outputTokens: generationWire.usageMetadata.candidatesTokenCount,
      totalTokens: generationWire.usageMetadata.totalTokenCount,
    },
    latencyMs: prediction.latencyMs,
  });
  if (parsed.ok) return providerNativeOutcome(parsed.value);
  if (
    parsed.error.code === PdfOcrFailureCode.DOCUMENT_UNREADABLE ||
    parsed.error.code === PdfOcrFailureCode.LIMIT_EXCEEDED
  )
    return {
      kind: "ERROR",
      errorCode: parsed.error.code,
      retryable: false,
    };
  return undefined;
}

function validCaptureLedger(value: Record<string, unknown>): boolean {
  if (
    !Array.isArray(value.attemptLedger) ||
    value.attemptLedger.length !== OCR_SYNTH_SCANNED_RELEASE_CASES.length ||
    !Array.isArray(value.predictions) ||
    !object(value.run) ||
    !object(value.qualityClosure) ||
    !object(value.qualityClosure.snapshot)
  )
    return false;
  let cumulativeMeasuredMicros = 0;
  const run = value.run as Record<string, unknown>;
  const closure = value.qualityClosure as Record<string, unknown>;
  const snapshot = closure.snapshot as Record<string, unknown>;
  const predictionById = new Map(
    value.predictions
      .filter(object)
      .map((prediction) => [prediction.caseId, prediction]),
  );
  for (const [
    caseIndex,
    expectedCase,
  ] of OCR_SYNTH_SCANNED_RELEASE_CASES.entries()) {
    const group = value.attemptLedger[caseIndex];
    if (
      !object(group) ||
      group.caseId !== expectedCase.id ||
      !Array.isArray(group.events) ||
      group.events.length !== 6
    )
      return false;
    const events = group.events;
    const kinds = [
      "COUNT_TOKENS_REQUEST",
      "COUNT_TOKENS_RESPONSE",
      "ADMISSION_DECISION",
      "GENERATION_REQUEST",
      "GENERATION_RESPONSE",
      "SPEND_RECONCILED",
    ];
    if (
      events.some(
        (event, index) =>
          !object(event) ||
          event.kind !== kinds[index] ||
          event.sequence !== index + 1,
      )
    )
      return false;
    const first = events[0] as Record<string, unknown>;
    const prediction = predictionById.get(expectedCase.id);
    if (!prediction || !object(prediction.adapterTrace)) return false;
    const adapterTrace = prediction.adapterTrace;
    const usage = prediction.usage;
    const cost = prediction.cost;
    if (!object(usage) || !object(cost)) return false;
    if (
      prediction.tenantId !== expectedCase.tenantId ||
      events.some(
        (event) =>
          !object(event) ||
          event.runId !== run.candidateSha ||
          event.runAttempt !== 1 ||
          event.caseId !== expectedCase.id ||
          event.tenantId !== prediction.tenantId ||
          event.artifactSha256 !== prediction.artifactSha256 ||
          event.requestId !== adapterTrace.requestId ||
          event.requestPlanSha256 !== adapterTrace.requestPlanSha256 ||
          event.repositoryTreeSha !== snapshot.treeSha,
      ) ||
      first.requestBodySha256 !== adapterTrace.countRequestBodySha256 ||
      (events[3] as Record<string, unknown>).requestBodySha256 !==
        adapterTrace.generationRequestBodySha256
    )
      return false;
    const count = events[1] as Record<string, unknown>;
    const countWire = parseWireBytes(responseBytes(count));
    if (
      !number(countWire.totalTokens) ||
      count.parsedInputTokens !== countWire.totalTokens
    )
      return false;
    const admission = events[2] as Record<string, unknown>;
    if (
      admission.decision !== "ADMITTED" ||
      admission.countTokensResponseSha256 !== count.responseSha256 ||
      admission.countedInputTokens !== countWire.totalTokens ||
      admission.spentKnownBeforeMicros !== cumulativeMeasuredMicros ||
      !number(admission.worstCaseCurrentMicros) ||
      !number(admission.cumulativeWorstCaseMicros) ||
      admission.cumulativeWorstCaseMicros !==
        cumulativeMeasuredMicros + admission.worstCaseCurrentMicros
    )
      return false;
    const generation = events[4] as Record<string, unknown>;
    const generationWire = parseWireBytes(responseBytes(generation));
    const replayedOutcome = replayGenerationOutcome(
      generationWire,
      expectedCase,
      prediction,
      adapterTrace,
    );
    if (
      replayedOutcome === undefined ||
      !sameJsonValue(replayedOutcome, prediction.outcome) ||
      !string(generationWire.responseId) ||
      !string(generationWire.modelVersion) ||
      generation.responseId !== generationWire.responseId ||
      generation.modelVersion !== generationWire.modelVersion ||
      adapterTrace.responseId !== generationWire.responseId ||
      prediction.modelVersion !== generationWire.modelVersion ||
      run.modelVersion !== generationWire.modelVersion ||
      !object(generationWire.usageMetadata) ||
      usage.inputTokens !== generationWire.usageMetadata.promptTokenCount ||
      usage.outputTokens !==
        generationWire.usageMetadata.candidatesTokenCount ||
      usage.totalTokens !== generationWire.usageMetadata.totalTokenCount
    )
      return false;
    const reconciled = events[5] as Record<string, unknown>;
    if (
      !number(reconciled.measuredCurrentMicros) ||
      reconciled.cumulativeMeasuredMicros !==
        cumulativeMeasuredMicros + reconciled.measuredCurrentMicros ||
      reconciled.cumulativeWorstCaseMicros !==
        admission.cumulativeWorstCaseMicros ||
      cost.amountMicros !== reconciled.measuredCurrentMicros
    )
      return false;
    cumulativeMeasuredMicros = reconciled.cumulativeMeasuredMicros as number;
  }
  return true;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value as object))
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

export function isStructurallyValidatedLiveEvidence(value: unknown): boolean {
  return (
    object(value) &&
    (value as Record<PropertyKey, unknown>)[
      STRUCTURALLY_VALIDATED_LIVE_EVIDENCE
    ] === true
  );
}

export function parseLiveEvidence(value: unknown): OcrEvalInput {
  const canonicalCaptureKeys = [
    "datasetVersion",
    "run",
    "predictions",
    "attemptLedger",
    "qualityClosure",
  ] as const;
  if (exact(value, canonicalCaptureKeys)) {
    if (
      value.datasetVersion !== OCR_SYNTH_DATASET.datasetVersion ||
      !isValidLiveRun(value.run) ||
      !Array.isArray(value.predictions) ||
      !value.predictions.every((item) => validPrediction(item)) ||
      !exactIdSet(
        value.predictions.map((item) => item.caseId),
        OCR_SYNTH_SCANNED_RELEASE_CASES.map((item) => item.id),
      ) ||
      !unique(value.predictions.map((item) => item.adapterTrace.requestId)) ||
      !validCapturedQualityClosure(
        value.qualityClosure,
        object(value.run) ? value.run.candidateSha : undefined,
      ) ||
      !validCaptureLedger(value)
    )
      fail();
    Object.defineProperty(value, STRUCTURALLY_VALIDATED_LIVE_EVIDENCE, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return deepFreeze(value) as unknown as OcrEvalInput;
  }
  const baseKeys = [
    "datasetVersion",
    "run",
    "predictions",
    "routingCases",
    "safetyProbes",
  ] as const;
  const closureKeys = [...baseKeys, "qualityClosure"] as const;
  const captureKeys = [...baseKeys, "rawResponses", "attemptLedger"] as const;
  const captureClosureKeys = [...captureKeys, "qualityClosure"] as const;
  if (
    (!exact(value, baseKeys) &&
      !exact(value, closureKeys) &&
      !exact(value, captureKeys) &&
      !exact(value, captureClosureKeys)) ||
    value.datasetVersion !== OCR_SYNTH_DATASET.datasetVersion ||
    !isValidLiveRun(value.run) ||
    !Array.isArray(value.predictions) ||
    !value.predictions.every((item) => validPrediction(item)) ||
    !Array.isArray(value.routingCases) ||
    !value.routingCases.every((item) => isValidLiveRoute(item)) ||
    !Array.isArray(value.safetyProbes) ||
    !value.safetyProbes.every((item) => isValidLiveProbe(item)) ||
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
    !unique(value.predictions.map((item) => item.adapterTrace.requestId)) ||
    !object(value.run) ||
    ("qualityClosure" in value &&
      !validQualityClosure(value.qualityClosure, value.run.candidateSha)) ||
    ("rawResponses" in value &&
      (!Array.isArray(value.rawResponses) ||
        value.rawResponses.length !== OCR_SYNTH_SCANNED_RELEASE_CASES.length ||
        !object(value.attemptLedger)))
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
    value = parseStrictJson(raw);
  } catch {
    fail();
  }
  return value;
}
