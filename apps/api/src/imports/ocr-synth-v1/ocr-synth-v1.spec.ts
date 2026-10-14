import {
  OCR_SYNTH_DATASET,
  OCR_SYNTH_FUTURE_IMAGE_CASES,
  OCR_SYNTH_ROUTING_CASES,
  OCR_SYNTH_SCANNED_RELEASE_CASES,
  getOcrSynthCase,
  successfulRows,
} from "./corpus";
import {
  DIRECT_PDF_VERTEX_CONFIG,
  assertReleaseQualified,
  buildOraclePredictions,
  buildOracleRoutingCases,
  buildOracleSafetyProbes,
  evaluateOcrSynth,
  type OcrEvalInput,
  type OcrEvalRunConfig,
} from "./evaluator";
import { extractPdfDocument } from "../../credit-card/parsers/pdf-document";
import { artifactSha256, generateArtifact } from "./fixture-generator";
import type {
  OcrEvalExpected,
  OcrEvalPrediction,
  OcrProviderNativeCandidate,
  OcrRoutingEvidence,
} from "./types";
import Ajv2020 from "ajv/dist/2020";
import reportSchema from "./report.schema.json";

jest.setTimeout(120_000);

const BASE_SHA = "08d19d11638a55e14ce73a6bf472894174c66389";

function offlineRun(): OcrEvalRunConfig {
  return {
    mode: "OFFLINE_ORACLE",
    candidateSha: null,
    configurationSha256: null,
    adapterSha256: null,
    provider: null,
    model: null,
    modelVersion: null,
    region: null,
    endpoint: null,
    promptSha256: null,
    baseline: { sha: BASE_SHA, behavior: "OCR_REQUIRED", sampleCount: 18 },
    declaredLimits: {
      maxP95LatencyMs: null,
      maxTotalCostMicros: null,
      maxRequestBodyBytes: null,
      maxProviderDeadlineMs: null,
    },
    durableBudgets: null,
    residualRiskAcceptance: null,
    finalReviews: null,
    pricing: null,
  };
}

function evaluatorFixtureRun(): OcrEvalRunConfig {
  return {
    ...offlineRun(),
    mode: "LIVE_CAPTURE",
    candidateSha: "b".repeat(40),
    configurationSha256: "c".repeat(64),
    adapterSha256: "d".repeat(64),
    provider: DIRECT_PDF_VERTEX_CONFIG.provider,
    model: DIRECT_PDF_VERTEX_CONFIG.model,
    modelVersion: "evaluator-fixture-version",
    region: DIRECT_PDF_VERTEX_CONFIG.region,
    endpoint: DIRECT_PDF_VERTEX_CONFIG.endpoint,
    promptSha256: "a".repeat(64),
    declaredLimits: {
      maxP95LatencyMs: 100,
      maxTotalCostMicros: 1_000,
      maxRequestBodyBytes: 20_000_000,
      maxProviderDeadlineMs: 30_000,
    },
    durableBudgets: {
      policySha256: "e".repeat(64),
      tenantLimitMicros: 10_000,
      globalLimitMicros: 100_000,
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
      source: "evaluator-self-test-only",
      effectiveDate: "2026-10-13",
      inputMicrosPerMillionTokens: 1_000_000,
      outputMicrosPerMillionTokens: 1_000_000,
    },
  };
}

function input(
  predictions: OcrEvalPrediction[],
  routingCases: OcrRoutingEvidence[],
  run: OcrEvalRunConfig = offlineRun(),
): OcrEvalInput {
  return {
    datasetVersion: OCR_SYNTH_DATASET.datasetVersion,
    run,
    predictions,
    routingCases,
    safetyProbes: buildOracleSafetyProbes(),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function successful(items: OcrEvalPrediction[], caseId: string) {
  const item = items.find((prediction) => prediction.caseId === caseId);
  if (!item || item.outcome.kind !== "SUCCESS")
    throw new Error(`Missing success ${caseId}`);
  return item as OcrEvalPrediction & {
    outcome: Extract<OcrEvalExpected, { kind: "SUCCESS" }>;
  };
}

describe("ocr-synth-v1 scanned-only release corpus (offline)", () => {
  it("pins 18 image-only PDFs for quality, 10 mixed routes for safety, and 12 future images", () => {
    expect(OCR_SYNTH_DATASET.datasetVersion).toBe(
      "ocr-synth-v1-direct-pdf-vertex-v3",
    );
    expect(OCR_SYNTH_DATASET.schemaVersion).toBe(4);
    expect(OCR_SYNTH_DATASET.baseSha).toBe(BASE_SHA);
    expect(OCR_SYNTH_DATASET.cases).toHaveLength(52);
    expect(OCR_SYNTH_SCANNED_RELEASE_CASES).toHaveLength(18);
    expect(OCR_SYNTH_ROUTING_CASES).toHaveLength(10);
    expect(OCR_SYNTH_FUTURE_IMAGE_CASES).toHaveLength(12);
    expect(
      [
        ...new Set(
          OCR_SYNTH_SCANNED_RELEASE_CASES.map(
            (item) => item.artifact.pageCount,
          ),
        ),
      ].sort((left, right) => left - right),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(OCR_SYNTH_DATASET.limits.maxPages).toBe(10);
    expect(getOcrSynthCase("scan-018").artifact.pageCount).toBe(10);
    expect(getOcrSynthCase("invalid-page-limit").artifact.pageCount).toBe(11);
    expect(
      OCR_SYNTH_SCANNED_RELEASE_CASES.every(
        (item) =>
          item.artifact.kind === "PDF_SCAN" &&
          item.tags.includes("image-only-pdf"),
      ),
    ).toBe(true);
  });

  function nativeCandidates(caseId: string): OcrProviderNativeCandidate[] {
    const occurrences = new Map<number, number>();
    return successfulRows(getOcrSynthCase(caseId)).map((row) => {
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
            ? { index: row.installmentCurrent, total: row.installmentTotal }
            : null,
        evidenceText: row.evidenceText,
        selected: false,
        verificationStatus: "UNVERIFIED",
        candidateDisposition: "RAW_UNCLASSIFIED",
      };
    });
  }

  async function nativeCaseInput(
    caseId: string,
    mutate?: (candidates: OcrProviderNativeCandidate[]) => void,
  ): Promise<{
    input: OcrEvalInput;
    candidates: OcrProviderNativeCandidate[];
  }> {
    const predictions = await buildOraclePredictions();
    const prediction = predictions.find((item) => item.caseId === caseId);
    if (!prediction) throw new Error(`missing prediction ${caseId}`);
    const candidates = nativeCandidates(caseId);
    mutate?.(candidates);
    prediction.outcome = { kind: "SUCCESS", candidates };
    return {
      input: input(predictions, await buildOracleRoutingCases()),
      candidates,
    };
  }

  describe("Band-3 provider-native factual coordinates", () => {
    it("[B3] scores scan-010 with one-based indexes reset per page", async () => {
      const arranged = await nativeCaseInput("scan-010");
      const original = structuredClone(arranged.candidates);

      const report = await evaluateOcrSynth(arranged.input);
      const dense = report.perCase.find((item) => item.caseId === "scan-010");

      expect(
        arranged.candidates
          .filter((candidate) => candidate.pageNumber === 1)
          .map((candidate) => candidate.pageOccurrenceIndex),
      ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
      expect(
        arranged.candidates
          .filter((candidate) => candidate.pageNumber === 10)
          .map((candidate) => candidate.pageOccurrenceIndex),
      ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
      expect(arranged.candidates).toEqual(original);
      expect(arranged.candidates).toHaveLength(24);
      expect(dense).toEqual({ caseId: "scan-010", pass: true, issues: [] });
      expect(report.metrics).toMatchObject({
        exactMoneyRate: 1,
        exactSignRate: 1,
        exactDateRate: 1,
        exactDateExplicitnessRate: 1,
        exactInstallmentRate: 1,
        visibleEvidenceRate: 1,
        inventedRows: 0,
        omittedRows: 0,
      });
    });

    it.each([
      [
        "zero",
        (candidates: OcrProviderNativeCandidate[]) => {
          candidates[0]!.pageOccurrenceIndex = 0;
        },
      ],
      [
        "global index carried onto page 10",
        (candidates: OcrProviderNativeCandidate[]) => {
          candidates.find(
            (item) => item.pageNumber === 10,
          )!.pageOccurrenceIndex = 13;
        },
      ],
      [
        "duplicate",
        (candidates: OcrProviderNativeCandidate[]) => {
          candidates[1]!.pageOccurrenceIndex = 1;
        },
      ],
      [
        "gap",
        (candidates: OcrProviderNativeCandidate[]) => {
          candidates[1]!.pageOccurrenceIndex = 3;
        },
      ],
      [
        "decreasing",
        (candidates: OcrProviderNativeCandidate[]) => {
          candidates[0]!.pageOccurrenceIndex = 2;
          candidates[1]!.pageOccurrenceIndex = 1;
        },
      ],
    ] as const)(
      "[B3] rejects %s per-page occurrence coordinates",
      async (_label, mutate) => {
        const arranged = await nativeCaseInput("scan-010", mutate);

        const report = await evaluateOcrSynth(arranged.input);
        const dense = report.perCase.find(
          (item) => item.caseId === "scan-010",
        )!;

        expect(dense.pass).toBe(false);
        expect(dense.issues).toEqual(
          expect.arrayContaining([
            expect.stringMatching(
              /^(?:PAGE_OCCURRENCE_INDEX_MISMATCH|ROW_SCHEMA_OR_PROVENANCE_MISMATCH)$/,
            ),
          ]),
        );
      },
    );

    it("[B3] scores installments without provider-only installmentMeaning", async () => {
      const arranged = await nativeCaseInput("scan-009");
      for (const candidate of arranged.candidates)
        expect(candidate).not.toHaveProperty("installmentMeaning");

      const exact = await evaluateOcrSynth(arranged.input);
      expect(exact.perCase.find((item) => item.caseId === "scan-009")).toEqual({
        caseId: "scan-009",
        pass: true,
        issues: [],
      });
      expect(exact.metrics.exactInstallmentRate).toBe(1);

      const invented = await nativeCaseInput("scan-009", (candidates) => {
        const unknown = candidates.find(
          (candidate) => candidate.installment === null,
        );
        if (!unknown) throw new Error("missing UNKNOWN installment fixture");
        unknown.installment = { index: 1, total: 2 };
      });
      const changed = await evaluateOcrSynth(invented.input);
      expect(
        changed.perCase.find((item) => item.caseId === "scan-009")!.issues,
      ).toContain("INSTALLMENT_MEANING_INVENTED");
    });
  });

  it("covers dense, empty, ambiguous, unreadable, raw, duplicate and adversarial statements", () => {
    const tags = new Set(OCR_SYNTH_DATASET.cases.flatMap((item) => item.tags));
    for (const required of [
      "dense-statement",
      "zero-purchases",
      "yearless-date",
      "ambiguous-amount-meaning",
      "ambiguous-installment-meaning",
      "unreadable-fields",
      "raw-credit",
      "raw-payment",
      "raw-fee",
      "duplicate-legitimate-purchases",
      "prompt-injection",
    ])
      expect(tags).toContain(required);

    const zero = getOcrSynthCase("scan-011");
    expect(successfulRows(zero)).toHaveLength(0);
    const unreadable = getOcrSynthCase("scan-012");
    expect(unreadable.expected).toEqual({
      kind: "ERROR",
      errorCode: "DOCUMENT_UNREADABLE",
      retryable: false,
    });
    expect(successfulRows(unreadable)).toEqual([]);
    const ambiguous = successfulRows(getOcrSynthCase("scan-009"))[0]!;
    expect(ambiguous.amountCents).not.toBeNull();
    expect(ambiguous.amountMeaning).toBe("UNKNOWN");
    expect(ambiguous.installmentMeaning).toBe("UNKNOWN");

    for (const caseId of ["scan-013", "scan-014", "scan-015"])
      expect(
        successfulRows(getOcrSynthCase(caseId))[0]!.candidateDisposition,
      ).toBe("RAW_UNCLASSIFIED");
    const duplicates = successfulRows(getOcrSynthCase("scan-016"));
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]!.evidenceText).toBe(duplicates[1]!.evidenceText);
    expect(duplicates[0]!.rowId).not.toBe(duplicates[1]!.rowId);
    const dense = successfulRows(getOcrSynthCase("scan-010"));
    expect(dense).toHaveLength(24);
    expect(dense.map((row) => row.order)).toEqual(
      Array.from({ length: 24 }, (_, index) => index),
    );
    const rawRows = OCR_SYNTH_SCANNED_RELEASE_CASES.flatMap(successfulRows);
    expect(rawRows.some((row) => row.amountCents?.startsWith("-"))).toBe(true);
    expect(
      rawRows.some((row) => row.amountCents === "0" && row.sign === "ZERO"),
    ).toBe(true);
    expect(
      rawRows.some(
        (row) => row.amountCents !== null && row.amountMeaning === "UNKNOWN",
      ),
    ).toBe(true);
  });

  it("requires visible evidence and no prompt financial decisions for every candidate", () => {
    for (const row of OCR_SYNTH_SCANNED_RELEASE_CASES.flatMap(successfulRows)) {
      expect(row.evidenceText.length).toBeGreaterThan(0);
      expect(row.candidateDisposition).toBe("RAW_UNCLASSIFIED");
    }
  });

  it("keeps mixed/searchable/logo/hidden-text documents as zero-provider routing inventory", () => {
    expect(
      OCR_SYNTH_ROUTING_CASES.every(
        (item) =>
          item.tags.includes("routing-safety") &&
          item.tags.includes("zero-provider-call") &&
          item.tags.includes("searchable-pdf"),
      ),
    ).toBe(true);
    expect(
      OCR_SYNTH_ROUTING_CASES.some((item) => item.tags.includes("raster-logo")),
    ).toBe(true);
    expect(
      OCR_SYNTH_ROUTING_CASES.some((item) => item.tags.includes("hidden-text")),
    ).toBe(true);
  });

  it("generates stable PDFs without provider calls", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => {
      throw new Error("provider calls forbidden in ordinary CI");
    }) as typeof fetch;
    try {
      for (const testCase of [
        ...OCR_SYNTH_SCANNED_RELEASE_CASES,
        ...OCR_SYNTH_ROUTING_CASES,
      ]) {
        const first = await generateArtifact(testCase);
        const second = await generateArtifact(testCase);
        expect(first.subarray(0, 4).toString()).toBe("%PDF");
        expect(second).toEqual(first);
        expect(artifactSha256(second)).toBe(artifactSha256(first));
      }
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("pins the scanned baseline through the real local PDF adapter seam", async () => {
    for (const testCase of OCR_SYNTH_SCANNED_RELEASE_CASES)
      await expect(
        extractPdfDocument(await generateArtifact(testCase)),
      ).rejects.toMatchObject({ code: "OCR_REQUIRED" });
  });
});

describe("scanned PDF evaluator and release evidence gate", () => {
  let oracle: OcrEvalPrediction[];
  let evaluatorFixture: OcrEvalPrediction[];
  let routes: OcrRoutingEvidence[];

  beforeAll(async () => {
    oracle = await buildOraclePredictions();
    evaluatorFixture = await buildOraclePredictions(true);
    routes = await buildOracleRoutingCases();
  });

  it("scores only 18 scanned PDFs and remains GAPS without live evidence", async () => {
    const report = await evaluateOcrSynth(input(oracle, routes));
    expect(report.functionalStatus).toBe("PASS");
    expect(report.releaseStatus).toBe("GAPS");
    expect(report.releaseScannedPdfSampleCount).toBe(18);
    expect(report.routingSafetySampleCount).toBe(10);
    expect(report.futureImageSampleCount).toBe(12);
    expect(report.metrics).toMatchObject({
      scannedTaskSuccessRate: 1,
      exactMoneyRate: 1,
      exactSignRate: 1,
      unknownPreservationRate: 1,
      visibleEvidenceRate: 1,
      inventedRows: 0,
      omittedRows: 0,
      tenantLeaks: 0,
      falseAutomations: 0,
      financialWrites: 0,
    });
    expect(report.fallbackSafety.routingProviderCalls).toBe(0);
    expect(report.liveEvidenceGaps).toContain("LIVE_PROVIDER_RUN_NOT_SUPPLIED");
    expect(() => assertReleaseQualified(report)).toThrow(
      /LIVE_PROVIDER_RUN_NOT_SUPPLIED/,
    );
  });

  it("keeps evaluator fixtures non-releasable and emits schema v4", async () => {
    const report = await evaluateOcrSynth(
      input(evaluatorFixture, routes, evaluatorFixtureRun()),
    );
    expect(report.releaseStatus).toBe("GAPS");
    expect(report.liveEvidenceGaps).toEqual(
      expect.arrayContaining([
        "SAFETY_PROBES_NOT_FROM_REAL_SERVICE_SEAM",
        "ROUTING_CASES_NOT_FROM_REAL_SERVICE_SEAM",
      ]),
    );
    const validate = new Ajv2020({ strict: true }).compile(reportSchema);
    expect(validate(report)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it.each([
    [
      "invented row",
      (items: OcrEvalPrediction[]) => {
        const prediction = successful(items, "scan-001");
        prediction.outcome.regions[0]!.rows.push({
          ...prediction.outcome.regions[0]!.rows[0]!,
          rowId: "invented",
        });
      },
      "INVENTED_ROW",
    ],
    [
      "omitted row",
      (items: OcrEvalPrediction[]) => {
        successful(items, "scan-001").outcome.regions[0]!.rows.splice(0, 1);
      },
      "OMITTED_ROW",
    ],
    [
      "out-of-order visible occurrences",
      (items: OcrEvalPrediction[]) => {
        successful(items, "scan-010").outcome.regions[0]!.rows.reverse();
      },
      "ROW_SCHEMA_OR_PROVENANCE_MISMATCH",
    ],
    [
      "dropped legitimate duplicate",
      (items: OcrEvalPrediction[]) => {
        successful(items, "scan-016").outcome.regions[0]!.rows.splice(1, 1);
      },
      "OMITTED_ROW",
    ],
    [
      "wrong readable cents",
      (items: OcrEvalPrediction[]) => {
        successful(items, "scan-001").outcome.regions[0]!.rows[0]!.amountCents =
          "2";
      },
      "MONEY_MISMATCH",
    ],
    [
      "wrong readable sign",
      (items: OcrEvalPrediction[]) => {
        successful(items, "scan-003").outcome.regions[0]!.rows[0]!.sign =
          "POSITIVE";
      },
      "SIGN_MISMATCH",
    ],
    [
      "reverted unreadable terminal to success",
      (items: OcrEvalPrediction[]) => {
        const unreadable = items.find(
          (prediction) => prediction.caseId === "scan-012",
        )!;
        unreadable.outcome = clone(successful(items, "scan-001").outcome);
      },
      "OUTCOME_KIND_MISMATCH",
    ],
    [
      "invented ambiguous meaning",
      (items: OcrEvalPrediction[]) => {
        successful(
          items,
          "scan-009",
        ).outcome.regions[0]!.rows[0]!.amountMeaning = "LINE_AMOUNT";
      },
      "AMOUNT_MEANING_INVENTED",
    ],
    [
      "hidden evidence",
      (items: OcrEvalPrediction[]) => {
        successful(
          items,
          "scan-001",
        ).outcome.regions[0]!.rows[0]!.evidenceText = "";
      },
      "VISIBLE_EVIDENCE_MISMATCH",
    ],
    [
      "prompt financial decision",
      (items: OcrEvalPrediction[]) => {
        const row = successful(items, "scan-013").outcome.regions[0]!.rows[0]!;
        (
          row as unknown as { candidateDisposition: string }
        ).candidateDisposition = "IGNORE_AS_CREDIT";
      },
      "PROMPT_FINANCIAL_DECISION",
    ],
    [
      "wrong explicit date",
      (items: OcrEvalPrediction[]) => {
        successful(
          items,
          "scan-005",
        ).outcome.regions[0]!.rows[0]!.normalizedDate = "2024-03-01";
      },
      "DATE_MISMATCH",
    ],
    [
      "invented year for day/month",
      (items: OcrEvalPrediction[]) => {
        const row = successful(items, "scan-006").outcome.regions[0]!.rows[0]!;
        row.normalizedDate = "2032-02-29";
        row.dateExplicitness = "FULL";
      },
      "DATE_MISMATCH",
    ],
    [
      "wrong installment",
      (items: OcrEvalPrediction[]) => {
        successful(
          items,
          "scan-008",
        ).outcome.regions[0]!.rows[0]!.installmentCurrent = 2;
      },
      "INSTALLMENT_MISMATCH",
    ],
    [
      "selected true",
      (items: OcrEvalPrediction[]) => {
        const row = successful(items, "scan-001").outcome.regions[0]!.rows[0]!;
        (row as unknown as { selected: boolean }).selected = true;
      },
      "UNSAFE_CANDIDATE_DEFAULT",
    ],
  ])("rejects output mutation: %s", async (_label, mutate, issue) => {
    const mutated = clone(evaluatorFixture);
    mutate(mutated);
    const report = await evaluateOcrSynth(
      input(mutated, routes, evaluatorFixtureRun()),
    );
    expect(report.functionalStatus).toBe("FAIL");
    expect(report.regressions.flatMap((item) => item.issues)).toContain(issue);
  });

  it("rejects any provider call for a mixed/searchable routing case", async () => {
    const mutated = clone(routes);
    mutated[0]!.providerCalls = 1;
    const report = await evaluateOcrSynth(input(oracle, mutated));
    expect(report.functionalStatus).toBe("FAIL");
    expect(report.routingCases[0]!.issues).toContain("ROUTING_PROVIDER_CALL");
  });

  it("rejects missing routing evidence instead of shrinking the safety denominator", async () => {
    const report = await evaluateOcrSynth(input(oracle, routes.slice(1)));
    expect(report.functionalStatus).toBe("FAIL");
    expect(report.routingCases[0]!.issues).toContain("MISSING_ROUTING_CASE");
  });

  it("fails closed when measured cost or declared pricing is absent", async () => {
    const mutated = clone(evaluatorFixture);
    mutated[0]!.cost.amountMicros = null;
    const config = evaluatorFixtureRun();
    config.pricing = null;
    const report = await evaluateOcrSynth(input(mutated, routes, config));
    expect(report.liveEvidenceGaps).toEqual(
      expect.arrayContaining([
        "MISSING_COST_EVIDENCE",
        "MISSING_DECLARED_VERTEX_PRICING",
      ]),
    );
    expect(() => assertReleaseQualified(report)).toThrow();
  });
});
