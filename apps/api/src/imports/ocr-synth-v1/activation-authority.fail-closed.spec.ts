import {
  buildOraclePredictions,
  buildOracleRoutingCases,
  buildOracleSafetyProbes,
  DIRECT_PDF_VERTEX_CONFIG,
  evaluateOcrSynth,
  type OcrEvalInput,
} from "./evaluator";
import { OCR_SYNTH_DATASET } from "./corpus";
import { parseLiveEvidence } from "./live-evidence-parser";
import policy from "./quality-closure-policy.json";

const functionalEvidence = async (): Promise<OcrEvalInput> => ({
  datasetVersion: OCR_SYNTH_DATASET.datasetVersion,
  run: {
    mode: "LIVE_CAPTURE",
    candidateSha: "b".repeat(40),
    configurationSha256: "c".repeat(64),
    adapterSha256: "d".repeat(64),
    provider: DIRECT_PDF_VERTEX_CONFIG.provider,
    model: DIRECT_PDF_VERTEX_CONFIG.model,
    modelVersion: "gemini-2.5-flash-baseline-missing",
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
      policySha256: "e".repeat(64),
      tenantLimitMicros: 500_000,
      globalLimitMicros: 500_000,
      storage: "DATABASE",
    },
    residualRiskAcceptance: {
      decision: "OPTION_1_COMPLETE_ORIGINAL_PDF",
      dataOwnerAcceptanceSha256: "f".repeat(64),
      noLocalDerivative: true,
    },
    finalReviews: {
      securityReviewSha256: "1".repeat(64),
      privacyReviewSha256: "2".repeat(64),
      dataOwnerReviewSha256: "3".repeat(64),
    },
    pricing: {
      source: "test-pinned",
      effectiveDate: "2026-10-14",
      inputMicrosPerMillionTokens: 300_000,
      outputMicrosPerMillionTokens: 2_500_000,
    },
  },
  predictions: await buildOraclePredictions(true),
  routingCases: await buildOracleRoutingCases(),
  safetyProbes: buildOracleSafetyProbes(),
});

const parseableEvidence = async (): Promise<OcrEvalInput> => {
  const value = await functionalEvidence();
  for (const prediction of value.predictions) {
    if (
      prediction.outcome.kind === "SUCCESS" &&
      "regions" in prediction.outcome
    ) {
      const occurrences = new Map<number, number>();
      prediction.outcome = {
        kind: "SUCCESS",
        candidates: prediction.outcome.regions
          .flatMap((region) => region.rows)
          .sort(
            (left, right) => left.page - right.page || left.order - right.order,
          )
          .map((row) => {
            const pageOccurrenceIndex = (occurrences.get(row.page) ?? 0) + 1;
            occurrences.set(row.page, pageOccurrenceIndex);
            return {
              pageNumber: row.page,
              pageOccurrenceIndex,
              description: row.description,
              amountCents: row.amountCents,
              sign: row.sign,
              amountMeaning: row.amountMeaning,
              dateText: row.dateText,
              normalizedDate: row.normalizedDate,
              dateExplicitness: row.dateExplicitness,
              installment:
                row.installmentCurrent !== null && row.installmentTotal !== null
                  ? {
                      index: row.installmentCurrent,
                      total: row.installmentTotal,
                    }
                  : null,
              evidenceText: row.evidenceText,
              selected: false,
              verificationStatus: "UNVERIFIED",
              candidateDisposition: "RAW_UNCLASSIFIED",
            };
          }),
      };
    }
    prediction.modelVersion = value.run.modelVersion;
  }
  const sourceByName = new Map(
    policy.qualificationTests.map((item) => [item.name, item.sourcePath]),
  );
  for (const route of value.routingCases) {
    route.source = "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED";
    route.testFile = sourceByName.get(`[ROUTE] ${route.caseId}`)!;
  }
  for (const probe of value.safetyProbes) {
    probe.source = "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED";
    probe.testFile = sourceByName.get(`[PROBE] ${probe.id}`)!;
  }
  return value;
};

describe("Band-3 activation authority remains fail closed", () => {
  it("[B3] pilot qualification declares historical comparison deferred without inventing a baseline", async () => {
    const report = await evaluateOcrSynth(await functionalEvidence());

    expect(report.functionalStatus).toBe("PASS");
    expect(report.historicalComparison).toBe("NOT_PERFORMED_P1_DEFERRED");
    expect(report.liveEvidenceGaps).not.toContain(
      "VERIFIED_BASELINE_EXECUTION_MISSING",
    );
    expect(report.baseline.behavior).toBe("OCR_REQUIRED");
  });

  it("[B3] marker strings, exact lengths, caller totals, and arbitrary observations grant no authority", async () => {
    const valid = await parseableEvidence();
    expect(parseLiveEvidence(valid)).toEqual(valid);
    const evidence = {
      ...valid,
      baselineMarker: "VERIFIED_BASELINE_ARTIFACT_V4",
      candidateMarker: "VERIFIED_CANDIDATE_ARTIFACT_V4",
      baselineRecords: Array.from({ length: 18 }, (_, index) => ({
        caseId: `scan-${String(index + 1).padStart(3, "0")}`,
      })),
      rawResponses: Array.from({ length: 18 }, () => ({})),
      attemptLedger: [{}],
      boundaryObservations: Array.from({ length: 45 }, () => ({})),
      callerTotals: { requestCount: 18, responseCount: 18 },
    };

    expect(() => parseLiveEvidence(evidence)).toThrow("LIVE_EVIDENCE_INVALID");
  });

  it("[B3] caller-owned ZIP identity and metadata are unreachable from the live qualifier", async () => {
    const valid = await parseableEvidence();
    expect(parseLiveEvidence(valid)).toEqual(valid);
    const evidence = {
      ...valid,
      baselineArchiveBytes: Buffer.from("PK\u0003\u0004caller-owned"),
      expectedArchiveIdentity: "caller-supplied",
      githubMetadata: { sha: "a".repeat(40), workflow: "caller-supplied" },
    };

    expect(() => parseLiveEvidence(evidence)).toThrow("LIVE_EVIDENCE_INVALID");
  });
});
