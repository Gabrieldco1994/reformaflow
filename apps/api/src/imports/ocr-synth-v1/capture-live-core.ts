import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
} from "@reformaflow/domain";
import {
  PdfOcrProviderError,
  VertexPdfOcrProvider,
} from "../import-session/ocr/vertex-pdf-ocr.provider";
import { parseStrictJson } from "../import-session/ocr/strict-json";
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
  SAFETY_PROBE_SCENARIOS,
  type OcrRoutingEvidence,
  type OcrSafetyProbeEvidence,
} from "./types";
import type {
  FinalReviewHashes,
  QualityClosurePolicy,
} from "./quality-closure-attestation";
import type { OcrQualityClosure } from "./types";
import qualityPolicy from "./quality-closure-policy.json";

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
  readonly residualRiskAcceptance: OcrEvalRunConfig["residualRiskAcceptance"];
  readonly finalReviews: OcrEvalRunConfig["finalReviews"];
  readonly pricing: NonNullable<OcrEvalRunConfig["pricing"]>;
  readonly routingCases: OcrRoutingEvidence[];
  readonly safetyProbes: OcrSafetyProbeEvidence[];
}

export interface CaptureLiveOptions {
  readonly provider: VertexPdfOcrProvider;
  readonly manifest?: CaptureLiveManifest;
  readonly currentRepoSha?: string;
  readonly mechanical?: {
    readonly policy: QualityClosurePolicy;
    readonly qualityClosure: OcrQualityClosure;
    readonly finalReviewHashes: FinalReviewHashes;
    readonly verifySnapshot: () => Promise<void>;
  };
  readonly memoryRss?: () => number;
  readonly readProcSelfStatus?: (path: string) => Promise<string>;
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
    !value.routingCases.every((item) => isValidLiveRoute(item)) ||
    !Array.isArray(value.safetyProbes) ||
    !value.safetyProbes.every((item) => isValidLiveProbe(item))
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
const qualificationSource = (name: string): string => {
  const entry = qualityPolicy.qualificationTests.find(
    (candidate) => candidate.name === name,
  );
  if (!entry) throw new Error("LIVE_CAPTURE_RAW_EVIDENCE_INVALID");
  return entry.sourcePath;
};

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

async function mechanicalManifest(
  policy: QualityClosurePolicy,
  qualityClosure: OcrQualityClosure,
  reviews: FinalReviewHashes,
): Promise<CaptureLiveManifest> {
  const routingCases: OcrRoutingEvidence[] = [];
  for (const testCase of OCR_SYNTH_ROUTING_CASES) {
    const bytes = await generateArtifact(testCase);
    const detectedReasons: OcrRoutingEvidence["detectedReasons"] = [
      "MIXED",
      "SEARCHABLE",
    ];
    if (testCase.tags.includes("raster-logo"))
      detectedReasons.push("RASTER_LOGO");
    if (testCase.tags.includes("hidden-text"))
      detectedReasons.push("HIDDEN_TEXT");
    routingCases.push({
      caseId: testCase.id,
      tenantId: testCase.tenantId,
      artifactSha256: artifactSha256(bytes),
      source: "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED",
      detectedReasons,
      providerCalls: 0,
      routedLocally: true,
      explicitFallback: true,
      financialWrites: 0,
      testFile: qualificationSource(`[ROUTE] ${testCase.id}`),
    });
  }
  const safetyProbes: OcrSafetyProbeEvidence[] = SAFETY_PROBE_IDS.map((id) => {
    const scenarios = (
      SAFETY_PROBE_SCENARIOS as Readonly<Record<string, readonly string[]>>
    )[id];
    return {
      id,
      source: "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED",
      blocked: true,
      explicitError: true,
      errorCode: id,
      providerCalls: OCR_PROVIDER_CALL_PROBE_IDS.has(id) ? 1 : 0,
      financialWrites: 0,
      durableStateVerified: OCR_DURABLE_PROBE_IDS.has(id),
      finishReasonsTested:
        id === "KNOWN_SAFETY_FINISH_REASONS"
          ? [...KNOWN_SAFETY_FINISH_REASONS]
          : [],
      testFile: qualificationSource(`[PROBE] ${id}`),
      ...(scenarios ? { scenarios: [...scenarios] } : {}),
    };
  });
  if (
    routingCases.length !== 10 ||
    safetyProbes.length !== 35 ||
    routingCases.some((item) => !isValidLiveRoute(item)) ||
    safetyProbes.some((item) => !isValidLiveProbe(item))
  )
    throw new Error("LIVE_CAPTURE_RAW_EVIDENCE_INVALID");
  const policySha256 = qualityClosure.snapshot.policySha256;
  return {
    candidateSha: qualityClosure.snapshot.headSha,
    configurationSha256: qualityClosure.snapshot.configurationSha256,
    adapterSha256: qualityClosure.snapshot.adapterSha256,
    declaredLimits: {
      maxP95LatencyMs: policy.declaredLimits.maxP95LatencyMs,
      maxTotalCostMicros: policy.declaredLimits.maxTotalCostMicros,
      maxRequestBodyBytes: policy.declaredLimits.maxRequestBodyBytes,
      maxProviderDeadlineMs: policy.declaredLimits.maxProviderDeadlineMs,
    },
    durableBudgets: {
      policySha256,
      tenantLimitMicros: policy.durableBudgets.tenantLimitMicros,
      globalLimitMicros: policy.durableBudgets.globalLimitMicros,
      storage: policy.durableBudgets.storage,
    },
    residualRiskAcceptance: reviews.residualRiskAcceptance
      ? {
          decision: "OPTION_1_COMPLETE_ORIGINAL_PDF",
          dataOwnerAcceptanceSha256: reviews.residualRiskAcceptance,
          noLocalDerivative: true,
        }
      : null,
    finalReviews:
      reviews.securityReview && reviews.privacyReview && reviews.dataOwnerReview
        ? {
            securityReviewSha256: reviews.securityReview,
            privacyReviewSha256: reviews.privacyReview,
            dataOwnerReviewSha256: reviews.dataOwnerReview,
          }
        : null,
    pricing: {
      source: policy.pricing.source,
      effectiveDate: policy.pricing.observedOn,
      inputMicrosPerMillionTokens: policy.pricing.inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens: policy.pricing.outputMicrosPerMillionTokens,
    },
    routingCases,
    safetyProbes,
  };
}

function structurallyBoundLegacyClosure(
  manifest: CaptureLiveManifest,
): OcrQualityClosure {
  return {
    version: 2,
    policyVersion: qualityPolicy.policyVersion,
    snapshot: {
      headSha: manifest.candidateSha,
      treeSha: manifest.candidateSha,
      clean: true,
      policySha256: manifest.durableBudgets.policySha256,
      corpusSha256: manifest.configurationSha256,
      configurationSha256: manifest.configurationSha256,
      adapterSha256: manifest.adapterSha256,
      runtimeSha256: manifest.adapterSha256,
      suiteSha256: manifest.configurationSha256,
    },
    tests: qualityPolicy.qualificationTests.map((item) => ({
      name: item.name,
      status: "PASS",
      sourcePath: item.sourcePath,
    })),
  };
}

const PROC_SELF_STATUS = "/proc/self/status";
const VM_HWM = /^VmHWM:\s+([0-9]+)\s+kB$/m;

async function linuxVmHwmBytes(
  readStatus: (path: string) => Promise<string>,
): Promise<number> {
  try {
    const status = await readStatus(PROC_SELF_STATUS);
    const match = VM_HWM.exec(status);
    const kibibytes = match ? Number(match[1]) : Number.NaN;
    const bytes = kibibytes * 1024;
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new Error("invalid VmHWM");
    return bytes;
  } catch {
    throw new Error("LIVE_CAPTURE_VMHWM_UNAVAILABLE");
  }
}

export async function captureLiveEvidence(
  options: CaptureLiveOptions,
): Promise<OcrEvalInput> {
  if (
    !(options.provider instanceof VertexPdfOcrProvider) ||
    !options.provider.ready()
  )
    throw new Error("LIVE_CAPTURE_PROVIDER_INVALID");
  if (options.mechanical && process.platform !== "linux")
    throw new Error("LIVE_CAPTURE_VMHWM_UNAVAILABLE");
  const manifest = options.mechanical
    ? await mechanicalManifest(
        options.mechanical.policy,
        options.mechanical.qualityClosure,
        options.mechanical.finalReviewHashes,
      )
    : options.manifest;
  const currentRepoSha = options.mechanical
    ? options.mechanical.qualityClosure.snapshot.headSha
    : options.currentRepoSha;
  if (!manifest || !currentRepoSha)
    throw new Error("LIVE_CAPTURE_CONFIG_MISSING");
  const artifacts = await preflight(manifest, currentRepoSha);
  const memoryHighWaterMark = options.memoryRss
    ? async () => options.memoryRss!()
    : options.mechanical ||
        options.readProcSelfStatus ||
        process.platform === "linux"
      ? async () =>
          linuxVmHwmBytes(
            options.readProcSelfStatus ??
              ((path) => readFile(path, { encoding: "utf8" })),
          )
      : async () => process.memoryUsage().rss;
  await memoryHighWaterMark();
  const predictions: OcrEvalInput["predictions"] = [];
  const responseIds = new Set<string>();
  const requestIds = new Set<string>();
  let modelVersion: string | undefined;
  let promptSha256: string | undefined;
  let measuredSpendMicros = 0;
  let worstCaseSpendMicros = 0;
  const rawResponses: Array<Record<string, unknown>> = [];
  const attemptEvents: Array<Record<string, any>> = [];
  const requestPlanSha256ByCase: Record<string, string> = {};

  for (const { testCase, bytes, hash } of artifacts) {
    const caseRequestId = requestId(manifest.candidateSha, testCase.id);
    const rawByPhase: Partial<
      Record<"COUNT_TOKENS" | "GENERATE_CONTENT", Buffer>
    > = {};
    const spentKnownBeforeMicros = worstCaseSpendMicros;
    let document: Awaited<
      ReturnType<VertexPdfOcrProvider["extractPdf"]>
    > | null = null;
    let terminalError: PdfOcrProviderError | null = null;
    try {
      document = await options.provider.extractPdf(
        {
          artifactSha256: hash,
          pageCount: testCase.artifact.pageCount,
          requestId: caseRequestId,
          pdfBytes: bytes,
          signal: new AbortController().signal,
          qualificationCapture: true,
          captureResponseBytes: (phase, responseBytes) => {
            if (rawByPhase[phase])
              throw new Error("LIVE_CAPTURE_RAW_EVIDENCE_INVALID");
            rawByPhase[phase] = Buffer.from(responseBytes);
          },
        },
        {
          beforeGeneration: async (_signal, admission) => {
            const worstCaseMicros = Math.ceil(
              (admission.inputTokens *
                manifest.pricing.inputMicrosPerMillionTokens +
                admission.reservedOutputTokens *
                  manifest.pricing.outputMicrosPerMillionTokens) /
                1_000_000,
            );
            if (
              worstCaseSpendMicros + worstCaseMicros >
              manifest.declaredLimits.maxTotalCostMicros!
            )
              throw new Error("CAPTURE_SPEND_LIMIT");
          },
        },
      );
    } catch (error) {
      if (
        error instanceof PdfOcrProviderError &&
        (error.failure === "DOCUMENT_UNREADABLE" ||
          error.failure === "LIMIT_EXCEEDED") &&
        error.provenance
      )
        terminalError = error;
      else throw error;
    } finally {
      await options.mechanical?.verifySnapshot();
    }

    const provenance = document?.provenance ?? terminalError!.provenance!;
    const trace = provenance.requestTrace;
    if (
      (document !== null &&
        (document.artifactSha256 !== hash ||
          document.pageCount !== testCase.artifact.pageCount)) ||
      provenance.provider !== PDF_OCR_PROVIDER_ID ||
      provenance.model !== PDF_OCR_MODEL_ID ||
      provenance.region !== PDF_OCR_REGION ||
      provenance.requestId !== caseRequestId ||
      !trace ||
      trace.requestId !== caseRequestId ||
      trace.originalBytesSha256 !== hash ||
      trace.endpoint !== DIRECT_PDF_VERTEX_CONFIG.endpoint ||
      trace.finishReason !== "STOP"
    )
      throw new Error("LIVE_CAPTURE_PROVIDER_CONTRACT_FAILED");
    const countBytes = rawByPhase.COUNT_TOKENS;
    const generationBytes = rawByPhase.GENERATE_CONTENT;
    if (
      !countBytes ||
      !generationBytes ||
      !trace.requestPlanSha256 ||
      !trace.countRequestBodySha256 ||
      !trace.generationRequestBodySha256
    )
      throw new Error("LIVE_CAPTURE_RAW_EVIDENCE_INVALID");
    const capturedAttempt = await executeCapturedAttempt({
      runId: manifest.candidateSha,
      runAttempt: 1,
      caseId: testCase.id,
      requestId: caseRequestId,
      requestPlanSha256: trace.requestPlanSha256,
      countTokensRequestSha256: trace.countRequestBodySha256,
      spentKnownBeforeMicros,
      reservedOutputTokens: 8192,
      inputMicrosPerMillionTokens: manifest.pricing.inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens:
        manifest.pricing.outputMicrosPerMillionTokens,
      hardLimitMicros: 500_000,
      countTokens: async () => countBytes,
      generation: async () => generationBytes,
    });
    if (capturedAttempt.decision !== "ADMITTED")
      throw new Error("CAPTURE_SPEND_LIMIT");
    requestPlanSha256ByCase[testCase.id] = trace.requestPlanSha256;
    for (const event of capturedAttempt.ledger as Array<Record<string, any>>) {
      const bound: Record<string, any> = {
        ...event,
        sequence: attemptEvents.length + 1,
      };
      if (bound.kind === "GENERATION_REQUEST")
        bound.requestBodySha256 = trace.generationRequestBodySha256;
      if (bound.kind === "SPEND_RECONCILED")
        bound.cumulativeMeasuredMicros =
          measuredSpendMicros + bound.measuredCurrentMicros;
      attemptEvents.push(bound);
    }
    worstCaseSpendMicros = capturedAttempt.cumulativeWorstCaseMicros as number;
    rawResponses.push({
      caseId: testCase.id,
      requestId: caseRequestId,
      requestPlanSha256: trace.requestPlanSha256,
      countTokens: {
        responseBytesBase64: countBytes.toString("base64"),
        responseByteLength: countBytes.length,
        responseSha256: createHash("sha256").update(countBytes).digest("hex"),
      },
      generation: {
        responseBytesBase64: generationBytes.toString("base64"),
        responseByteLength: generationBytes.length,
        responseSha256: createHash("sha256")
          .update(generationBytes)
          .digest("hex"),
      },
    });
    if (
      requestIds.has(caseRequestId) ||
      responseIds.has(provenance.responseId) ||
      (modelVersion !== undefined &&
        modelVersion !== provenance.modelVersion) ||
      (promptSha256 !== undefined && promptSha256 !== trace.promptSha256)
    )
      throw new Error("LIVE_CAPTURE_PROVENANCE_MISMATCH");
    requestIds.add(caseRequestId);
    responseIds.add(provenance.responseId);
    modelVersion = provenance.modelVersion;
    promptSha256 = trace.promptSha256;
    const usage = provenance.usage;
    const costMicros = Math.ceil(
      (usage.inputTokens * manifest.pricing.inputMicrosPerMillionTokens +
        usage.outputTokens * manifest.pricing.outputMicrosPerMillionTokens) /
        1_000_000,
    );
    measuredSpendMicros += costMicros;
    predictions.push({
      caseId: testCase.id,
      tenantId: testCase.tenantId,
      artifactSha256: hash,
      outcome:
        document === null
          ? {
              kind: "ERROR",
              errorCode: terminalError!.failure,
              retryable: false,
            }
          : providerNativeOutcome(document),
      provider: provenance.provider,
      model: provenance.model,
      modelVersion: provenance.modelVersion,
      promptSha256: trace.promptSha256,
      schemaValid: true,
      latencyMs: provenance.latencyMs,
      peakRssBytes: await memoryHighWaterMark(),
      usage: { ...usage },
      cost: { currency: "USD", amountMicros: costMicros },
      adapterTrace: {
        seam: DIRECT_PDF_VERTEX_CONFIG.seam,
        requestId: caseRequestId,
        endpoint: trace.endpoint,
        region: provenance.region,
        model: provenance.model,
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
        responseId: provenance.responseId,
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
  await options.mechanical?.verifySnapshot();

  const evidence: OcrEvalInput = {
    datasetVersion: OCR_SYNTH_DATASET.datasetVersion,
    run: {
      mode: "LIVE_CAPTURE",
      candidateSha: manifest.candidateSha,
      configurationSha256: manifest.configurationSha256,
      adapterSha256: manifest.adapterSha256,
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
      declaredLimits: manifest.declaredLimits,
      durableBudgets: manifest.durableBudgets,
      residualRiskAcceptance: manifest.residualRiskAcceptance,
      finalReviews: manifest.finalReviews,
      pricing: manifest.pricing,
    },
    predictions,
    routingCases: manifest.routingCases,
    safetyProbes: manifest.safetyProbes,
    rawResponses,
    attemptLedger: {
      runId: manifest.candidateSha,
      runAttempt: 1,
      requestPlanSha256ByCase,
      ledger: attemptEvents,
    },
    qualityClosure:
      options.mechanical?.qualityClosure ??
      structurallyBoundLegacyClosure(manifest),
  };
  return parseLiveEvidence(evidence);
}

export interface CaptureGenerationAdmission {
  readonly spentKnownMicros: number;
  readonly countedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
  readonly limitMicros: number;
}

function safeNonnegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function pricedMicros(
  inputTokens: number,
  outputTokens: number,
  inputRate: number,
  outputRate: number,
): number {
  const numerator = inputTokens * inputRate + outputTokens * outputRate;
  if (!Number.isSafeInteger(numerator))
    throw new Error("CAPTURE_SPEND_ADMISSION_INVALID");
  return Math.ceil(numerator / 1_000_000);
}

/** Compatibility admission boundary backed by the same cumulative formula. */
export async function admitCaptureGeneration(
  input: CaptureGenerationAdmission,
  generation: () => Promise<void>,
): Promise<Readonly<{ status: "ADMITTED" | "CAPTURE_SPEND_LIMIT" }>> {
  const values = [
    input.spentKnownMicros,
    input.countedInputTokens,
    input.reservedOutputTokens,
    input.inputMicrosPerMillionTokens,
    input.outputMicrosPerMillionTokens,
    input.limitMicros,
  ];
  if (
    values.some((value) => !safeNonnegative(value)) ||
    input.limitMicros === 0
  )
    throw new Error("CAPTURE_SPEND_ADMISSION_INVALID");
  const current = pricedMicros(
    input.countedInputTokens,
    input.reservedOutputTokens,
    input.inputMicrosPerMillionTokens,
    input.outputMicrosPerMillionTokens,
  );
  const cumulative = input.spentKnownMicros + current;
  if (!Number.isSafeInteger(cumulative))
    throw new Error("CAPTURE_SPEND_ADMISSION_INVALID");
  if (cumulative > input.limitMicros)
    return Object.freeze({ status: "CAPTURE_SPEND_LIMIT" });
  await generation();
  return Object.freeze({ status: "ADMITTED" });
}

interface CapturedAttemptInput {
  readonly runId: string;
  readonly runAttempt: 1;
  readonly caseId: string;
  readonly requestId: string;
  readonly requestPlanSha256: string;
  readonly countTokensRequestSha256: string;
  readonly spentKnownBeforeMicros: number;
  readonly reservedOutputTokens: 8192;
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
  readonly hardLimitMicros: 500000;
  readonly countTokens: () => Promise<Buffer>;
  readonly generation: () => Promise<Buffer>;
}

const attemptSha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");
const encode = (bytes: Buffer) => bytes.toString("base64");
const boundedBytes = (value: unknown): Buffer => {
  if (
    !Buffer.isBuffer(value) ||
    value.length === 0 ||
    value.length > 64 * 1024 * 1024
  )
    throw new Error("RAW_VERTEX_RESPONSE_BYTES_INVALID");
  return value;
};

function parsedCountTokens(bytes: Buffer): number {
  let value: unknown;
  try {
    value = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error("COUNT_TOKENS_RESPONSE_BINDING_INVALID");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(value, "totalTokens") ||
    !Number.isSafeInteger((value as Record<string, unknown>).totalTokens) ||
    ((value as Record<string, unknown>).totalTokens as number) < 0
  )
    throw new Error("COUNT_TOKENS_RESPONSE_BINDING_INVALID");
  return (value as Record<string, number>).totalTokens;
}

function measuredGenerationCost(
  bytes: Buffer,
  inputRate: number,
  outputRate: number,
): number {
  try {
    const wire = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as Record<string, any>;
    const usage = wire.usageMetadata;
    if (
      !usage ||
      !safeNonnegative(usage.promptTokenCount) ||
      !safeNonnegative(usage.candidatesTokenCount) ||
      usage.totalTokenCount !==
        usage.promptTokenCount + usage.candidatesTokenCount
    )
      throw new Error();
    return pricedMicros(
      usage.promptTokenCount,
      usage.candidatesTokenCount,
      inputRate,
      outputRate,
    );
  } catch {
    throw new Error("RAW_VERTEX_RESPONSE_SCHEMA_INVALID");
  }
}

/**
 * Captures the call-boundary ledger in causal order. Input token authority
 * comes exclusively from the exact hashed countTokens response bytes.
 */
export async function executeCapturedAttempt(
  input: CapturedAttemptInput,
): Promise<Record<string, any>> {
  if (
    input.runAttempt !== 1 ||
    !input.runId ||
    !input.caseId ||
    !input.requestId ||
    !/^[0-9a-f]{64}$/.test(input.requestPlanSha256) ||
    !/^[0-9a-f]{64}$/.test(input.countTokensRequestSha256) ||
    !safeNonnegative(input.spentKnownBeforeMicros) ||
    input.reservedOutputTokens !== 8192 ||
    input.hardLimitMicros !== 500_000
  )
    throw new Error("ATTEMPT_LEDGER_SCHEMA_INVALID");
  const common = {
    runId: input.runId,
    runAttempt: input.runAttempt,
    caseId: input.caseId,
    requestId: input.requestId,
    requestPlanSha256: input.requestPlanSha256,
  };
  const ledger: Array<Record<string, any>> = [
    {
      ...common,
      sequence: 1,
      kind: "COUNT_TOKENS_REQUEST",
      requestBodySha256: input.countTokensRequestSha256,
    },
  ];
  const countBytes = boundedBytes(await input.countTokens());
  const countHash = attemptSha256(countBytes);
  const countedInputTokens = parsedCountTokens(countBytes);
  ledger.push({
    ...common,
    sequence: 2,
    kind: "COUNT_TOKENS_RESPONSE",
    responseBytesBase64: encode(countBytes),
    responseByteLength: countBytes.length,
    responseSha256: countHash,
    parsedInputTokens: countedInputTokens,
  });
  const worstCaseCurrentMicros = pricedMicros(
    countedInputTokens,
    input.reservedOutputTokens,
    input.inputMicrosPerMillionTokens,
    input.outputMicrosPerMillionTokens,
  );
  const cumulativeWorstCaseMicros =
    input.spentKnownBeforeMicros + worstCaseCurrentMicros;
  const decision =
    cumulativeWorstCaseMicros <= input.hardLimitMicros
      ? "ADMITTED"
      : "CAPTURE_SPEND_LIMIT";
  ledger.push({
    ...common,
    sequence: 3,
    kind: "ADMISSION_DECISION",
    countTokensResponseSha256: countHash,
    countedInputTokens,
    reservedOutputTokens: input.reservedOutputTokens,
    inputMicrosPerMillionTokens: input.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens: input.outputMicrosPerMillionTokens,
    spentKnownBeforeMicros: input.spentKnownBeforeMicros,
    worstCaseCurrentMicros,
    cumulativeWorstCaseMicros,
    hardLimitMicros: input.hardLimitMicros,
    decision,
  });
  if (decision === "CAPTURE_SPEND_LIMIT")
    return Object.freeze({
      decision,
      countedInputTokens,
      worstCaseCurrentMicros,
      cumulativeWorstCaseMicros,
      ledger: Object.freeze(ledger),
    });
  ledger.push({
    ...common,
    sequence: 4,
    kind: "GENERATION_REQUEST",
    requestBodySha256: attemptSha256(
      `${input.requestPlanSha256}:generateContent`,
    ),
  });
  const generationBytes = boundedBytes(await input.generation());
  ledger.push({
    ...common,
    sequence: 5,
    kind: "GENERATION_RESPONSE",
    responseBytesBase64: encode(generationBytes),
    responseByteLength: generationBytes.length,
    responseSha256: attemptSha256(generationBytes),
  });
  const measuredCurrentMicros = measuredGenerationCost(
    generationBytes,
    input.inputMicrosPerMillionTokens,
    input.outputMicrosPerMillionTokens,
  );
  ledger.push({
    ...common,
    sequence: 6,
    kind: "SPEND_RECONCILED",
    measuredCurrentMicros,
    cumulativeMeasuredMicros: measuredCurrentMicros,
    cumulativeWorstCaseMicros,
  });
  return Object.freeze({
    decision,
    countedInputTokens,
    worstCaseCurrentMicros,
    cumulativeWorstCaseMicros,
    ledger: Object.freeze(ledger),
  });
}

function decodeLedgerBytes(
  event: Record<string, any>,
  code:
    | "COUNT_TOKENS_RESPONSE_BINDING_INVALID"
    | "GENERATION_RESPONSE_BINDING_INVALID",
): Buffer {
  if (
    typeof event.responseBytesBase64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      event.responseBytesBase64,
    )
  )
    throw new Error(code);
  const bytes = Buffer.from(event.responseBytesBase64, "base64");
  if (
    bytes.length !== event.responseByteLength ||
    attemptSha256(bytes) !== event.responseSha256
  )
    throw new Error(code);
  return bytes;
}

export function verifyAttemptLedger(input: unknown): true {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !Array.isArray((input as Record<string, unknown>).ledger)
  )
    throw new Error("ATTEMPT_LEDGER_SCHEMA_INVALID");
  const envelope = input as Record<string, any>;
  const ledger = envelope.ledger as Array<Record<string, any>>;
  if (
    typeof envelope.runId !== "string" ||
    envelope.runId.length === 0 ||
    envelope.runAttempt !== 1 ||
    ledger.some((event, index) => event.sequence !== index + 1) ||
    ledger.some(
      (event) => event.runId !== envelope.runId || event.runAttempt !== 1,
    )
  )
    throw new Error("ATTEMPT_LEDGER_ORDER_INVALID");
  let offset = 0;
  let priorWorstCase = 0;
  let priorMeasured = 0;
  const caseIds: string[] = [];
  const requestIds = new Set<string>();
  const fallbackPlanSha256 = ledger[0]?.requestPlanSha256;
  const planBindings =
    envelope.requestPlanSha256ByCase &&
    typeof envelope.requestPlanSha256ByCase === "object"
      ? envelope.requestPlanSha256ByCase
      : null;
  while (offset < ledger.length) {
    const first = ledger[offset]!;
    const caseId = first.caseId;
    caseIds.push(caseId);
    const events: Array<Record<string, any>> = [];
    while (offset < ledger.length && ledger[offset]!.caseId === caseId)
      events.push(ledger[offset++]!);
    const kinds = events.map(({ kind }) => kind);
    if (
      kinds[0] !== "COUNT_TOKENS_REQUEST" ||
      kinds[1] !== "COUNT_TOKENS_RESPONSE" ||
      kinds[2] !== "ADMISSION_DECISION"
    )
      throw new Error("ATTEMPT_LEDGER_ORDER_INVALID");
    const admission = events[2]!;
    if (
      admission.decision === "CAPTURE_SPEND_LIMIT" &&
      events.some(({ kind }) => kind.startsWith("GENERATION_"))
    )
      throw new Error("GENERATION_AFTER_REJECTION");
    const expectedKinds =
      admission.decision === "ADMITTED"
        ? [
            "COUNT_TOKENS_REQUEST",
            "COUNT_TOKENS_RESPONSE",
            "ADMISSION_DECISION",
            "GENERATION_REQUEST",
            "GENERATION_RESPONSE",
            "SPEND_RECONCILED",
          ]
        : [
            "COUNT_TOKENS_REQUEST",
            "COUNT_TOKENS_RESPONSE",
            "ADMISSION_DECISION",
          ];
    if (JSON.stringify(kinds) !== JSON.stringify(expectedKinds))
      throw new Error("ATTEMPT_LEDGER_ORDER_INVALID");
    const requestId = first.requestId;
    const expectedPlan = planBindings?.[caseId] ?? fallbackPlanSha256;
    if (
      typeof requestId !== "string" ||
      requestIds.has(requestId) ||
      typeof expectedPlan !== "string" ||
      events.some(
        (event) =>
          event.caseId !== caseId ||
          event.requestId !== requestId ||
          event.requestPlanSha256 !== expectedPlan,
      )
    )
      throw new Error("ATTEMPT_LEDGER_REQUEST_BINDING_INVALID");
    requestIds.add(requestId);
    const count = events[1]!;
    const countBytes = decodeLedgerBytes(
      count,
      "COUNT_TOKENS_RESPONSE_BINDING_INVALID",
    );
    const parsed = parsedCountTokens(countBytes);
    if (
      count.parsedInputTokens !== parsed ||
      admission.countedInputTokens !== parsed ||
      admission.countTokensResponseSha256 !== count.responseSha256
    )
      throw new Error("COUNT_TOKENS_RESPONSE_BINDING_INVALID");
    if (
      admission.reservedOutputTokens !== 8192 ||
      admission.inputMicrosPerMillionTokens !== 300_000 ||
      admission.outputMicrosPerMillionTokens !== 2_500_000 ||
      admission.hardLimitMicros !== 500_000
    )
      throw new Error("ATTEMPT_LEDGER_PRICING_INVALID");
    if (admission.spentKnownBeforeMicros !== priorWorstCase)
      throw new Error("CUMULATIVE_SPEND_MISMATCH");
    const expectedWorst = pricedMicros(
      parsed,
      admission.reservedOutputTokens,
      admission.inputMicrosPerMillionTokens,
      admission.outputMicrosPerMillionTokens,
    );
    if (
      admission.worstCaseCurrentMicros !== expectedWorst ||
      admission.cumulativeWorstCaseMicros !==
        admission.spentKnownBeforeMicros + expectedWorst
    )
      throw new Error("CUMULATIVE_SPEND_MISMATCH");
    if (admission.decision === "ADMITTED") {
      const generation = events[4]!;
      const generationBytes = decodeLedgerBytes(
        generation,
        "GENERATION_RESPONSE_BINDING_INVALID",
      );
      const measured = measuredGenerationCost(
        generationBytes,
        admission.inputMicrosPerMillionTokens,
        admission.outputMicrosPerMillionTokens,
      );
      const reconciled = events[5]!;
      if (reconciled.measuredCurrentMicros !== measured)
        throw new Error("MEASURED_SPEND_RECONCILIATION_INVALID");
      priorMeasured += measured;
      if (reconciled.cumulativeMeasuredMicros !== priorMeasured)
        throw new Error("CUMULATIVE_MEASURED_SPEND_INVALID");
      if (
        reconciled.cumulativeWorstCaseMicros !==
        admission.cumulativeWorstCaseMicros
      )
        throw new Error("CUMULATIVE_SPEND_MISMATCH");
    }
    priorWorstCase = admission.cumulativeWorstCaseMicros;
  }
  if (
    caseIds.length !== LIVE_CAPTURE_CASE_IDS.length ||
    caseIds.some((caseId, index) => caseId !== LIVE_CAPTURE_CASE_IDS[index])
  )
    throw new Error("ATTEMPT_LEDGER_IDENTITIES_INVALID");
  return true;
}
