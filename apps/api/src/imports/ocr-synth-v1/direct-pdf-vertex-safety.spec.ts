import { OCR_SYNTH_DATASET } from "./corpus";
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
  SAFETY_PROBE_IDS,
  type OcrEvalPrediction,
  type OcrPromptContractEvidence,
  type OcrRoutingEvidence,
  type OcrSafetyProbeEvidence,
  type SafetyProbeId,
} from "./types";

function run(): OcrEvalRunConfig {
  return {
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
    baseline: {
      sha: "08d19d11638a55e14ce73a6bf472894174c66389",
      behavior: "OCR_REQUIRED",
      sampleCount: 18,
    },
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

function evidence(
  predictions: OcrEvalPrediction[],
  routingCases: OcrRoutingEvidence[],
  config = run(),
): OcrEvalInput {
  return {
    datasetVersion: OCR_SYNTH_DATASET.datasetVersion,
    run: config,
    predictions,
    routingCases,
    safetyProbes: buildOracleSafetyProbes(),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("scanned PDF Vertex adapter and service mutation gates", () => {
  let baseline: OcrEvalPrediction[];
  let routes: OcrRoutingEvidence[];

  beforeAll(async () => {
    baseline = await buildOraclePredictions(true);
    routes = await buildOracleRoutingCases();
  });

  it("keeps exactly 35 unique safety IDs", () => {
    expect(SAFETY_PROBE_IDS).toHaveLength(35);
    expect(new Set(SAFETY_PROBE_IDS).size).toBe(35);
  });

  it("expands existing partial and malformed probes instead of adding IDs", () => {
    const probes = buildOracleSafetyProbes() as Array<
      OcrSafetyProbeEvidence & { scenarios?: string[] }
    >;
    expect(probes).toHaveLength(35);
    expect(probes.find((item) => item.id === "PARTIAL_RESPONSE")).toMatchObject(
      {
        id: "PARTIAL_RESPONSE",
        scenarios: [
          "EMPTY_DECEPTION",
          "OMITTED_PAGE",
          "DUPLICATE_PAGE",
          "DECREASING_PAGE",
          "PAGE_COUNT_MISMATCH",
          "PAGE_OCCURRENCE_INDEX_GAP",
          "PAGE_OCCURRENCE_ORDER",
        ],
      },
    );
    expect(
      probes.find((item) => item.id === "MALFORMED_RESPONSE"),
    ).toMatchObject({
      id: "MALFORMED_RESPONSE",
      scenarios: ["OUTER_DUPLICATE_KEY", "EMBEDDED_DUPLICATE_KEY"],
    });
  });

  const assertBlockedExplicitZeroWrite = async (id: SafetyProbeId) => {
    const value = evidence(clone(baseline), routes);
    const probe = value.safetyProbes.find((item) => item.id === id)!;
    probe.blocked = false;
    probe.explicitError = false;
    probe.financialWrites = 1;
    const report = await evaluateOcrSynth(value);
    const result = report.safetyProbes.find((item) => item.id === id)!;
    expect(result.pass).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        "MUTATION_NOT_BLOCKED",
        "SUCCESS_SHAPED_OR_HIDDEN_ERROR",
        "FINANCIAL_WRITE",
      ]),
    );
  };

  it.each([
    [
      "wrong regional endpoint",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.endpoint = "https://aiplatform.googleapis.com";
      },
      "WRONG_ENDPOINT",
    ],
    [
      "wrong model",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.model = "gemini-2.0-flash";
      },
      "WRONG_MODEL",
    ],
    [
      "wrong region",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.region = "us-central1";
      },
      "WRONG_REGION",
    ],
    [
      "API key auth",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.apiKeyUsed = true;
      },
      "API_KEY_OR_AUTH_VIOLATION",
    ],
    [
      "unbounded ADC scope",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.adcScopes.push(
          "https://www.googleapis.com/auth/drive",
        );
      },
      "UNBOUNDED_ADC_SCOPE",
    ],
    [
      "oversized request body",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.requestBodyBytes = 20_000_001;
      },
      "REQUEST_BODY_LIMIT_NOT_MET",
    ],
    [
      "unbounded deadline",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.deadlineMs = 30_001;
      },
      "DEADLINE_LIMIT_NOT_MET",
    ],
    [
      "global endpoint fallback",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.globalEndpointFallbackUsed = true;
      },
      "GLOBAL_ENDPOINT_FALLBACK",
    ],
    [
      "tools",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.toolsPresent = true;
      },
      "TOOLS_PRESENT",
    ],
    [
      "file URI",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.fileUri = "gs://forbidden/object.pdf";
      },
      "FILE_URI_PRESENT",
    ],
    [
      "cache",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.cachedContent = "cachedContents/forbidden";
      },
      "CACHE_PRESENT",
    ],
    [
      "local raster instead of original PDF",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.inputMimeType = "image/png";
      },
      "NOT_ORIGINAL_DIRECT_PDF_BYTES",
    ],
    [
      "changed bytes",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.originalBytesSha256 = "f".repeat(64);
      },
      "NOT_ORIGINAL_DIRECT_PDF_BYTES",
    ],
    [
      "UNKNOWN outcome retry",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.attempts = 2;
        items[0]!.adapterTrace!.ambiguousTimeoutRetried = true;
      },
      "AMBIGUOUS_RETRY",
    ],
    [
      "mixed local plus provider duplication",
      (items: OcrEvalPrediction[]) => {
        items[0]!.adapterTrace!.localFinancialRowsMerged = 1;
      },
      "DUPLICATED_LOCAL_PROVIDER_ROWS",
    ],
    [
      "missing consent",
      (items: OcrEvalPrediction[]) => {
        items[0]!.consentRecorded = false;
      },
      "MISSING_CONSENT",
    ],
    [
      "wrong exact consent capability",
      (items: OcrEvalPrediction[]) => {
        items[0]!.consentCapability!.capability = "ANALYZE_ATTACHMENT_V2";
        items[0]!.consentCapability!.artifactSha256 = "f".repeat(64);
        items[0]!.consentCapability!.actorId = "other-actor";
      },
      "CONSENT_CAPABILITY_MISMATCH",
    ],
    [
      "incomplete original-file disclosure",
      (items: OcrEvalPrediction[]) => {
        const consent = items[0]!.consentCapability! as unknown as {
          includesMetadataAndEmbeddedContent: boolean;
          includesPotentiallyNonVisibleContent: boolean;
          externalContentRetentionDays: number;
        };
        consent.includesMetadataAndEmbeddedContent = false;
        consent.includesPotentiallyNonVisibleContent = false;
        consent.externalContentRetentionDays = 30;
      },
      "CONSENT_CAPABILITY_MISMATCH",
    ],
    [
      "attestation not required",
      (items: OcrEvalPrediction[]) => {
        (
          items[0]! as unknown as {
            attestationRequired: boolean;
          }
        ).attestationRequired = false;
      },
      "ATTESTATION_NOT_REQUIRED",
    ],
    [
      "financial write",
      (items: OcrEvalPrediction[]) => {
        items[0]!.financialWrites = 1;
      },
      "FINANCIAL_WRITE",
    ],
  ])("fails release on %s", async (_label, mutate, issue) => {
    const predictions = clone(baseline);
    mutate(predictions);
    const report = await evaluateOcrSynth(evidence(predictions, routes));
    expect(report.functionalStatus).toBe("FAIL");
    expect(report.regressions.flatMap((item) => item.issues)).toContain(issue);
  });

  it.each([
    "rawCandidatesOnly",
    "allVisibleOccurrences",
    "allPagesInOrder",
    "preserveDuplicates",
    "signedAmountIncludesNegativeZeroUnknown",
    "noFinancialExclusionsOrClassification",
  ] as Array<keyof OcrPromptContractEvidence>)(
    "rejects incomplete prompt contract: %s",
    async (field) => {
      const predictions = clone(baseline);
      predictions[0]!.adapterTrace!.promptContract[field] = false;
      const report = await evaluateOcrSynth(evidence(predictions, routes));
      expect(report.regressions[0]!.issues).toContain(
        "PROMPT_COMPLETENESS_CONTRACT_MISSING",
      );
    },
  );

  it.each([
    ["missing STOP", null, 8192, "MISSING_STOP_FINISH_REASON"],
    ["non-STOP finish", "MAX_TOKENS", 8192, "MISSING_STOP_FINISH_REASON"],
    ["missing 8k config", "STOP", null, "MISSING_8K_OUTPUT_LIMIT_EVIDENCE"],
    ["wrong output limit", "STOP", 4096, "MISSING_8K_OUTPUT_LIMIT_EVIDENCE"],
  ])(
    "fails release on %s evidence",
    async (_label, finishReason, maxOutputTokens, issue) => {
      const predictions = clone(baseline);
      predictions[0]!.adapterTrace!.finishReason = finishReason;
      predictions[0]!.adapterTrace!.maxOutputTokens = maxOutputTokens;
      const report = await evaluateOcrSynth(evidence(predictions, routes));
      expect(report.functionalStatus).toBe("FAIL");
      expect(report.regressions[0]!.issues).toContain(issue);
    },
  );

  it.each(["endpoint", "model", "region"] as const)(
    "rejects wrong run-level %s pin",
    async (field) => {
      const config = run();
      config[field] =
        field === "endpoint"
          ? "https://aiplatform.googleapis.com"
          : field === "model"
            ? "gemini-2.0-flash"
            : "us-central1";
      const report = await evaluateOcrSynth(
        evidence(clone(baseline), routes, config),
      );
      expect(report.releaseStatus).toBe("GAPS");
      expect(report.liveEvidenceGaps).toContain(
        `WRONG_RUN_${field.toUpperCase()}`,
      );
    },
  );

  it("requires data-owner residual-risk acceptance and final reviews", async () => {
    const config = run();
    config.residualRiskAcceptance = null;
    config.finalReviews = null;
    const report = await evaluateOcrSynth(
      evidence(clone(baseline), routes, config),
    );
    expect(report.liveEvidenceGaps).toEqual(
      expect.arrayContaining([
        "MISSING_DATA_OWNER_RESIDUAL_RISK_ACCEPTANCE",
        "MISSING_FINAL_REVIEW_EVIDENCE",
      ]),
    );
  });

  it("requires a durable tenant/global budget policy", async () => {
    const config = run();
    config.durableBudgets = null;
    const report = await evaluateOcrSynth(
      evidence(clone(baseline), routes, config),
    );
    expect(report.liveEvidenceGaps).toContain("MISSING_DURABLE_BUDGET_POLICY");
  });

  it.each([
    "WRONG_ENDPOINT",
    "WRONG_MODEL",
    "WRONG_REGION",
    "API_KEY_AUTH",
    "ADC_SCOPE_BOUNDED",
    "REQUEST_BODY_BOUNDED",
    "DEADLINE_BOUNDED",
    "GLOBAL_ENDPOINT_FALLBACK",
    "TOOLS_PRESENT",
    "FILE_URI_PRESENT",
    "CACHE_PRESENT",
    "TEXTUAL_PDF_PROVIDER_CALL",
    "LOCAL_RASTER_SANDBOX",
    "PAGE_11_ADMISSION",
    "MIXED_LOCAL_PROVIDER_DUPLICATION",
    "PARTIAL_RESPONSE",
    "MALFORMED_RESPONSE",
    "TRUNCATED_RESPONSE",
    "SAFETY_BLOCKED_RESPONSE",
    "AMBIGUOUS_TIMEOUT_RETRY",
    "UNKNOWN_OUTCOME_NO_RETRY",
    "DURABLE_TENANT_BUDGET",
    "DURABLE_GLOBAL_BUDGET",
    "ACTIVE_SESSION_CONTENT_PURGE_AFTER_7_DAYS",
    "FINANCIAL_WRITE",
    "KNOWN_SAFETY_FINISH_REASONS",
    "TERMINAL_FAILURE_REPLAY_NO_CALL",
    "CAPABILITY_OFF",
    "RESIDUAL_RISK_ACCEPTANCE",
  ] as SafetyProbeId[])("[PROBE] %s", assertBlockedExplicitZeroWrite);

  it.each([
    "EXACT_CONSENT_CAPABILITY",
    "SELECTED_TRUE_DEFAULT",
    "VERIFIED_DEFAULT",
    "MISSING_CONSENT",
    "MISSING_ATTESTATION",
    "PRIOR_CONSENT_DECLARATION",
  ] as SafetyProbeId[])(
    "retains evaluator mutation control for service-context proof: %s",
    assertBlockedExplicitZeroWrite,
  );

  it.each([
    "DURABLE_TENANT_BUDGET",
    "DURABLE_GLOBAL_BUDGET",
    "ACTIVE_SESSION_CONTENT_PURGE_AFTER_7_DAYS",
    "TERMINAL_FAILURE_REPLAY_NO_CALL",
  ] as SafetyProbeId[])("requires durable state proof for %s", async (id) => {
    const value = evidence(clone(baseline), routes);
    value.safetyProbes.find((item) => item.id === id)!.durableStateVerified =
      false;
    const report = await evaluateOcrSynth(value);
    expect(
      report.safetyProbes.find((item) => item.id === id)!.issues,
    ).toContain("DURABLE_STATE_NOT_PROVED");
  });

  it("requires every known safety finish reason to fail visibly", async () => {
    const value = evidence(clone(baseline), routes);
    value.safetyProbes
      .find((item) => item.id === "KNOWN_SAFETY_FINISH_REASONS")!
      .finishReasonsTested.pop();
    const report = await evaluateOcrSynth(value);
    expect(
      report.safetyProbes.find(
        (item) => item.id === "KNOWN_SAFETY_FINISH_REASONS",
      )!.issues,
    ).toContain("KNOWN_SAFETY_FINISH_REASONS_NOT_PROVED");
  });

  it.each([
    "TEXTUAL_PDF_PROVIDER_CALL",
    "PAGE_11_ADMISSION",
    "MISSING_CONSENT",
    "MISSING_ATTESTATION",
    "DURABLE_TENANT_BUDGET",
    "DURABLE_GLOBAL_BUDGET",
    "ACTIVE_SESSION_CONTENT_PURGE_AFTER_7_DAYS",
    "EXACT_CONSENT_CAPABILITY",
    "CAPABILITY_OFF",
    "PRIOR_CONSENT_DECLARATION",
    "RESIDUAL_RISK_ACCEPTANCE",
    "TERMINAL_FAILURE_REPLAY_NO_CALL",
    "FINANCIAL_WRITE",
  ] as SafetyProbeId[])(
    "requires zero provider calls before forbidden boundary: %s",
    async (id) => {
      const value = evidence(clone(baseline), routes);
      value.safetyProbes.find((item) => item.id === id)!.providerCalls = 1;
      const report = await evaluateOcrSynth(value);
      expect(
        report.safetyProbes.find((item) => item.id === id)!.issues,
      ).toContain("WRONG_PROVIDER_CALL_COUNT");
    },
  );

  it.each([
    "PARTIAL_RESPONSE",
    "MALFORMED_RESPONSE",
    "TRUNCATED_RESPONSE",
    "SAFETY_BLOCKED_RESPONSE",
    "AMBIGUOUS_TIMEOUT_RETRY",
    "UNKNOWN_OUTCOME_NO_RETRY",
    "KNOWN_SAFETY_FINISH_REASONS",
  ] as SafetyProbeId[])(
    "requires one visible failed request and no hidden retry: %s",
    async (id) => {
      const value = evidence(clone(baseline), routes);
      value.safetyProbes.find((item) => item.id === id)!.providerCalls = 2;
      const report = await evaluateOcrSynth(value);
      expect(
        report.safetyProbes.find((item) => item.id === id)!.issues,
      ).toContain("WRONG_PROVIDER_CALL_COUNT");
    },
  );
});
