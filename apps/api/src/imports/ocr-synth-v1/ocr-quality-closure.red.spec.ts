import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OCR_SYNTH_DATASET,
  OCR_SYNTH_ROUTING_CASES,
  OCR_SYNTH_SCANNED_RELEASE_CASES,
  getOcrSynthCase,
  successfulRows,
} from "./corpus";
import {
  DIRECT_PDF_VERTEX_CONFIG,
  buildOraclePredictions,
  buildOracleRoutingCases,
  buildOracleSafetyProbes,
  evaluateOcrSynth,
  type OcrEvalInput,
  type OcrEvalRunConfig,
} from "./evaluator";
import {
  parseLiveEvidence,
  parseLiveEvidenceJson,
} from "./live-evidence-parser";
import { providerNativeOutcome } from "./provider-native-outcome";
import policy from "./quality-closure-policy.json";
import { SAFETY_PROBE_IDS } from "./types";

jest.setTimeout(120_000);

const ROOT = resolve(__dirname, "../../../../..");
const POLICY_PATH =
  "apps/api/src/imports/ocr-synth-v1/quality-closure-policy.json";
const CORPUS_PATH = "apps/api/src/imports/ocr-synth-v1/ground-truth.json";
const SERVICE_QUALIFICATION_PATH =
  "apps/api/src/imports/import-session/ocr/pdf-ocr-analyze.integration.spec.ts";
const SAFETY_QUALIFICATION_PATH =
  "apps/api/src/imports/ocr-synth-v1/direct-pdf-vertex-safety.spec.ts";
const SERVICE_PROBE_NAMES = new Set([
  "[PROBE] EXACT_CONSENT_CAPABILITY",
  "[PROBE] SELECTED_TRUE_DEFAULT",
  "[PROBE] VERIFIED_DEFAULT",
  "[PROBE] MISSING_CONSENT",
  "[PROBE] MISSING_ATTESTATION",
  "[PROBE] PRIOR_CONSENT_DECLARATION",
]);
const QUALIFICATION_TEST_NAMES = Object.freeze([
  "[ROUTE] mixed-001",
  "[ROUTE] mixed-002",
  "[ROUTE] mixed-003",
  "[ROUTE] mixed-004",
  "[ROUTE] mixed-005",
  "[ROUTE] mixed-006",
  "[ROUTE] mixed-007",
  "[ROUTE] mixed-008",
  "[ROUTE] mixed-009",
  "[ROUTE] mixed-010",
  "[PROBE] WRONG_ENDPOINT",
  "[PROBE] WRONG_MODEL",
  "[PROBE] WRONG_REGION",
  "[PROBE] API_KEY_AUTH",
  "[PROBE] ADC_SCOPE_BOUNDED",
  "[PROBE] REQUEST_BODY_BOUNDED",
  "[PROBE] DEADLINE_BOUNDED",
  "[PROBE] GLOBAL_ENDPOINT_FALLBACK",
  "[PROBE] TOOLS_PRESENT",
  "[PROBE] FILE_URI_PRESENT",
  "[PROBE] CACHE_PRESENT",
  "[PROBE] TEXTUAL_PDF_PROVIDER_CALL",
  "[PROBE] LOCAL_RASTER_SANDBOX",
  "[PROBE] PAGE_11_ADMISSION",
  "[PROBE] MIXED_LOCAL_PROVIDER_DUPLICATION",
  "[PROBE] PARTIAL_RESPONSE",
  "[PROBE] MALFORMED_RESPONSE",
  "[PROBE] TRUNCATED_RESPONSE",
  "[PROBE] SAFETY_BLOCKED_RESPONSE",
  "[PROBE] AMBIGUOUS_TIMEOUT_RETRY",
  "[PROBE] UNKNOWN_OUTCOME_NO_RETRY",
  "[PROBE] DURABLE_TENANT_BUDGET",
  "[PROBE] DURABLE_GLOBAL_BUDGET",
  "[PROBE] ACTIVE_SESSION_CONTENT_PURGE_AFTER_7_DAYS",
  "[PROBE] EXACT_CONSENT_CAPABILITY",
  "[PROBE] SELECTED_TRUE_DEFAULT",
  "[PROBE] VERIFIED_DEFAULT",
  "[PROBE] MISSING_CONSENT",
  "[PROBE] MISSING_ATTESTATION",
  "[PROBE] FINANCIAL_WRITE",
  "[PROBE] KNOWN_SAFETY_FINISH_REASONS",
  "[PROBE] TERMINAL_FAILURE_REPLAY_NO_CALL",
  "[PROBE] CAPABILITY_OFF",
  "[PROBE] PRIOR_CONSENT_DECLARATION",
  "[PROBE] RESIDUAL_RISK_ACCEPTANCE",
]);
const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const fileSha256 = (path: string) => sha256(readFileSync(resolve(ROOT, path)));

function liveRun(): OcrEvalRunConfig {
  return {
    mode: "LIVE_CAPTURE",
    candidateSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim(),
    configurationSha256: "c".repeat(64),
    adapterSha256: "d".repeat(64),
    provider: DIRECT_PDF_VERTEX_CONFIG.provider,
    model: DIRECT_PDF_VERTEX_CONFIG.model,
    modelVersion: "quality-closure-fixture",
    region: DIRECT_PDF_VERTEX_CONFIG.region,
    endpoint: DIRECT_PDF_VERTEX_CONFIG.endpoint,
    promptSha256: "a".repeat(64),
    baseline: {
      sha: OCR_SYNTH_DATASET.baseSha,
      behavior: "OCR_REQUIRED",
      sampleCount: 18,
    },
    declaredLimits: {
      maxP95LatencyMs: policy.maxP95LatencyMs,
      maxTotalCostMicros: policy.maxTotalCostMicros,
      maxRequestBodyBytes: policy.maxRequestBodyBytes,
      maxProviderDeadlineMs: policy.maxProviderDeadlineMs,
    },
    durableBudgets: {
      policySha256: fileSha256(POLICY_PATH),
      tenantLimitMicros: policy.maxTotalCostMicros,
      globalLimitMicros: policy.maxTotalCostMicros,
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
      source: policy.pricing.source,
      effectiveDate: policy.pricing.observedOn,
      inputMicrosPerMillionTokens: policy.pricing.inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens: policy.pricing.outputMicrosPerMillionTokens,
    },
  };
}

async function liveEvidence(): Promise<OcrEvalInput> {
  const predictions = await buildOraclePredictions(true);
  for (const prediction of predictions) {
    const outcome = prediction.outcome;
    if (outcome.kind === "SUCCESS" && "regions" in outcome) {
      const pageOccurrences = new Map<number, number>();
      prediction.outcome = providerNativeOutcome({
        candidates: outcome.regions.flatMap((region) =>
          region.rows.map((row) => {
            const pageOccurrenceIndex =
              (pageOccurrences.get(row.page) ?? 0) + 1;
            pageOccurrences.set(row.page, pageOccurrenceIndex);
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
              date: row.dateExplicitness === "FULL" ? row.normalizedDate : null,
              dateOnly:
                row.dateExplicitness === "FULL" ? row.normalizedDate : null,
              installment:
                row.installmentCurrent !== null && row.installmentTotal !== null
                  ? {
                      index: row.installmentCurrent,
                      total: row.installmentTotal,
                    }
                  : null,
              evidenceText: row.evidenceText,
              evidence: {
                pageNumber: row.page,
                text: row.evidenceText,
              },
              selected: false,
              verificationStatus: "UNVERIFIED",
            };
          }),
        ),
      } as never);
    }
    prediction.modelVersion = "quality-closure-fixture";
    prediction.peakRssBytes = policy.maxVmHwmBytes;
    prediction.latencyMs = policy.maxP95LatencyMs;
    prediction.cost.amountMicros = Math.ceil(
      (prediction.usage.inputTokens! *
        policy.pricing.inputMicrosPerMillionTokens +
        prediction.usage.outputTokens! *
          policy.pricing.outputMicrosPerMillionTokens) /
        1_000_000,
    );
    prediction.adapterTrace!.deadlineMs = policy.maxProviderDeadlineMs;
    prediction.adapterTrace!.requestBodyBytes = policy.maxRequestBodyBytes;
  }
  const routingCases = await buildOracleRoutingCases();
  for (const route of routingCases) {
    route.source = "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED";
    route.testFile = SERVICE_QUALIFICATION_PATH;
  }
  const safetyProbes = buildOracleSafetyProbes();
  for (const probe of safetyProbes) {
    probe.source = "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED";
    probe.testFile = SERVICE_PROBE_NAMES.has(`[PROBE] ${probe.id}`)
      ? SERVICE_QUALIFICATION_PATH
      : SAFETY_QUALIFICATION_PATH;
  }
  return {
    datasetVersion: OCR_SYNTH_DATASET.datasetVersion,
    run: liveRun(),
    predictions,
    routingCases,
    safetyProbes,
  };
}

function runtimeSha256(): string {
  const hash = createHash("sha256");
  for (const path of [...policy.runtimeBindingFiles].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(resolve(ROOT, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function qualificationProof(candidateSha: string) {
  return {
    version: 2 as const,
    policyVersion: String(policy.policyVersion),
    snapshot: {
      headSha: candidateSha,
      treeSha: candidateSha,
      clean: true as const,
      policySha256: fileSha256(POLICY_PATH),
      corpusSha256: fileSha256(CORPUS_PATH),
      configurationSha256: "4".repeat(64),
      adapterSha256: "5".repeat(64),
      runtimeSha256: runtimeSha256(),
      suiteSha256: "6".repeat(64),
    },
    tests: QUALIFICATION_TEST_NAMES.map((name) => ({
      name,
      status: "PASS" as const,
      sourcePath:
        name.startsWith("[ROUTE] ") || SERVICE_PROBE_NAMES.has(name)
          ? SERVICE_QUALIFICATION_PATH
          : SAFETY_QUALIFICATION_PATH,
    })),
  };
}

describe("quality-closure corpus terminal outcomes", () => {
  it("pins 18 outcomes with dense24, unreadable INCOMPLETE, and 25-line overflow", () => {
    expect(OCR_SYNTH_SCANNED_RELEASE_CASES).toHaveLength(18);
    expect(successfulRows(getOcrSynthCase("scan-010"))).toHaveLength(24);
    expect(getOcrSynthCase("scan-012").expected).toEqual({
      kind: "ERROR",
      errorCode: "DOCUMENT_UNREADABLE",
      retryable: false,
    });
    expect(getOcrSynthCase("scan-018").expected).toEqual({
      kind: "ERROR",
      errorCode: "LIMIT_EXCEEDED",
      retryable: false,
    });
    const rawCorpus = JSON.parse(
      readFileSync(resolve(ROOT, CORPUS_PATH), "utf8"),
    );
    const overflowFixture = rawCorpus.cases.find(
      (item: { id: string }) => item.id === "scan-018",
    );
    expect(overflowFixture.artifact.pageCount).toBe(10);
    expect(overflowFixture.fixtureRows).toHaveLength(25);
  });

  it("scores expected terminal outcomes as passing instead of missing rows", async () => {
    const predictions = await buildOraclePredictions(true);
    predictions.find((item) => item.caseId === "scan-012")!.outcome = {
      kind: "ERROR",
      errorCode: "DOCUMENT_UNREADABLE",
      retryable: false,
    };
    predictions.find((item) => item.caseId === "scan-018")!.outcome = {
      kind: "ERROR",
      errorCode: "LIMIT_EXCEEDED",
      retryable: false,
    };
    const evidence = await liveEvidence();
    evidence.predictions = predictions;
    const report = await evaluateOcrSynth(evidence);
    for (const caseId of ["scan-012", "scan-018"])
      expect(report.perCase.find((item) => item.caseId === caseId)).toEqual({
        caseId,
        pass: true,
        issues: [],
      });
  });
});

describe("quality-closure mechanical evidence binding", () => {
  it("preserves strict V3 provider facts and explicit defaults through live evidence", async () => {
    const evidence = await liveEvidence();
    const parsed = parseLiveEvidence(evidence);
    const candidate = (caseId: string) => {
      const outcome = parsed.predictions.find((item) => item.caseId === caseId)!
        .outcome as any;
      return outcome.candidates[0];
    };

    expect(candidate("scan-001")).toMatchObject({
      pageNumber: 1,
      pageOccurrenceIndex: 1,
      description: "ITEM SINTETICO 001-0",
      amountCents: "1",
      sign: "POSITIVE",
      amountMeaning: "LINE_AMOUNT",
      dateText: "29/02/2024",
      normalizedDate: "2024-02-29",
      dateExplicitness: "FULL",
      installment: null,
      evidenceText: "29/02/2024  ITEM SINTETICO 001-0  R$ 0,01",
      selected: false,
      verificationStatus: "UNVERIFIED",
      candidateDisposition: "RAW_UNCLASSIFIED",
    });
    expect(candidate("scan-002")).toMatchObject({
      dateText: "29/02",
      normalizedDate: "29/02",
      dateExplicitness: "YEARLESS",
    });
    expect(candidate("scan-003")).toMatchObject({
      dateText: null,
      normalizedDate: null,
      dateExplicitness: "MISSING",
    });
  });

  it("keeps UNKNOWN date evidence distinct from YEARLESS and MISSING", () => {
    const projected = providerNativeOutcome({
      candidates: [
        {
          pageNumber: 2,
          pageOccurrenceIndex: 3,
          description: null,
          amountCents: null,
          sign: "UNKNOWN",
          amountMeaning: "UNKNOWN",
          dateText: "data ilegível",
          normalizedDate: null,
          dateExplicitness: "UNKNOWN",
          date: null,
          dateOnly: null,
          installment: null,
          evidenceText: "data ilegível valor ilegível",
          evidence: {
            pageNumber: 2,
            text: "data ilegível valor ilegível",
          },
          selected: false,
          verificationStatus: "UNVERIFIED",
        },
      ],
    } as never) as any;

    expect(projected.candidates).toEqual([
      {
        pageNumber: 2,
        pageOccurrenceIndex: 3,
        description: null,
        amountCents: null,
        sign: "UNKNOWN",
        amountMeaning: "UNKNOWN",
        dateText: "data ilegível",
        normalizedDate: null,
        dateExplicitness: "UNKNOWN",
        installment: null,
        evidenceText: "data ilegível valor ilegível",
        selected: false,
        verificationStatus: "UNVERIFIED",
        candidateDisposition: "RAW_UNCLASSIFIED",
      },
    ]);
  });

  it("pins the approved policy and pricing boundaries literally", () => {
    expect(policy).toMatchObject({
      maxOutputTokens: 8192,
      maxP95LatencyMs: 30_000,
      maxProviderDeadlineMs: 60_000,
      maxRequestBodyBytes: 20_000_000,
      maxTotalCostMicros: 500_000,
      maxVmHwmBytes: 536_870_912,
      pricing: {
        currency: "USD",
        source: "https://cloud.google.com/vertex-ai/generative-ai/pricing",
        observedOn: "2026-10-14",
        recheckThroughUtc: "2026-10-21",
        inputMicrosPerMillionTokens: 300_000,
        outputMicrosPerMillionTokens: 2_500_000,
      },
    });
  });

  it("accepts exact resource boundaries and rejects one-unit overflow", async () => {
    const exact = await liveEvidence();
    for (const prediction of exact.predictions) {
      prediction.usage.inputTokens = 0;
      prediction.usage.outputTokens = 0;
      prediction.usage.totalTokens = 0;
      prediction.cost.amountMicros = 0;
    }
    exact.predictions[0]!.usage.inputTokens = 1_666_666;
    exact.predictions[0]!.usage.totalTokens = 1_666_666;
    exact.predictions[0]!.cost.amountMicros = policy.maxTotalCostMicros;
    const exactReport = await evaluateOcrSynth(exact);
    expect(exactReport.liveEvidenceGaps).not.toEqual(
      expect.arrayContaining([
        "RSS_LIMIT_NOT_MET",
        "LATENCY_LIMIT_NOT_MET",
        "COST_LIMIT_NOT_MET",
      ]),
    );
    expect(exactReport.perCase.flatMap((item) => item.issues)).not.toEqual(
      expect.arrayContaining([
        "REQUEST_BODY_LIMIT_NOT_MET",
        "DEADLINE_LIMIT_NOT_MET",
      ]),
    );

    const resourceMutations: Array<
      [string, (input: OcrEvalInput) => void, string]
    > = [
      [
        "VmHWM",
        (input) => {
          input.predictions[0]!.peakRssBytes = policy.maxVmHwmBytes + 1;
        },
        "RSS_LIMIT_NOT_MET",
      ],
      [
        "p95 latency",
        (input) => {
          for (const prediction of input.predictions)
            prediction.latencyMs = policy.maxP95LatencyMs + 1;
        },
        "LATENCY_LIMIT_NOT_MET",
      ],
      [
        "total cost",
        (input) => {
          input.predictions[0]!.usage.inputTokens = 1_666_667;
          input.predictions[0]!.usage.totalTokens = 1_666_667;
          input.predictions[0]!.cost.amountMicros =
            policy.maxTotalCostMicros + 1;
        },
        "COST_LIMIT_NOT_MET",
      ],
    ];
    for (const [_label, mutate, issue] of resourceMutations) {
      const input = structuredClone(exact);
      mutate(input);
      const report = await evaluateOcrSynth(input);
      expect(report.liveEvidenceGaps).toContain(issue);
    }

    for (const [_label, field, maximum, issue] of [
      [
        "body",
        "requestBodyBytes",
        policy.maxRequestBodyBytes,
        "REQUEST_BODY_LIMIT_NOT_MET",
      ],
      [
        "deadline",
        "deadlineMs",
        policy.maxProviderDeadlineMs,
        "DEADLINE_LIMIT_NOT_MET",
      ],
    ] as const) {
      const input = structuredClone(exact);
      input.predictions[0]!.adapterTrace![field] = maximum + 1;
      const report = await evaluateOcrSynth(input);
      expect(
        report.perCase.find(
          (item) => item.caseId === input.predictions[0]!.caseId,
        )!.issues,
      ).toContain(issue);
    }
  });

  it("binds Git, policy, corpus and runtime hashes to exactly 10 routes and 35 probes", async () => {
    expect(SAFETY_PROBE_IDS).toHaveLength(35);
    const evidence = await liveEvidence();
    expect(parseLiveEvidence(evidence)).toEqual(evidence);
    const proof = qualificationProof(evidence.run.candidateSha!);
    expect(proof.tests).toHaveLength(45);
    expect([
      ...OCR_SYNTH_ROUTING_CASES.map((item) => `[ROUTE] ${item.id}`),
      ...SAFETY_PROBE_IDS.map((id) => `[PROBE] ${id}`),
    ]).toEqual(QUALIFICATION_TEST_NAMES);
    expect(proof.tests.map((item) => item.name)).toEqual(
      QUALIFICATION_TEST_NAMES,
    );
    expect(
      parseLiveEvidence({
        ...evidence,
        qualityClosure: proof,
      }),
    ).toMatchObject({ qualityClosure: proof });
    const unverified = await evaluateOcrSynth({
      ...evidence,
      qualityClosure: proof,
    } as unknown as OcrEvalInput);
    expect(unverified.releaseStatus).toBe("GAPS");
    expect(unverified.liveEvidenceGaps).toContain(
      "QUALITY_CLOSURE_NOT_VERIFIED",
    );
  });

  it.each([
    ["missing", (tests: any[]) => tests.slice(1)],
    ["duplicate", (tests: any[]) => [tests[0], ...tests]],
    [
      "skip",
      (tests: any[]) =>
        tests.map((item, index) =>
          index === 0 ? { ...item, status: "SKIP" } : item,
        ),
    ],
    [
      "pending",
      (tests: any[]) =>
        tests.map((item, index) =>
          index === 0 ? { ...item, status: "PENDING" } : item,
        ),
    ],
    [
      "todo",
      (tests: any[]) =>
        tests.map((item, index) =>
          index === 0 ? { ...item, status: "TODO" } : item,
        ),
    ],
    [
      "skipped",
      (tests: any[]) =>
        tests.map((item, index) =>
          index === 0 ? { ...item, status: "SKIPPED" } : item,
        ),
    ],
    [
      "fail",
      (tests: any[]) =>
        tests.map((item, index) =>
          index === 0 ? { ...item, status: "FAIL" } : item,
        ),
    ],
    [
      "unknown",
      (tests: any[]) =>
        tests.map((item, index) =>
          index === 0 ? { ...item, status: "UNKNOWN" } : item,
        ),
    ],
  ])("rejects %s qualification test evidence", async (_label, mutate) => {
    const evidence = await liveEvidence();
    const proof = qualificationProof(evidence.run.candidateSha!);
    proof.tests = mutate(proof.tests);
    expect(() =>
      parseLiveEvidence({ ...evidence, qualityClosure: proof }),
    ).toThrow("LIVE_EVIDENCE_INVALID");
  });

  it("rejects every malformed mechanically-derived snapshot hash", async () => {
    for (const field of [
      "policySha256",
      "corpusSha256",
      "configurationSha256",
      "adapterSha256",
      "runtimeSha256",
      "suiteSha256",
    ] as const) {
      const evidence = await liveEvidence();
      const proof = qualificationProof(evidence.run.candidateSha!);
      proof.snapshot[field] = "not-a-hash";
      expect(() =>
        parseLiveEvidence({ ...evidence, qualityClosure: proof }),
      ).toThrow("LIVE_EVIDENCE_INVALID");
    }
  });

  it("rejects a closure snapshot from a different candidate", async () => {
    const evidence = await liveEvidence();
    const proof = qualificationProof(evidence.run.candidateSha!);
    proof.snapshot.headSha = "f".repeat(40);
    expect(() =>
      parseLiveEvidence({ ...evidence, qualityClosure: proof }),
    ).toThrow("LIVE_EVIDENCE_INVALID");
  });

  it("requires sourcePath on every canonical v2 test result", async () => {
    const evidence = await liveEvidence();
    const proof = qualificationProof(evidence.run.candidateSha!);
    delete (proof.tests[0] as Partial<(typeof proof.tests)[number]>).sourcePath;
    expect(() =>
      parseLiveEvidence({ ...evidence, qualityClosure: proof }),
    ).toThrow("LIVE_EVIDENCE_INVALID");
  });

  it("rejects duplicate evidence JSON keys before object validation", async () => {
    const evidence = await liveEvidence();
    const bound = {
      ...evidence,
      qualityClosure: qualificationProof(evidence.run.candidateSha!),
    };
    const serialized = JSON.stringify(bound);
    const duplicates = [
      serialized.replace(
        `"datasetVersion":"${evidence.datasetVersion}"`,
        `"datasetVersion":"${evidence.datasetVersion}","datasetVersion":"${evidence.datasetVersion}"`,
      ),
      serialized.replace(`"clean":true`, `"clean":true,"clean":true`),
    ];
    for (const raw of duplicates)
      expect(() => parseLiveEvidenceJson(raw)).toThrow("LIVE_EVIDENCE_INVALID");
  });

  it("rejects reordered case identities instead of treating the corpus as a set", async () => {
    const evidence = await liveEvidence();
    [evidence.predictions[0], evidence.predictions[1]] = [
      evidence.predictions[1]!,
      evidence.predictions[0]!,
    ];
    expect(() => parseLiveEvidence(evidence)).toThrow("LIVE_EVIDENCE_INVALID");
  });

  it("scores an artifact hash rewrite against the generated corpus as GAPS", async () => {
    const evidence = await liveEvidence();
    const replacement = "f".repeat(64);
    evidence.predictions[0]!.artifactSha256 = replacement;
    const parsed = parseLiveEvidence(evidence);
    const report = await evaluateOcrSynth(parsed);
    expect(report.perCase[0]!.issues).toContain("ARTIFACT_HASH_MISMATCH");
    expect(report.releaseStatus).toBe("GAPS");
  });
});
