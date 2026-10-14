import { createHash } from "node:crypto";
import {
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
} from "@reformaflow/domain";
import { VertexPdfOcrProvider } from "../import-session/ocr/vertex-pdf-ocr.provider";
import { OCR_SYNTH_DATASET, OCR_SYNTH_ROUTING_CASES } from "./corpus";
import { artifactSha256, generateArtifact } from "./fixture-generator";
import {
  DIRECT_PDF_VERTEX_CONFIG,
  KNOWN_SAFETY_FINISH_REASONS,
  OCR_DURABLE_PROBE_IDS,
  OCR_PROVIDER_CALL_PROBE_IDS,
  REAL_SERVICE_CONTEXT_PROBE_IDS,
  REAL_SERVICE_CONTEXT_TEST,
  type OcrEvalInput,
  type OcrEvalRunConfig,
} from "./evaluator";
import {
  isValidLiveProbe,
  isValidLiveRoute,
  isValidLiveRun,
  parseJson,
  parseLiveEvidence,
} from "./live-evidence-parser";
import { providerNativeOutcome } from "./provider-native-outcome";
import {
  SAFETY_PROBE_IDS,
  type OcrRoutingEvidence,
  type OcrSafetyProbeEvidence,
} from "./types";

export const LIVE_CAPTURE_CASE_IDS = Object.freeze([
  "scan-001",
  "scan-002",
  "scan-003",
  "scan-004",
  "scan-005",
  "scan-006",
  "scan-007",
  "scan-008",
  "scan-009",
  "scan-010",
  "scan-011",
  "scan-012",
  "scan-013",
  "scan-014",
  "scan-015",
  "scan-016",
  "scan-017",
  "scan-018",
] as const);
const ROUTING_EVIDENCE_TEST =
  "apps/api/src/imports/import-session/ocr/pdf-ocr-analyze.integration.spec.ts";

export interface CaptureLiveManifest {
  readonly candidateSha: string;
  readonly configurationSha256: string;
  readonly adapterSha256: string;
  readonly declaredLimits: OcrEvalRunConfig["declaredLimits"];
  readonly durableBudgets: NonNullable<OcrEvalRunConfig["durableBudgets"]>;
  readonly residualRiskAcceptance: NonNullable<
    OcrEvalRunConfig["residualRiskAcceptance"]
  >;
  readonly finalReviews: NonNullable<OcrEvalRunConfig["finalReviews"]>;
  readonly pricing: NonNullable<OcrEvalRunConfig["pricing"]>;
  readonly routingCases: OcrRoutingEvidence[];
  readonly safetyProbes: OcrSafetyProbeEvidence[];
}

export interface CaptureLiveOptions {
  readonly provider: VertexPdfOcrProvider;
  readonly manifest: CaptureLiveManifest;
  readonly currentRepoSha: string;
  readonly memoryRss?: () => number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export function parseCaptureLiveManifestJson(raw: string): CaptureLiveManifest {
  const value = parseJson(raw);
  const keys = [
    "candidateSha",
    "configurationSha256",
    "adapterSha256",
    "declaredLimits",
    "durableBudgets",
    "residualRiskAcceptance",
    "finalReviews",
    "pricing",
    "routingCases",
    "safetyProbes",
  ];
  if (
    !record(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    !keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) ||
    !Array.isArray(value.routingCases) ||
    !value.routingCases.every(isValidLiveRoute) ||
    !Array.isArray(value.safetyProbes) ||
    !value.safetyProbes.every(isValidLiveProbe)
  )
    throw new Error("LIVE_CAPTURE_CONFIG_INVALID");
  const run = {
    mode: "LIVE_CAPTURE",
    candidateSha: value.candidateSha,
    configurationSha256: value.configurationSha256,
    adapterSha256: value.adapterSha256,
    provider: PDF_OCR_PROVIDER_ID,
    model: PDF_OCR_MODEL_ID,
    modelVersion: "CAPTURE_PREFLIGHT",
    region: PDF_OCR_REGION,
    endpoint: DIRECT_PDF_VERTEX_CONFIG.endpoint,
    promptSha256: "0".repeat(64),
    baseline: {
      sha: OCR_SYNTH_DATASET.baseSha,
      behavior: "OCR_REQUIRED",
      sampleCount: 18,
    },
    declaredLimits: value.declaredLimits,
    durableBudgets: value.durableBudgets,
    residualRiskAcceptance: value.residualRiskAcceptance,
    finalReviews: value.finalReviews,
    pricing: value.pricing,
  };
  if (!isValidLiveRun(run)) throw new Error("LIVE_CAPTURE_CONFIG_INVALID");
  return value as unknown as CaptureLiveManifest;
}

const requestId = (candidateSha: string, caseId: string): string => {
  const value = createHash("sha256")
    .update(`${OCR_SYNTH_DATASET.datasetVersion}:${candidateSha}:${caseId}`)
    .digest();
  value[6] = (value[6]! & 0x0f) | 0x40;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = value.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const exactIds = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  actual.every((id, index) => id === expected[index]);

async function preflight(
  manifest: CaptureLiveManifest,
  currentRepoSha: string,
): Promise<
  Array<{
    testCase: (typeof import("./corpus").OCR_SYNTH_SCANNED_RELEASE_CASES)[number];
    bytes: Buffer;
    hash: string;
  }>
> {
  const scanned = OCR_SYNTH_DATASET.cases.filter(
    (item) => item.partition === "SCANNED_PDF",
  );
  if (
    !/^[0-9a-f]{40}$/.test(currentRepoSha) ||
    manifest.candidateSha !== currentRepoSha ||
    !exactIds(
      scanned.map((item) => item.id),
      LIVE_CAPTURE_CASE_IDS,
    ) ||
    scanned.some(
      (item) =>
        item.artifact.kind !== "PDF_SCAN" ||
        !item.tags.includes("image-only-pdf"),
    ) ||
    !exactIds(
      manifest.routingCases.map((item) => item.caseId),
      OCR_SYNTH_ROUTING_CASES.map((item) => item.id),
    ) ||
    manifest.routingCases.some(
      (item) =>
        item.source !== "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED" ||
        item.providerCalls !== 0 ||
        item.financialWrites !== 0 ||
        !item.routedLocally ||
        !item.explicitFallback,
    ) ||
    !exactIds(
      manifest.safetyProbes.map((item) => item.id),
      SAFETY_PROBE_IDS,
    ) ||
    manifest.safetyProbes.some(
      (item) =>
        item.source !== "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED" ||
        !item.blocked ||
        !item.explicitError ||
        !/^[A-Z][A-Z0-9_]+$/.test(item.errorCode) ||
        item.providerCalls !==
          (OCR_PROVIDER_CALL_PROBE_IDS.has(item.id) ? 1 : 0) ||
        item.financialWrites !== 0 ||
        (OCR_DURABLE_PROBE_IDS.has(item.id) && !item.durableStateVerified) ||
        (item.id === "KNOWN_SAFETY_FINISH_REASONS" &&
          JSON.stringify(item.finishReasonsTested) !==
            JSON.stringify(KNOWN_SAFETY_FINISH_REASONS)) ||
        (REAL_SERVICE_CONTEXT_PROBE_IDS.includes(
          item.id as (typeof REAL_SERVICE_CONTEXT_PROBE_IDS)[number],
        ) &&
          item.testFile !== REAL_SERVICE_CONTEXT_TEST) ||
        !/^apps\/api\/src\/imports\/.+\.spec\.ts$/.test(item.testFile),
    )
  )
    throw new Error("LIVE_CAPTURE_PREFLIGHT_FAILED");

  const artifacts = [];
  for (const testCase of scanned) {
    const bytes = await generateArtifact(testCase);
    artifacts.push({
      testCase,
      bytes,
      hash: artifactSha256(bytes),
    });
  }
  const routesById = new Map(
    manifest.routingCases.map((item) => [item.caseId, item]),
  );
  for (const testCase of OCR_SYNTH_ROUTING_CASES) {
    const bytes = await generateArtifact(testCase);
    const route = routesById.get(testCase.id);
    const reasons: OcrRoutingEvidence["detectedReasons"] = [
      "MIXED",
      "SEARCHABLE",
    ];
    if (testCase.tags.includes("raster-logo")) reasons.push("RASTER_LOGO");
    if (testCase.tags.includes("hidden-text")) reasons.push("HIDDEN_TEXT");
    if (
      !route ||
      route.tenantId !== testCase.tenantId ||
      route.artifactSha256 !== artifactSha256(bytes) ||
      JSON.stringify(route.detectedReasons) !== JSON.stringify(reasons) ||
      route.testFile !== ROUTING_EVIDENCE_TEST
    )
      throw new Error("LIVE_CAPTURE_PREFLIGHT_FAILED");
  }
  return artifacts;
}

export async function captureLiveEvidence(
  options: CaptureLiveOptions,
): Promise<OcrEvalInput> {
  if (
    !(options.provider instanceof VertexPdfOcrProvider) ||
    !options.provider.ready()
  )
    throw new Error("LIVE_CAPTURE_PROVIDER_INVALID");
  const artifacts = await preflight(options.manifest, options.currentRepoSha);
  const rss = options.memoryRss ?? (() => process.memoryUsage().rss);
  const predictions: OcrEvalInput["predictions"] = [];
  const responseIds = new Set<string>();
  const requestIds = new Set<string>();
  let modelVersion: string | undefined;
  let promptSha256: string | undefined;

  for (const { testCase, bytes, hash } of artifacts) {
    const caseRequestId = requestId(options.manifest.candidateSha, testCase.id);
    const document = await options.provider.extractPdf({
      artifactSha256: hash,
      pageCount: testCase.artifact.pageCount,
      requestId: caseRequestId,
      pdfBytes: bytes,
      signal: new AbortController().signal,
    });
    const trace = document.provenance.requestTrace;
    if (
      document.artifactSha256 !== hash ||
      document.pageCount !== testCase.artifact.pageCount ||
      document.provenance.provider !== PDF_OCR_PROVIDER_ID ||
      document.provenance.model !== PDF_OCR_MODEL_ID ||
      document.provenance.region !== PDF_OCR_REGION ||
      document.provenance.requestId !== caseRequestId ||
      !trace ||
      trace.requestId !== caseRequestId ||
      trace.originalBytesSha256 !== hash ||
      trace.endpoint !== DIRECT_PDF_VERTEX_CONFIG.endpoint ||
      trace.finishReason !== "STOP"
    )
      throw new Error("LIVE_CAPTURE_PROVIDER_CONTRACT_FAILED");
    if (
      requestIds.has(caseRequestId) ||
      responseIds.has(document.provenance.responseId) ||
      (modelVersion !== undefined &&
        modelVersion !== document.provenance.modelVersion) ||
      (promptSha256 !== undefined && promptSha256 !== trace.promptSha256)
    )
      throw new Error("LIVE_CAPTURE_PROVENANCE_MISMATCH");
    requestIds.add(caseRequestId);
    responseIds.add(document.provenance.responseId);
    modelVersion = document.provenance.modelVersion;
    promptSha256 = trace.promptSha256;
    const usage = document.provenance.usage;
    const costMicros = Math.ceil(
      (usage.inputTokens *
        options.manifest.pricing.inputMicrosPerMillionTokens +
        usage.outputTokens *
          options.manifest.pricing.outputMicrosPerMillionTokens) /
        1_000_000,
    );
    predictions.push({
      caseId: testCase.id,
      tenantId: testCase.tenantId,
      artifactSha256: hash,
      outcome: providerNativeOutcome(document),
      provider: document.provenance.provider,
      model: document.provenance.model,
      modelVersion: document.provenance.modelVersion,
      promptSha256: trace.promptSha256,
      schemaValid: true,
      latencyMs: document.provenance.latencyMs,
      peakRssBytes: rss(),
      usage: { ...usage },
      cost: { currency: "USD", amountMicros: costMicros },
      adapterTrace: {
        seam: DIRECT_PDF_VERTEX_CONFIG.seam,
        requestId: caseRequestId,
        endpoint: trace.endpoint,
        region: document.provenance.region,
        model: document.provenance.model,
        authTrace: trace.authTrace,
        adcScopes: [...trace.adcScopes],
        apiKeyUsed: false,
        globalEndpointFallbackUsed: false,
        inputMimeType: trace.inputMimeType,
        inputMode: trace.inputMode,
        originalBytesSha256: trace.originalBytesSha256,
        requestBodyBytes: trace.requestBodyBytes,
        deadlineMs: trace.deadlineMs,
        finishReason: trace.finishReason,
        maxOutputTokens: trace.maxOutputTokens,
        promptContract: {
          rawCandidatesOnly: true,
          allVisibleOccurrences: true,
          allPagesInOrder: true,
          preserveDuplicates: true,
          signedAmountIncludesNegativeZeroUnknown: true,
          noFinancialExclusionsOrClassification: true,
        },
        toolsPresent: trace.toolsPresent,
        fileUri: trace.fileUri,
        cachedContent: trace.cachedContent,
        providerCallCount: 1,
        responseId: document.provenance.responseId,
        attempts: 1,
        ambiguousTimeoutRetried: false,
        textualPdf: false,
        localFinancialRowsMerged: 0,
      },
      capturePath: "DIRECT_PROVIDER_CAPTURE",
      consentRecorded: false,
      consentCapability: null,
      attestationRequired: null,
      financialWrites: 0,
    });
  }
  if (!modelVersion || !promptSha256)
    throw new Error("LIVE_CAPTURE_INCOMPLETE");

  return parseLiveEvidence({
    datasetVersion: OCR_SYNTH_DATASET.datasetVersion,
    run: {
      mode: "LIVE_CAPTURE",
      candidateSha: options.manifest.candidateSha,
      configurationSha256: options.manifest.configurationSha256,
      adapterSha256: options.manifest.adapterSha256,
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      modelVersion,
      region: PDF_OCR_REGION,
      endpoint: DIRECT_PDF_VERTEX_CONFIG.endpoint,
      promptSha256,
      baseline: {
        sha: OCR_SYNTH_DATASET.baseSha,
        behavior: "OCR_REQUIRED",
        sampleCount: 18,
      },
      declaredLimits: options.manifest.declaredLimits,
      durableBudgets: options.manifest.durableBudgets,
      residualRiskAcceptance: options.manifest.residualRiskAcceptance,
      finalReviews: options.manifest.finalReviews,
      pricing: options.manifest.pricing,
    },
    predictions,
    routingCases: options.manifest.routingCases,
    safetyProbes: options.manifest.safetyProbes,
  });
}
