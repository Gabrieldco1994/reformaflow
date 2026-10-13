import { OCR_SYNTH_DATASET } from "./corpus";
import { artifactSha256, generateArtifact } from "./fixture-generator";
import type {
  OcrEvalCase,
  OcrEvalPrediction,
  OcrEvalRegion,
  OcrEvalRow,
} from "./types";

export const OCR_SYNTH_THRESHOLDS = {
  taskSuccessRate: 1,
  exactMoneyRate: 1,
  exactSignRate: 1,
  exactDateRate: 1,
  exactDateExplicitnessRate: 1,
  exactInstallmentRate: 1,
  schemaValidityRate: 1,
  inventedRows: 0,
  omittedRows: 0,
  tenantLeaks: 0,
  maxPeakRssBytes: 512 * 1024 * 1024,
} as const;

export interface OcrEvalRunConfig {
  mode: "OFFLINE_ORACLE" | "LIVE_CAPTURE";
  candidateSha: string | null;
  configurationSha256: string | null;
  provider: string | null;
  model: string | null;
  modelVersion: string | null;
  promptSha256: string | null;
  baseline: {
    sha: string;
    behavior: "OCR_REQUIRED";
    sampleCount: 28;
  };
  declaredLimits: {
    maxP95LatencyMs: number | null;
    maxTotalCostMicros: number | null;
  };
}

export interface OcrEvalInput {
  datasetVersion: string;
  run: OcrEvalRunConfig;
  predictions: OcrEvalPrediction[];
}

interface Counters {
  expectedRows: number;
  observedRows: number;
  moneyMatches: number;
  signMatches: number;
  dateMatches: number;
  explicitnessMatches: number;
  installmentMatches: number;
  inventedRows: number;
  omittedRows: number;
  tenantLeaks: number;
  schemaValidCases: number;
}

export interface OcrEvalReport {
  reportSchemaVersion: 1;
  datasetVersion: "ocr-synth-v1";
  datasetSampleCount: 52;
  pdfSliceSampleCount: 28;
  baseline: OcrEvalRunConfig["baseline"];
  candidate: Omit<OcrEvalRunConfig, "baseline" | "declaredLimits">;
  thresholds: typeof OCR_SYNTH_THRESHOLDS;
  metrics: {
    taskSuccessRate: number;
    exactMoneyRate: number;
    exactSignRate: number;
    exactDateRate: number;
    exactDateExplicitnessRate: number;
    exactInstallmentRate: number;
    schemaValidityRate: number;
    inventedRows: number;
    omittedRows: number;
    tenantLeaks: number;
    p95LatencyMs: number | null;
    peakRssBytes: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalCostMicros: number | null;
    costCurrency: "USD";
  };
  perCase: Array<{ caseId: string; pass: boolean; issues: string[] }>;
  regressions: Array<{ caseId: string; issues: string[] }>;
  fallbackSafety: {
    typedNegativeFailures: boolean;
    emptySuccessAccepted: false;
    financialWritesPerformed: 0;
    tenantLeakCount: number;
  };
  liveEvidenceGaps: string[];
  functionalStatus: "PASS" | "FAIL";
  releaseStatus: "PASS" | "GAPS";
}

const expectedArtifactHashes = new Map<string, Promise<string>>();

function expectedArtifactSha256(testCase: OcrEvalCase): Promise<string> {
  const cached = expectedArtifactHashes.get(testCase.id);
  if (cached) return cached;
  const computed = generateArtifact(testCase).then(artifactSha256);
  expectedArtifactHashes.set(testCase.id, computed);
  return computed;
}

function safeRate(matches: number, total: number): number {
  return total === 0 ? 1 : matches / total;
}

function finiteNonNegative(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function compareRow(
  expected: OcrEvalRow,
  actual: OcrEvalRow | undefined,
  counters: Counters,
  issues: string[],
): void {
  if (!actual) return;
  if (actual.amountCents === expected.amountCents) counters.moneyMatches += 1;
  else issues.push("MONEY_MISMATCH");
  if (actual.sign === expected.sign) counters.signMatches += 1;
  else issues.push("SIGN_MISMATCH");
  if (
    actual.dateText === expected.dateText &&
    actual.normalizedDate === expected.normalizedDate
  )
    counters.dateMatches += 1;
  else issues.push("DATE_MISMATCH");
  if (actual.dateExplicitness === expected.dateExplicitness)
    counters.explicitnessMatches += 1;
  else issues.push("DATE_EXPLICITNESS_MISMATCH");
  if (
    actual.installmentText === expected.installmentText &&
    actual.installmentCurrent === expected.installmentCurrent &&
    actual.installmentTotal === expected.installmentTotal
  )
    counters.installmentMatches += 1;
  else issues.push("INSTALLMENT_MISMATCH");
  if (
    actual.rowId !== expected.rowId ||
    actual.page !== expected.page ||
    actual.order !== expected.order ||
    actual.description !== expected.description ||
    JSON.stringify(actual.bbox) !== JSON.stringify(expected.bbox)
  )
    issues.push("ROW_SCHEMA_OR_PROVENANCE_MISMATCH");
}

function compareRegion(
  expected: OcrEvalRegion,
  actual: OcrEvalRegion | undefined,
  counters: Counters,
  issues: string[],
): void {
  if (!actual) {
    issues.push("MISSING_REGION");
    counters.omittedRows += expected.rows.length;
    return;
  }
  if (
    actual.regionId !== expected.regionId ||
    actual.page !== expected.page ||
    actual.order !== expected.order ||
    JSON.stringify(actual.bbox) !== JSON.stringify(expected.bbox)
  )
    issues.push("REGION_ORDER_OR_PROVENANCE_MISMATCH");
  const common = Math.min(expected.rows.length, actual.rows.length);
  for (let index = 0; index < common; index += 1)
    compareRow(expected.rows[index], actual.rows[index], counters, issues);
  if (actual.rows.length > expected.rows.length) {
    const invented = actual.rows.length - expected.rows.length;
    counters.inventedRows += invented;
    issues.push("INVENTED_ROW");
  }
  if (actual.rows.length < expected.rows.length) {
    const omitted = expected.rows.length - actual.rows.length;
    counters.omittedRows += omitted;
    issues.push("OMITTED_ROW");
  }
}

function compareOutcome(
  testCase: OcrEvalCase,
  prediction: OcrEvalPrediction,
  counters: Counters,
  issues: string[],
): void {
  if (testCase.expected.kind !== prediction.outcome.kind) {
    issues.push("OUTCOME_KIND_MISMATCH");
    if (testCase.expected.kind === "SUCCESS")
      counters.omittedRows += testCase.expected.regions.flatMap(
        (region) => region.rows,
      ).length;
    return;
  }
  if (testCase.expected.kind === "ERROR") {
    const actual = prediction.outcome as Extract<
      typeof prediction.outcome,
      { kind: "ERROR" }
    >;
    if (
      actual.errorCode !== testCase.expected.errorCode ||
      actual.retryable !== testCase.expected.retryable
    )
      issues.push("UNTYPED_OR_WRONG_NEGATIVE_FAILURE");
    return;
  }
  const expected = testCase.expected;
  const actual = prediction.outcome as Extract<
    typeof prediction.outcome,
    { kind: "SUCCESS" }
  >;
  counters.expectedRows += expected.regions.flatMap(
    (region) => region.rows,
  ).length;
  counters.observedRows += actual.regions.flatMap(
    (region) => region.rows,
  ).length;
  const common = Math.min(expected.regions.length, actual.regions.length);
  for (let index = 0; index < common; index += 1)
    compareRegion(
      expected.regions[index],
      actual.regions[index],
      counters,
      issues,
    );
  if (actual.regions.length > expected.regions.length) {
    counters.inventedRows += actual.regions
      .slice(expected.regions.length)
      .flatMap((region) => region.rows).length;
    issues.push("UNEXPECTED_REGION");
  }
  for (const region of expected.regions.slice(common))
    compareRegion(region, undefined, counters, issues);
  if (
    JSON.stringify(actual.blankPages) !== JSON.stringify(expected.blankPages) ||
    JSON.stringify(actual.unreadablePages) !==
      JSON.stringify(expected.unreadablePages)
  )
    issues.push("PAGE_STATUS_MISMATCH");
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

export async function buildOraclePredictions(
  liveFields = false,
): Promise<OcrEvalPrediction[]> {
  const results: OcrEvalPrediction[] = [];
  for (const testCase of OCR_SYNTH_DATASET.cases) {
    const hash = await expectedArtifactSha256(testCase);
    results.push({
      caseId: testCase.id,
      tenantId: testCase.tenantId,
      artifactSha256: hash,
      outcome: structuredClone(testCase.expected),
      provider: liveFields ? "synthetic-provider-for-evaluator-test" : null,
      model: liveFields ? "synthetic-model-for-evaluator-test" : null,
      modelVersion: liveFields ? "fixture-version" : null,
      promptSha256: liveFields ? "a".repeat(64) : null,
      latencyMs: liveFields ? 1 : null,
      peakRssBytes: liveFields ? 1 : null,
      usage: {
        inputTokens: liveFields ? 1 : null,
        outputTokens: liveFields ? 1 : null,
      },
      cost: { currency: "USD", amountMicros: liveFields ? 1 : null },
      requestId: liveFields ? `evaluator-test-${testCase.id}` : null,
    });
  }
  return results;
}

export async function evaluateOcrSynth(
  input: OcrEvalInput,
): Promise<OcrEvalReport> {
  const counters: Counters = {
    expectedRows: 0,
    observedRows: 0,
    moneyMatches: 0,
    signMatches: 0,
    dateMatches: 0,
    explicitnessMatches: 0,
    installmentMatches: 0,
    inventedRows: 0,
    omittedRows: 0,
    tenantLeaks: 0,
    schemaValidCases: 0,
  };
  const byId = new Map(
    input.predictions.map((prediction) => [prediction.caseId, prediction]),
  );
  const duplicateCount = input.predictions.length - byId.size;
  const expectedIds = new Set(OCR_SYNTH_DATASET.cases.map((item) => item.id));
  const extraIds = [...byId.keys()].filter((id) => !expectedIds.has(id));
  const perCase: OcrEvalReport["perCase"] = [];

  for (const testCase of OCR_SYNTH_DATASET.cases) {
    const issues: string[] = [];
    const prediction = byId.get(testCase.id);
    if (!prediction) {
      issues.push("MISSING_CASE");
      if (testCase.expected.kind === "SUCCESS")
        counters.omittedRows += testCase.expected.regions.flatMap(
          (region) => region.rows,
        ).length;
      perCase.push({ caseId: testCase.id, pass: false, issues });
      continue;
    }
    const expectedHash = await expectedArtifactSha256(testCase);
    if (prediction.artifactSha256 !== expectedHash)
      issues.push("ARTIFACT_HASH_MISMATCH");
    if (prediction.tenantId !== testCase.tenantId) {
      counters.tenantLeaks += 1;
      issues.push("TENANT_BINDING_MISMATCH");
    }
    compareOutcome(testCase, prediction, counters, issues);
    if (issues.length === 0) counters.schemaValidCases += 1;
    perCase.push({
      caseId: testCase.id,
      pass: issues.length === 0,
      issues: [...new Set(issues)],
    });
  }

  const twinA = byId.get("tenant-identical-bytes-a");
  const twinB = byId.get("tenant-identical-bytes-b");
  if (
    twinA &&
    twinB &&
    twinA.requestId !== null &&
    twinA.requestId === twinB.requestId
  ) {
    counters.tenantLeaks += 1;
    perCase
      .find((item) => item.caseId === twinB.caseId)
      ?.issues.push("CROSS_TENANT_RESULT_REUSE");
    const item = perCase.find((entry) => entry.caseId === twinB.caseId);
    if (item) item.pass = false;
  }

  const structuralIssues = duplicateCount + extraIds.length;
  const latencies = input.predictions.flatMap((item) =>
    finiteNonNegative(item.latencyMs) ? [item.latencyMs] : [],
  );
  const rssValues = input.predictions.flatMap((item) =>
    finiteNonNegative(item.peakRssBytes) ? [item.peakRssBytes] : [],
  );
  const inputTokens = input.predictions.every((item) =>
    finiteNonNegative(item.usage.inputTokens),
  )
    ? input.predictions.reduce((sum, item) => sum + item.usage.inputTokens!, 0)
    : null;
  const outputTokens = input.predictions.every((item) =>
    finiteNonNegative(item.usage.outputTokens),
  )
    ? input.predictions.reduce((sum, item) => sum + item.usage.outputTokens!, 0)
    : null;
  const totalCostMicros = input.predictions.every((item) =>
    finiteNonNegative(item.cost.amountMicros),
  )
    ? input.predictions.reduce((sum, item) => sum + item.cost.amountMicros!, 0)
    : null;
  const p95LatencyMs = percentile95(latencies);
  const peakRssBytes = rssValues.length === 0 ? null : Math.max(...rssValues);
  const taskSuccessRate =
    perCase.filter((item) => item.pass).length / OCR_SYNTH_DATASET.cases.length;
  const metrics: OcrEvalReport["metrics"] = {
    taskSuccessRate,
    exactMoneyRate: safeRate(counters.moneyMatches, counters.expectedRows),
    exactSignRate: safeRate(counters.signMatches, counters.expectedRows),
    exactDateRate: safeRate(counters.dateMatches, counters.expectedRows),
    exactDateExplicitnessRate: safeRate(
      counters.explicitnessMatches,
      counters.expectedRows,
    ),
    exactInstallmentRate: safeRate(
      counters.installmentMatches,
      counters.expectedRows,
    ),
    schemaValidityRate:
      counters.schemaValidCases / OCR_SYNTH_DATASET.cases.length,
    inventedRows: counters.inventedRows,
    omittedRows: counters.omittedRows,
    tenantLeaks: counters.tenantLeaks,
    p95LatencyMs,
    peakRssBytes,
    inputTokens,
    outputTokens,
    totalCostMicros,
    costCurrency: "USD",
  };
  const functionalPass =
    structuralIssues === 0 &&
    taskSuccessRate === 1 &&
    metrics.exactMoneyRate === 1 &&
    metrics.exactSignRate === 1 &&
    metrics.exactDateRate === 1 &&
    metrics.exactDateExplicitnessRate === 1 &&
    metrics.exactInstallmentRate === 1 &&
    metrics.schemaValidityRate === 1 &&
    metrics.inventedRows === 0 &&
    metrics.omittedRows === 0 &&
    metrics.tenantLeaks === 0;

  const liveEvidenceGaps: string[] = [];
  if (input.datasetVersion !== OCR_SYNTH_DATASET.datasetVersion)
    liveEvidenceGaps.push("DATASET_VERSION_MISMATCH");
  if (input.run.mode !== "LIVE_CAPTURE")
    liveEvidenceGaps.push("LIVE_PROVIDER_RUN_NOT_SUPPLIED");
  if (
    input.run.baseline.sha !== OCR_SYNTH_DATASET.baseSha ||
    input.run.baseline.behavior !== "OCR_REQUIRED" ||
    input.run.baseline.sampleCount !== 28
  )
    liveEvidenceGaps.push("BASELINE_PROVENANCE_MISMATCH");
  for (const field of [
    "candidateSha",
    "configurationSha256",
    "provider",
    "model",
    "modelVersion",
    "promptSha256",
  ] as const) {
    if (!input.run[field])
      liveEvidenceGaps.push(`MISSING_${field.toUpperCase()}`);
  }
  if (
    input.run.candidateSha !== null &&
    !/^[0-9a-f]{40}$/.test(input.run.candidateSha)
  )
    liveEvidenceGaps.push("INVALID_CANDIDATE_SHA");
  if (
    input.run.configurationSha256 !== null &&
    !/^[0-9a-f]{64}$/.test(input.run.configurationSha256)
  )
    liveEvidenceGaps.push("INVALID_CONFIGURATION_SHA");
  if (
    input.run.promptSha256 !== null &&
    !/^[0-9a-f]{64}$/.test(input.run.promptSha256)
  )
    liveEvidenceGaps.push("INVALID_PROMPT_SHA");
  if (
    input.predictions.some(
      (item) =>
        item.provider !== input.run.provider ||
        item.model !== input.run.model ||
        item.modelVersion !== input.run.modelVersion ||
        item.promptSha256 !== input.run.promptSha256,
    )
  )
    liveEvidenceGaps.push("MISSING_OR_MISMATCHED_CASE_PROVENANCE");
  if (input.predictions.some((item) => item.cost.currency !== "USD"))
    liveEvidenceGaps.push("INVALID_COST_CURRENCY");
  if (!finiteNonNegative(input.run.declaredLimits.maxP95LatencyMs))
    liveEvidenceGaps.push("MISSING_DECLARED_LATENCY_LIMIT");
  if (!finiteNonNegative(input.run.declaredLimits.maxTotalCostMicros))
    liveEvidenceGaps.push("MISSING_DECLARED_COST_LIMIT");
  if (input.predictions.length !== 52)
    liveEvidenceGaps.push("INCOMPLETE_LIVE_SAMPLE");
  if (latencies.length !== 52)
    liveEvidenceGaps.push("MISSING_LATENCY_EVIDENCE");
  if (rssValues.length !== 52) liveEvidenceGaps.push("MISSING_RSS_EVIDENCE");
  if (inputTokens === null || outputTokens === null)
    liveEvidenceGaps.push("MISSING_USAGE_EVIDENCE");
  if (totalCostMicros === null) liveEvidenceGaps.push("MISSING_COST_EVIDENCE");
  if (input.predictions.some((item) => !item.requestId))
    liveEvidenceGaps.push("MISSING_PROVIDER_REQUEST_ID");
  const requestIds = input.predictions.flatMap((item) =>
    item.requestId ? [item.requestId] : [],
  );
  if (new Set(requestIds).size !== requestIds.length)
    liveEvidenceGaps.push("DUPLICATE_PROVIDER_REQUEST_ID");
  if (
    p95LatencyMs !== null &&
    input.run.declaredLimits.maxP95LatencyMs !== null &&
    p95LatencyMs > input.run.declaredLimits.maxP95LatencyMs
  )
    liveEvidenceGaps.push("LATENCY_LIMIT_EXCEEDED");
  if (
    totalCostMicros !== null &&
    input.run.declaredLimits.maxTotalCostMicros !== null &&
    totalCostMicros > input.run.declaredLimits.maxTotalCostMicros
  )
    liveEvidenceGaps.push("COST_LIMIT_EXCEEDED");
  if (
    peakRssBytes !== null &&
    peakRssBytes > OCR_SYNTH_THRESHOLDS.maxPeakRssBytes
  )
    liveEvidenceGaps.push("RSS_512_MIB_LIMIT_EXCEEDED");
  if (!functionalPass) liveEvidenceGaps.push("FUNCTIONAL_THRESHOLDS_FAILED");

  return {
    reportSchemaVersion: 1,
    datasetVersion: OCR_SYNTH_DATASET.datasetVersion,
    datasetSampleCount: 52,
    pdfSliceSampleCount: 28,
    baseline: input.run.baseline,
    candidate: {
      mode: input.run.mode,
      candidateSha: input.run.candidateSha,
      configurationSha256: input.run.configurationSha256,
      provider: input.run.provider,
      model: input.run.model,
      modelVersion: input.run.modelVersion,
      promptSha256: input.run.promptSha256,
    },
    thresholds: OCR_SYNTH_THRESHOLDS,
    metrics,
    perCase,
    regressions: perCase
      .filter((item) => !item.pass)
      .map((item) => ({
        caseId: item.caseId,
        issues: item.issues,
      })),
    fallbackSafety: {
      typedNegativeFailures: perCase
        .filter(
          (item) =>
            item.caseId.startsWith("invalid-") ||
            item.caseId.startsWith("provider-"),
        )
        .every((item) => item.pass),
      emptySuccessAccepted: false,
      financialWritesPerformed: 0,
      tenantLeakCount: counters.tenantLeaks,
    },
    liveEvidenceGaps: [...new Set(liveEvidenceGaps)],
    functionalStatus: functionalPass ? "PASS" : "FAIL",
    releaseStatus:
      functionalPass && liveEvidenceGaps.length === 0 ? "PASS" : "GAPS",
  };
}

export function assertReleaseQualified(report: OcrEvalReport): void {
  if (report.releaseStatus !== "PASS")
    throw new Error(
      `OCR release qualification has gaps: ${report.liveEvidenceGaps.join(", ")}`,
    );
}
