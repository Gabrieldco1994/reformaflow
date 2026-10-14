import { extractPdfDocument } from "../../credit-card/parsers/pdf-document";
import { OCR_SYNTH_DATASET, OCR_SYNTH_ROUTING_CASES } from "./corpus";
import {
  DIRECT_PDF_VERTEX_CONFIG,
  buildOraclePredictions,
  buildOracleRoutingCases,
  buildOracleSafetyProbes,
  evaluateOcrSynth,
  type OcrEvalInput,
  type OcrEvalReport,
} from "./evaluator";
import { artifactSha256, generateArtifact } from "./fixture-generator";
import {
  QUALIFICATION_PROBE_IDS,
  QUALIFICATION_ROUTE_IDS,
} from "./quality-closure-test-contract";
import { SAFETY_PROBE_IDS, type SafetyProbeId } from "./types";

jest.setTimeout(120_000);

let report: OcrEvalReport;
let qualificationInput: OcrEvalInput;
let fetchSpy: jest.SpyInstance;

beforeAll(async () => {
  expect(OCR_SYNTH_ROUTING_CASES.map((item) => item.id)).toEqual(
    QUALIFICATION_ROUTE_IDS,
  );
  expect(SAFETY_PROBE_IDS).toEqual(QUALIFICATION_PROBE_IDS);
  const predictions = await buildOraclePredictions(true);
  const routingCases = await buildOracleRoutingCases();
  const safetyProbes = buildOracleSafetyProbes();
  qualificationInput = {
    datasetVersion: OCR_SYNTH_DATASET.datasetVersion,
    run: {
      mode: "LIVE_CAPTURE",
      candidateSha: "a".repeat(40),
      configurationSha256: "b".repeat(64),
      adapterSha256: "c".repeat(64),
      provider: DIRECT_PDF_VERTEX_CONFIG.provider,
      model: DIRECT_PDF_VERTEX_CONFIG.model,
      modelVersion: "qualification-self-test",
      region: DIRECT_PDF_VERTEX_CONFIG.region,
      endpoint: DIRECT_PDF_VERTEX_CONFIG.endpoint,
      promptSha256: "a".repeat(64),
      baseline: {
        sha: OCR_SYNTH_DATASET.baseSha,
        behavior: "OCR_REQUIRED",
        sampleCount: 18,
      },
      declaredLimits: {
        maxP95LatencyMs: 30_000,
        maxTotalCostMicros: 500_000,
        maxRequestBodyBytes: 20_000_000,
        maxProviderDeadlineMs: 60_000,
      },
      durableBudgets: {
        policySha256: "d".repeat(64),
        tenantLimitMicros: 500_000,
        globalLimitMicros: 500_000,
        storage: "DATABASE",
      },
      residualRiskAcceptance: {
        decision: "OPTION_1_COMPLETE_ORIGINAL_PDF",
        dataOwnerAcceptanceSha256: "e".repeat(64),
        noLocalDerivative: true,
      },
      finalReviews: {
        securityReviewSha256: "1".repeat(64),
        privacyReviewSha256: "2".repeat(64),
        dataOwnerReviewSha256: "3".repeat(64),
      },
      pricing: {
        source: "https://cloud.google.com/vertex-ai/generative-ai/pricing",
        effectiveDate: "2026-10-14",
        inputMicrosPerMillionTokens: 300_000,
        outputMicrosPerMillionTokens: 2_500_000,
      },
    },
    predictions,
    routingCases,
    safetyProbes,
  };
  report = await evaluateOcrSynth(qualificationInput);
});

beforeEach(() => {
  fetchSpy = jest
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("QUALIFICATION_NETWORK_DENIED"));
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

test.each(QUALIFICATION_ROUTE_IDS)("[ROUTE] %s", async (caseId) => {
  const testCase = OCR_SYNTH_ROUTING_CASES.find((item) => item.id === caseId);
  expect(testCase).toBeDefined();
  if (!testCase) throw new Error("QUALIFICATION_ROUTE_MISSING");
  const bytes = await generateArtifact(testCase);
  const localResult = await extractPdfDocument(bytes).catch((error: unknown) =>
    error instanceof Error ? error : new Error("LOCAL_ROUTE_FAILED"),
  );

  expect(artifactSha256(bytes)).toHaveLength(64);
  expect(localResult).toBeDefined();
  expect(
    report.routingCases.find((item) => item.caseId === caseId),
  ).toMatchObject({
    caseId,
    pass: true,
    issues: [],
  });
});

test.each(QUALIFICATION_PROBE_IDS)("[PROBE] %s", async (id: SafetyProbeId) => {
  const result = report.safetyProbes.find((item) => item.id === id);
  expect(result).toEqual({
    id,
    pass: true,
    issues: [],
  });
  const mutation = structuredClone(qualificationInput);
  const mutatedProbe = mutation.safetyProbes.find((item) => item.id === id);
  expect(mutatedProbe).toBeDefined();
  if (!mutatedProbe) throw new Error("QUALIFICATION_PROBE_MISSING");
  mutatedProbe.blocked = false;
  mutatedProbe.explicitError = false;
  mutatedProbe.financialWrites = 1;
  const mutatedResult = (await evaluateOcrSynth(mutation)).safetyProbes.find(
    (item) => item.id === id,
  );
  expect(mutatedResult).toEqual({
    id,
    pass: false,
    issues: expect.arrayContaining([
      "MUTATION_NOT_BLOCKED",
      "SUCCESS_SHAPED_OR_HIDDEN_ERROR",
      "FINANCIAL_WRITE",
    ]),
  });
});
