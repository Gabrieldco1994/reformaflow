import { OCR_SYNTH_DATASET, getOcrSynthCase, successfulRows } from "./corpus";
import {
  assertReleaseQualified,
  buildOraclePredictions,
  evaluateOcrSynth,
  type OcrEvalInput,
  type OcrEvalRunConfig,
} from "./evaluator";
import { extractPdfDocument } from "../../credit-card/parsers/pdf-document";
import { artifactSha256, generateArtifact } from "./fixture-generator";
import type { OcrEvalPrediction } from "./types";

jest.setTimeout(120_000);

function offlineRun(): OcrEvalRunConfig {
  return {
    mode: "OFFLINE_ORACLE",
    candidateSha: null,
    configurationSha256: null,
    provider: null,
    model: null,
    modelVersion: null,
    promptSha256: null,
    baseline: {
      sha: "dea9300360418ceb04e8ffc06a3285b83201a69d",
      behavior: "OCR_REQUIRED",
      sampleCount: 28,
    },
    declaredLimits: { maxP95LatencyMs: null, maxTotalCostMicros: null },
  };
}

function liveTestRun(): OcrEvalRunConfig {
  return {
    ...offlineRun(),
    mode: "LIVE_CAPTURE",
    candidateSha: "b".repeat(40),
    configurationSha256: "c".repeat(64),
    provider: "synthetic-provider-for-evaluator-test",
    model: "synthetic-model-for-evaluator-test",
    modelVersion: "fixture-version",
    promptSha256: "a".repeat(64),
    declaredLimits: { maxP95LatencyMs: 100, maxTotalCostMicros: 1_000 },
  };
}

function input(
  predictions: OcrEvalPrediction[],
  run: OcrEvalRunConfig = offlineRun(),
): OcrEvalInput {
  return {
    datasetVersion: OCR_SYNTH_DATASET.datasetVersion,
    run,
    predictions,
  };
}

function clone(predictions: OcrEvalPrediction[]): OcrEvalPrediction[] {
  return structuredClone(predictions);
}

type SuccessfulPrediction = OcrEvalPrediction & {
  outcome: Extract<OcrEvalPrediction["outcome"], { kind: "SUCCESS" }>;
};

function successPrediction(
  predictions: OcrEvalPrediction[],
  caseId: string,
): SuccessfulPrediction {
  const prediction = predictions.find((item) => item.caseId === caseId);
  if (!prediction || prediction.outcome.kind !== "SUCCESS")
    throw new Error(`Missing successful prediction ${caseId}`);
  return prediction as SuccessfulPrediction;
}

describe("ocr-synth-v1 corpus integrity (CI-fast, offline)", () => {
  it("pins exactly 52 cases and the approved partition counts", () => {
    expect(OCR_SYNTH_DATASET.baseSha).toBe(
      "dea9300360418ceb04e8ffc06a3285b83201a69d",
    );
    expect(OCR_SYNTH_DATASET.cases).toHaveLength(52);
    const counts = Object.fromEntries(
      [
        "SCANNED_PDF",
        "MIXED_PDF",
        "IMAGE",
        "INVALID_ADMISSION",
        "PROVIDER_TENANT_ADVERSARIAL",
      ].map((partition) => [
        partition,
        OCR_SYNTH_DATASET.cases.filter((item) => item.partition === partition)
          .length,
      ]),
    );
    expect(counts).toEqual({
      SCANNED_PDF: 18,
      MIXED_PDF: 10,
      IMAGE: 12,
      INVALID_ADMISSION: 6,
      PROVIDER_TENANT_ADVERSARIAL: 6,
    });
    expect(counts.SCANNED_PDF + counts.MIXED_PDF).toBe(28);
    expect(
      OCR_SYNTH_DATASET.cases
        .filter((item) => item.partition === "IMAGE")
        .reduce<Record<string, number>>((accumulator, item) => {
          accumulator[item.artifact.kind] =
            (accumulator[item.artifact.kind] ?? 0) + 1;
          return accumulator;
        }, {}),
    ).toEqual({ PNG: 4, JPEG: 4, WEBP: 4 });
  });

  it("contains every required boundary without real brands, Faker, or clock input", () => {
    const serialized = JSON.stringify(OCR_SYNTH_DATASET);
    for (const forbidden of [
      "nubank",
      "itaú",
      "itau",
      "samsung",
      "uber",
      "mercadolivre",
      "faker",
    ])
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    const tags = new Set(OCR_SYNTH_DATASET.cases.flatMap((item) => item.tags));
    for (const required of [
      "page-count",
      "rotation",
      "blur",
      "contrast",
      "noise",
      "compression",
      "thousands-decimal",
      "signed-value",
      "zero-value",
      "leap-date",
      "yearless-date",
      "installment-1-of-1",
      "installment-1-of-24",
      "installment-24-of-24",
      "page-marker-1-of-24",
      "page-marker-24-of-24",
      "decorative-raster-logo",
      "prompt-injection",
      "blank-page",
      "unreadable-page",
      "malformed-provider-envelope",
      "identical-bytes",
      "timeout",
      "truncation",
    ])
      expect(tags).toContain(required);
    const rows = OCR_SYNTH_DATASET.cases.flatMap(successfulRows);
    expect(rows.some((row) => row.amountCents === "0")).toBe(true);
    expect(rows.some((row) => row.amountCents.startsWith("-"))).toBe(true);
    expect(rows.some((row) => row.normalizedDate === "2024-02-29")).toBe(true);
    expect(rows.some((row) => row.dateExplicitness === "YEARLESS")).toBe(true);
    expect(rows.some((row) => row.dateExplicitness === "MISSING")).toBe(true);
  });

  it("generates valid signatures at runtime without checked-in binary fixtures", async () => {
    const representatives = [
      "scan-001",
      "mixed-001",
      "image-png-001",
      "image-jpeg-001",
      "image-webp-001",
      "invalid-unsupported-gif",
    ];
    for (const caseId of representatives) {
      const testCase = getOcrSynthCase(caseId);
      const first = await generateArtifact(testCase);
      const second = await generateArtifact(testCase);
      expect(first).toEqual(second);
      expect(first.length).toBeGreaterThan(7);
    }
    expect(
      (await generateArtifact(getOcrSynthCase("scan-001")))
        .subarray(0, 4)
        .toString(),
    ).toBe("%PDF");
    expect(
      (await generateArtifact(getOcrSynthCase("image-png-001"))).subarray(0, 8),
    ).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(
      (await generateArtifact(getOcrSynthCase("image-jpeg-001"))).subarray(
        0,
        3,
      ),
    ).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(
      (await generateArtifact(getOcrSynthCase("image-webp-001")))
        .subarray(8, 12)
        .toString(),
    ).toBe("WEBP");
  });

  it("generates all artifacts offline and keeps tenant twin bytes identical", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => {
      throw new Error("provider calls are forbidden in ocr-synth-v1 CI");
    }) as typeof fetch;
    try {
      const artifacts: Buffer[] = [];
      for (const testCase of OCR_SYNTH_DATASET.cases)
        artifacts.push(await generateArtifact(testCase));
      expect(artifacts).toHaveLength(52);
      expect(artifacts.every((bytes) => bytes.length > 0)).toBe(true);
      const twinA =
        artifacts[
          OCR_SYNTH_DATASET.cases.findIndex(
            (item) => item.id === "tenant-identical-bytes-a",
          )
        ];
      const twinB =
        artifacts[
          OCR_SYNTH_DATASET.cases.findIndex(
            (item) => item.id === "tenant-identical-bytes-b",
          )
        ];
      expect(twinA).toEqual(twinB);
      expect(artifactSha256(twinA)).toBe(artifactSha256(twinB));
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("pins the 28-PDF baseline to explicit OCR_REQUIRED fallback", async () => {
    const pdfSlice = OCR_SYNTH_DATASET.cases.filter(
      (item) =>
        item.partition === "SCANNED_PDF" || item.partition === "MIXED_PDF",
    );
    expect(pdfSlice).toHaveLength(28);
    for (const testCase of pdfSlice) {
      const bytes = await generateArtifact(testCase);
      await expect(extractPdfDocument(bytes)).rejects.toMatchObject({
        code: "OCR_REQUIRED",
      });
    }
  });

  it("uses typed negative failures instead of success-shaped empty data", () => {
    const negatives = OCR_SYNTH_DATASET.cases.filter(
      (item) =>
        item.partition === "INVALID_ADMISSION" ||
        item.tags.includes("provider-failure"),
    );
    expect(negatives).toHaveLength(10);
    for (const testCase of negatives) {
      expect(testCase.expected.kind).toBe("ERROR");
      if (testCase.expected.kind === "ERROR")
        expect(testCase.expected.errorCode).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });
});

describe("ocr-synth-v1 evaluator and release-only evidence gate", () => {
  let oracle: OcrEvalPrediction[];
  let liveOracle: OcrEvalPrediction[];

  beforeAll(async () => {
    oracle = await buildOraclePredictions();
    liveOracle = await buildOraclePredictions(true);
  });

  it("passes exact offline rubric but remains GAPS without live provider evidence", async () => {
    const report = await evaluateOcrSynth(input(oracle));
    expect(report.functionalStatus).toBe("PASS");
    expect(report.releaseStatus).toBe("GAPS");
    expect(report.datasetSampleCount).toBe(52);
    expect(report.pdfSliceSampleCount).toBe(28);
    expect(report.metrics).toMatchObject({
      taskSuccessRate: 1,
      exactMoneyRate: 1,
      exactSignRate: 1,
      exactDateRate: 1,
      exactDateExplicitnessRate: 1,
      exactInstallmentRate: 1,
      inventedRows: 0,
      omittedRows: 0,
      tenantLeaks: 0,
    });
    expect(report.metrics.p95LatencyMs).toBeNull();
    expect(report.metrics.peakRssBytes).toBeNull();
    expect(report.metrics.inputTokens).toBeNull();
    expect(report.metrics.totalCostMicros).toBeNull();
    expect(() => assertReleaseQualified(report)).toThrow(
      /LIVE_PROVIDER_RUN_NOT_SUPPLIED/,
    );
  });

  it("accepts a complete schema-shaped qualification fixture in evaluator self-test only", async () => {
    const report = await evaluateOcrSynth(input(liveOracle, liveTestRun()));
    expect(report.releaseStatus).toBe("PASS");
    expect(() => assertReleaseQualified(report)).not.toThrow();
  });

  it.each([
    [
      "invented row",
      (items: OcrEvalPrediction[]) => {
        const prediction = successPrediction(items, "scan-001");
        const source = prediction.outcome.regions[0].rows[0];
        prediction.outcome.regions[0].rows.push({
          ...source,
          rowId: "invented-row",
          order: 99,
        });
      },
      "INVENTED_ROW",
    ],
    [
      "omitted row",
      (items: OcrEvalPrediction[]) => {
        successPrediction(items, "scan-001").outcome.regions[0].rows.splice(
          0,
          1,
        );
      },
      "OMITTED_ROW",
    ],
    [
      "sign error",
      (items: OcrEvalPrediction[]) => {
        successPrediction(items, "scan-003").outcome.regions[0].rows[0].sign =
          "POSITIVE";
      },
      "SIGN_MISMATCH",
    ],
    [
      "date error",
      (items: OcrEvalPrediction[]) => {
        successPrediction(
          items,
          "scan-005",
        ).outcome.regions[0].rows[0].normalizedDate = "2024-03-01";
      },
      "DATE_MISMATCH",
    ],
    [
      "installment error",
      (items: OcrEvalPrediction[]) => {
        successPrediction(
          items,
          "scan-009",
        ).outcome.regions[0].rows[0].installmentCurrent = 2;
      },
      "INSTALLMENT_MISMATCH",
    ],
    [
      "reordered region",
      (items: OcrEvalPrediction[]) => {
        successPrediction(items, "mixed-005").outcome.regions.reverse();
      },
      "REGION_ORDER_OR_PROVENANCE_MISMATCH",
    ],
    [
      "missing region",
      (items: OcrEvalPrediction[]) => {
        successPrediction(items, "mixed-005").outcome.regions.splice(1, 1);
      },
      "MISSING_REGION",
    ],
  ])("rejects mutation: %s", async (_label, mutate, expectedIssue) => {
    const mutated = clone(oracle);
    mutate(mutated);
    const report = await evaluateOcrSynth(input(mutated));
    expect(report.functionalStatus).toBe("FAIL");
    expect(report.regressions.flatMap((item) => item.issues)).toContain(
      expectedIssue,
    );
  });

  it("rejects cross-tenant result reuse for identical bytes", async () => {
    const mutated = clone(liveOracle);
    const tenantA = mutated.find(
      (item) => item.caseId === "tenant-identical-bytes-a",
    )!;
    const tenantB = mutated.find(
      (item) => item.caseId === "tenant-identical-bytes-b",
    )!;
    tenantB.requestId = tenantA.requestId;
    const report = await evaluateOcrSynth(input(mutated, liveTestRun()));
    expect(report.functionalStatus).toBe("FAIL");
    expect(report.regressions.flatMap((item) => item.issues)).toContain(
      "CROSS_TENANT_RESULT_REUSE",
    );
    expect(report.metrics.tenantLeaks).toBe(1);
  });

  it("rejects absent cost metadata even when task outputs are exact", async () => {
    const mutated = clone(liveOracle);
    mutated[0].cost.amountMicros = null;
    const report = await evaluateOcrSynth(input(mutated, liveTestRun()));
    expect(report.functionalStatus).toBe("PASS");
    expect(report.releaseStatus).toBe("GAPS");
    expect(report.liveEvidenceGaps).toContain("MISSING_COST_EVIDENCE");
    expect(() => assertReleaseQualified(report)).toThrow(
      /MISSING_COST_EVIDENCE/,
    );
  });
});
