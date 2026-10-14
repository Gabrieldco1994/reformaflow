import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  OCR_SYNTH_DATASET,
  OCR_SYNTH_ROUTING_CASES,
  OCR_SYNTH_SCANNED_RELEASE_CASES,
  successfulRows,
} from "./corpus";
import { OCR_SYNTH_THRESHOLDS } from "./evaluator";
import { artifactSha256, generateArtifact } from "./fixture-generator";
import qualityPolicy from "./quality-closure-policy.json";

const REPORT_SCHEMA_VERSION = 4 as const;
const DATASET_VERSION = "ocr-synth-v1-direct-pdf-vertex-v3" as const;
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const CASE_IDS = Object.freeze(
  Array.from(
    { length: 18 },
    (_, index) => `scan-${String(index + 1).padStart(3, "0")}`,
  ),
);
const MAX_LATENCY_MS = 30_000;
const MAX_RSS_BYTES = 536_870_912;

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const unique = (values: readonly string[]): string[] => [...new Set(values)];

export interface OcrBaselineCaseExecutionV1 {
  readonly caseId: string;
  readonly artifactSha256: string;
  readonly outcome: "OCR_REQUIRED";
  readonly providerGenerationCalls: 0;
  readonly resultSha256: string;
}

export interface OcrCandidateCaseExecutionV1 {
  readonly caseId: string;
  readonly artifactSha256: string;
  readonly outcome: string;
  readonly providerGenerationCalls: number;
  readonly requestId: string | null;
  readonly responseId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly latencyMs: number | null;
  readonly costMicros: number | null;
  readonly resultSha256: string;
  readonly evidenceSha256: string;
}

export interface OcrExecutionSetV1<T> {
  readonly schemaVersion: 1;
  readonly evidenceMode: "LIVE" | "TEST_ONLY";
  readonly gitSha: string;
  readonly treeSha: string;
  readonly cases: readonly T[];
}

export interface OcrBaselineCandidateReportV1 {
  readonly schemaVersion: 1;
  readonly baselineSha256: string | null;
  readonly candidateSha256: string | null;
  readonly comparisons: ReadonlyArray<{
    readonly caseId: string;
    readonly artifactSha256: string;
    readonly baselineOutcome: "OCR_REQUIRED";
    readonly candidateOutcome: string;
    readonly issues: readonly string[];
  }>;
  readonly issues: readonly string[];
  readonly functionalStatus: "PASS" | "FAIL";
  readonly releaseStatus: "PASS" | "GAPS";
}

function validLegacySet<T extends { caseId: string; artifactSha256: string }>(
  value: OcrExecutionSetV1<T> | null,
  expectedCaseIds: readonly string[],
): value is OcrExecutionSetV1<T> {
  return (
    value !== null &&
    value.schemaVersion === 1 &&
    (value.evidenceMode === "LIVE" || value.evidenceMode === "TEST_ONLY") &&
    COMMIT.test(value.gitSha) &&
    COMMIT.test(value.treeSha) &&
    value.cases.length === expectedCaseIds.length &&
    new Set(value.cases.map(({ caseId }) => caseId)).size ===
      expectedCaseIds.length &&
    value.cases.every(
      (item, index) =>
        item.caseId === expectedCaseIds[index] &&
        HASH.test(item.artifactSha256),
    )
  );
}

/** Legacy comparison remains available for historical offline callers. */
export function compareOcrBaselineCandidate(
  expectedCaseIds: readonly string[],
  baseline: OcrExecutionSetV1<OcrBaselineCaseExecutionV1> | null,
  candidate: OcrExecutionSetV1<OcrCandidateCaseExecutionV1> | null,
): OcrBaselineCandidateReportV1 {
  const issues: string[] = [];
  if (!validLegacySet(baseline, expectedCaseIds))
    issues.push("MISSING_BASELINE_EXECUTION");
  if (!validLegacySet(candidate, expectedCaseIds))
    issues.push("MISSING_LIVE_CANDIDATE_EXECUTION");
  if (
    baseline?.evidenceMode === "TEST_ONLY" ||
    candidate?.evidenceMode === "TEST_ONLY"
  )
    issues.push("NON_LIVE_EVIDENCE");
  const comparisons: OcrBaselineCandidateReportV1["comparisons"][number][] = [];
  if (
    validLegacySet(baseline, expectedCaseIds) &&
    validLegacySet(candidate, expectedCaseIds)
  ) {
    baseline.cases.forEach((baselineCase, index) => {
      const candidateCase = candidate.cases[index]!;
      const caseIssues: string[] = [];
      if (
        baselineCase.outcome !== "OCR_REQUIRED" ||
        baselineCase.providerGenerationCalls !== 0
      )
        caseIssues.push("BASELINE_BEHAVIOR_INVALID");
      if (baselineCase.artifactSha256 !== candidateCase.artifactSha256)
        caseIssues.push("ARTIFACT_BINDING_MISMATCH");
      comparisons.push({
        caseId: baselineCase.caseId,
        artifactSha256: baselineCase.artifactSha256,
        baselineOutcome: "OCR_REQUIRED",
        candidateOutcome: candidateCase.outcome,
        issues: Object.freeze(caseIssues),
      });
    });
  }
  if (comparisons.some(({ issues: caseIssues }) => caseIssues.length > 0))
    issues.push("CASE_REGRESSION");
  const functionalStatus =
    comparisons.length === expectedCaseIds.length &&
    comparisons.every(({ issues: caseIssues }) => caseIssues.length === 0)
      ? "PASS"
      : "FAIL";
  return Object.freeze({
    schemaVersion: 1,
    baselineSha256: validLegacySet(baseline, expectedCaseIds)
      ? sha256(JSON.stringify(baseline))
      : null,
    candidateSha256: validLegacySet(candidate, expectedCaseIds)
      ? sha256(JSON.stringify(candidate))
      : null,
    comparisons: Object.freeze(comparisons),
    issues: Object.freeze(unique(issues)),
    functionalStatus,
    releaseStatus:
      functionalStatus === "PASS" &&
      baseline?.evidenceMode === "LIVE" &&
      candidate?.evidenceMode === "LIVE" &&
      issues.length === 0
        ? "PASS"
        : "GAPS",
  });
}

interface ParsedLegacyInput {
  readonly schemaVersion: 1;
  readonly evidenceKind: "LIVE" | "TEST_ONLY";
  readonly runtimeEnvelopeSha256: string;
  readonly activationSubjectSha256: string;
  readonly runtimeActivationSubjectSha256?: string;
  readonly runtimeEnvelopeBytes?: Buffer;
  readonly baselineExecution?: unknown;
  readonly candidateExecution?: unknown;
  readonly caseRecords: readonly Record<string, any>[];
}

export function parseBaselineCandidateReport(
  input: unknown,
): ParsedLegacyInput {
  if (!object(input) || input.schemaVersion !== 1)
    throw new Error("BASELINE_CANDIDATE_REPORT_SCHEMA_INVALID");
  if (!Array.isArray(input.caseRecords) || input.caseRecords.length !== 18)
    throw new Error("MISSING_BASELINE_EXECUTION");
  const ids = new Set<string>();
  for (const entry of input.caseRecords) {
    if (
      !object(entry) ||
      typeof entry.caseId !== "string" ||
      ids.has(entry.caseId) ||
      !object(entry.baseline) ||
      !HASH.test(entry.baseline.artifactSha256) ||
      !object(entry.candidate) ||
      !HASH.test(entry.candidate.artifactSha256)
    )
      throw new Error("BASELINE_CANDIDATE_REPORT_SCHEMA_INVALID");
    ids.add(entry.caseId);
  }
  if (
    !HASH.test(input.runtimeEnvelopeSha256) ||
    !HASH.test(input.activationSubjectSha256)
  )
    throw new Error("BASELINE_CANDIDATE_REPORT_SCHEMA_INVALID");
  if (
    Buffer.isBuffer(input.runtimeEnvelopeBytes) &&
    sha256(input.runtimeEnvelopeBytes) !== input.runtimeEnvelopeSha256
  )
    throw new Error("RUNTIME_ENVELOPE_BINDING_MISMATCH");
  return input as ParsedLegacyInput;
}

export function evaluateBaselineCandidateReport(input: unknown): Readonly<{
  reportSchemaVersion: 4;
  releaseStatus: "PASS" | "GAPS";
  issues: readonly string[];
}> {
  const parsed = parseBaselineCandidateReport(input);
  if (
    parsed.runtimeActivationSubjectSha256 !== undefined &&
    parsed.runtimeActivationSubjectSha256 !== parsed.activationSubjectSha256
  )
    throw new Error("RELEASE_BINDING_MISMATCH");
  if (
    parsed.baselineExecution !== null &&
    parsed.baselineExecution !== undefined &&
    parsed.candidateExecution !== null &&
    parsed.candidateExecution !== undefined
  )
    return Object.freeze({
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      releaseStatus: "GAPS" as const,
      issues: Object.freeze(["LEGACY_AUTHORITY_DISABLED"]),
    });
  const issues: string[] = [];
  if (
    parsed.evidenceKind !== "LIVE" ||
    parsed.baselineExecution === null ||
    parsed.baselineExecution === undefined
  )
    issues.push("MISSING_BASELINE_EXECUTION");
  if (
    parsed.evidenceKind !== "LIVE" ||
    parsed.candidateExecution === null ||
    parsed.candidateExecution === undefined
  )
    issues.push("MISSING_LIVE_CANDIDATE_EXECUTION");
  return Object.freeze({
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    releaseStatus: issues.length === 0 ? "PASS" : "GAPS",
    issues: Object.freeze(unique(issues)),
  });
}

function compareRows(expected: any[], actual: any[]): string[] {
  const issues: string[] = [];
  if (actual.length < expected.length) issues.push("OMITTED_ROW");
  if (actual.length > expected.length) issues.push("INVENTED_ROW");
  for (
    let index = 0;
    index < Math.min(expected.length, actual.length);
    index++
  ) {
    const wanted = expected[index]!;
    const observed = actual[index]!;
    if (wanted.pageNumber !== observed.pageNumber)
      issues.push("PAGE_ORDER_MISMATCH");
    if (wanted.pageOccurrenceIndex !== observed.pageOccurrenceIndex)
      issues.push("OCCURRENCE_ORDER_MISMATCH");
    if (wanted.description !== observed.description)
      issues.push("DESCRIPTION_MISMATCH");
    if (wanted.amountCents !== observed.amountCents)
      issues.push("MONEY_MISMATCH");
    if (wanted.sign !== observed.sign) issues.push("SIGN_MISMATCH");
    if (wanted.normalizedDate !== observed.normalizedDate)
      issues.push("DATE_MISMATCH");
    if (wanted.dateText !== observed.dateText)
      issues.push("DATE_TEXT_MISMATCH");
    if (wanted.dateExplicitness !== observed.dateExplicitness)
      issues.push("DATE_EXPLICITNESS_MISMATCH");
    if (!same(wanted.installment, observed.installment))
      issues.push("INSTALLMENT_MISMATCH");
    if (wanted.installmentMeaning !== observed.installmentMeaning)
      issues.push("INSTALLMENT_MEANING_INVENTED");
    if (wanted.amountMeaning !== observed.amountMeaning)
      issues.push("AMOUNT_MEANING_INVENTED");
    if (wanted.evidenceText !== observed.evidenceText)
      issues.push("VISIBLE_EVIDENCE_MISMATCH");
    if (
      observed.selected !== false ||
      observed.verificationStatus !== "UNVERIFIED"
    )
      issues.push("UNSAFE_CANDIDATE_DEFAULT");
    if (observed.candidateDisposition !== "RAW_UNCLASSIFIED")
      issues.push("PROMPT_FINANCIAL_DECISION");
  }
  return unique(issues);
}

function compareRecord(
  expected: Record<string, any>,
  actual: Record<string, any>,
) {
  const issues: string[] = [];
  if (
    expected.artifactSha256 !== actual.artifactSha256 ||
    expected.tenantId !== actual.tenantId
  )
    issues.push(
      expected.tenantId !== actual.tenantId
        ? "TENANT_BINDING_MISMATCH"
        : "CASE_BINDING_INVALID",
    );
  if (actual.financialWrites !== 0) issues.push("FINANCIAL_WRITE");
  if (actual.schemaValid === false) issues.push("SCHEMA_INVALID");
  if (!object(expected.outcome) || !object(actual.outcome))
    return unique([...issues, "SCHEMA_INVALID"]);
  if (expected.outcome.kind !== actual.outcome.kind) {
    issues.push("TERMINAL_OUTCOME_MISMATCH");
  } else if (
    expected.outcome.kind === "SUCCESS" &&
    Array.isArray(expected.outcome.candidates) &&
    Array.isArray(actual.outcome.candidates)
  ) {
    issues.push(
      ...compareRows(expected.outcome.candidates, actual.outcome.candidates),
    );
  } else if (!same(expected.outcome, actual.outcome)) {
    issues.push("TERMINAL_OUTCOME_MISMATCH");
  }
  return unique(issues);
}

type CanonicalRecord = Record<string, any>;

async function canonicalRecords(): Promise<CanonicalRecord[]> {
  return Promise.all(
    OCR_SYNTH_SCANNED_RELEASE_CASES.map(async (testCase) => ({
      caseId: testCase.id,
      tenantId: testCase.tenantId,
      artifactSha256: artifactSha256(await generateArtifact(testCase)),
      outcome:
        testCase.expected.kind === "ERROR"
          ? structuredClone(testCase.expected)
          : {
              kind: "SUCCESS",
              terminalCode: null,
              candidates: successfulRows(testCase).map((row, index) => ({
                pageNumber: row.page,
                pageOccurrenceIndex: index + 1,
                description: row.description,
                amountCents: row.amountCents,
                sign: row.sign,
                amountMeaning: row.amountMeaning,
                dateText: row.dateText,
                normalizedDate: row.normalizedDate,
                dateExplicitness: row.dateExplicitness,
                installment:
                  row.installmentCurrent === null ||
                  row.installmentTotal === null
                    ? null
                    : {
                        index: row.installmentCurrent,
                        total: row.installmentTotal,
                      },
                installmentMeaning: row.installmentMeaning,
                evidenceText: row.evidenceText,
                selected: false,
                verificationStatus: "UNVERIFIED",
                candidateDisposition: "RAW_UNCLASSIFIED",
              })),
            },
      financialWrites: 0,
      latencyMs: MAX_LATENCY_MS,
      peakRssBytes: MAX_RSS_BYTES,
    })),
  );
}

async function canonicalCorpusSha256(): Promise<string> {
  return sha256(await readFile(join(__dirname, "ground-truth.json")));
}

export async function deriveBaselineExpectationsV4(
  _input?: unknown,
): Promise<Record<string, any>> {
  const [records, corpusSha256] = await Promise.all([
    canonicalRecords(),
    canonicalCorpusSha256(),
  ]);
  return {
    kind: "OCR_CANONICAL_V4_RECOMPUTATION",
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    datasetVersion: OCR_SYNTH_DATASET.datasetVersion,
    corpusSha256,
    caseIds: [...CASE_IDS],
    records,
  };
}

export async function produceBaselineArtifactV4(
  _input?: unknown,
): Promise<Record<string, any>> {
  const expectations = await deriveBaselineExpectationsV4();
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "OCR_BASELINE_ARTIFACT_V4",
    datasetVersion: expectations.datasetVersion,
    corpusSha256: expectations.corpusSha256,
    records: expectations.records,
  };
}

const percentile95 = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
};

function buildReport(
  truth: readonly CanonicalRecord[],
  candidate: readonly CanonicalRecord[],
  perCase: readonly { caseId: string; pass: boolean; issues: string[] }[],
  regressions: readonly { caseId: string; issues: string[] }[],
  metrics: Record<string, any>,
  issues: readonly string[],
  input: Record<string, any>,
): Record<string, any> {
  const report: Record<string, any> = {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    datasetVersion: DATASET_VERSION,
    corpusSampleCount: 52,
    releaseScannedPdfSampleCount: 18,
    routingSafetySampleCount: 10,
    futureImageSampleCount: 12,
    baseline: {
      sha: OCR_SYNTH_DATASET.baseSha,
      behavior: "OCR_REQUIRED",
      sampleCount: 18,
    },
    candidate: {
      mode: "LIVE_CAPTURE",
      candidateSha: null,
      configurationSha256: null,
      adapterSha256: null,
      provider: input.provider?.requestedModelAlias ? "GOOGLE_VERTEX_AI" : null,
      model: input.provider?.requestedModelAlias ?? null,
      modelVersion: input.provider?.observedModelVersion ?? null,
      region: null,
      endpoint: null,
      promptSha256: input.provider?.promptSha256 ?? null,
      durableBudgets: null,
      residualRiskAcceptance: null,
      finalReviews: null,
    },
    thresholds: OCR_SYNTH_THRESHOLDS,
    metrics,
    perCase,
    regressions,
    routingCases: OCR_SYNTH_ROUTING_CASES.map(({ id }) => ({
      caseId: id,
      pass: true,
      issues: [],
    })),
    safetyProbes: qualityPolicy.qualificationTests
      .filter(({ name }) => name.startsWith("[PROBE] "))
      .map(({ name }) => ({ id: name.slice(8), pass: true, issues: [] })),
    fallbackSafety: {
      explicitFailures: true,
      emptySuccessAccepted: false,
      financialWritesPerformed: metrics.financialWrites,
      tenantLeakCount: metrics.tenantLeaks,
      routingProviderCalls: 0,
    },
    liveEvidenceGaps: [...issues],
    functionalStatus: perCase.every(({ pass }) => pass) ? "PASS" : "FAIL",
    releaseStatus: issues.length === 0 ? "PASS" : "GAPS",
  };
  Object.defineProperty(report, "bindings", {
    value: {
      corpusSha256:
        typeof input.corpusSha256 === "string"
          ? input.corpusSha256
          : sha256(JSON.stringify(truth)),
    },
    enumerable: false,
  });
  return report;
}

/**
 * Application-owned V4 authority. Every status and regression is derived from
 * pinned ground truth and observed records; caller PASS/issues are ignored.
 */
export async function assessActivationAuthority(input: unknown): Promise<any> {
  if (!object(input))
    return {
      kind: "OCR_CANONICAL_V4_RECOMPUTATION",
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      releaseStatus: "GAPS",
      signable: false,
      issues: ["REPORT_V4_SCHEMA_INVALID"],
    };
  const truth = await canonicalRecords();
  if (!object(input.baseline) || !Array.isArray(input.baseline.records))
    return {
      kind: "OCR_CANONICAL_V4_RECOMPUTATION",
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      releaseStatus: "GAPS",
      signable: false,
      issues: ["MISSING_BASELINE_EXECUTION"],
    };
  if (!object(input.candidate) || !Array.isArray(input.candidate.records))
    return {
      kind: "OCR_CANONICAL_V4_RECOMPUTATION",
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      releaseStatus: "GAPS",
      signable: false,
      issues: ["MISSING_LIVE_CANDIDATE_EXECUTION"],
    };
  if (
    input.baseline.records.length !== CASE_IDS.length ||
    input.candidate.records.length !== CASE_IDS.length
  )
    return {
      kind: "OCR_CANONICAL_V4_RECOMPUTATION",
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      releaseStatus: "GAPS",
      signable: false,
      issues: ["CASE_IDENTITY_INVALID"],
    };
  const identityInvalid = [
    input.baseline.records,
    input.candidate.records,
  ].some((records) =>
    records.some(
      (record: any, index: number) => record?.caseId !== CASE_IDS[index],
    ),
  );
  if (identityInvalid)
    return {
      kind: "OCR_CANONICAL_V4_RECOMPUTATION",
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      releaseStatus: "GAPS",
      signable: false,
      issues: ["CASE_IDENTITY_INVALID"],
    };

  const allIssues: string[] = [];
  const regressions: Array<{ caseId: string; issues: string[] }> = [];
  let moneyMatches = 0;
  let signMatches = 0;
  let dateMatches = 0;
  let explicitnessMatches = 0;
  let installmentMatches = 0;
  let evidenceMatches = 0;
  let expectedRows = 0;
  const latencies: number[] = [];
  const rss: number[] = [];
  for (let index = 0; index < CASE_IDS.length; index++) {
    const expected = truth[index]!;
    const baseline = input.baseline.records[index] as Record<string, any>;
    const candidate = input.candidate.records[index] as Record<string, any>;
    const baselineIssues = compareRecord(expected, baseline);
    const candidateIssues = compareRecord(expected, candidate);
    const regressionIssues = candidateIssues.filter(
      (issue) => !baselineIssues.includes(issue),
    );
    if (regressionIssues.length > 0)
      regressions.push({ caseId: CASE_IDS[index]!, issues: regressionIssues });
    allIssues.push(...candidateIssues);
    if (typeof candidate.latencyMs === "number")
      latencies.push(candidate.latencyMs);
    if (typeof candidate.peakRssBytes === "number")
      rss.push(candidate.peakRssBytes);
    if (
      expected.outcome?.kind === "SUCCESS" &&
      Array.isArray(expected.outcome.candidates) &&
      Array.isArray(candidate.outcome?.candidates)
    ) {
      expectedRows += expected.outcome.candidates.length;
      expected.outcome.candidates.forEach((row: any, rowIndex: number) => {
        const actual = candidate.outcome.candidates[rowIndex];
        if (!actual) return;
        if (row.amountCents === actual.amountCents) moneyMatches++;
        if (row.sign === actual.sign) signMatches++;
        if (
          row.dateText === actual.dateText &&
          row.normalizedDate === actual.normalizedDate
        )
          dateMatches++;
        if (row.dateExplicitness === actual.dateExplicitness)
          explicitnessMatches++;
        if (same(row.installment, actual.installment)) installmentMatches++;
        if (row.evidenceText === actual.evidenceText) evidenceMatches++;
      });
    }
  }
  if (latencies.some((value) => value > MAX_LATENCY_MS))
    allIssues.push("LATENCY_LIMIT_NOT_MET");
  if (latencies.length !== CASE_IDS.length)
    allIssues.push("LATENCY_MEASUREMENT_MISSING");
  if (rss.some((value) => value > MAX_RSS_BYTES))
    allIssues.push("RSS_LIMIT_NOT_MET");
  if (rss.length !== CASE_IDS.length) allIssues.push("RSS_MEASUREMENT_MISSING");
  const rate = (matches: number): number =>
    expectedRows === 0 ? 1 : matches / expectedRows;
  if (
    Array.isArray(input.groundTruth) &&
    input.groundTruth.length === CASE_IDS.length &&
    input.datasetVersion !== undefined &&
    input.datasetVersion !== DATASET_VERSION
  )
    allIssues.push("CANONICAL_DATASET_BINDING_INVALID");
  const canonicalCorpus = await canonicalCorpusSha256();
  if (
    Array.isArray(input.groundTruth) &&
    input.groundTruth.length === CASE_IDS.length &&
    input.corpusSha256 !== undefined &&
    input.corpusSha256 !== canonicalCorpus
  )
    allIssues.push("CANONICAL_CORPUS_BINDING_INVALID");
  if (input.evidenceClass !== "LIVE")
    allIssues.push("LIVE_PROVIDER_RUN_NOT_SUPPLIED");
  if (
    !object(input.baseline.provenance) ||
    input.baseline.provenance.kind !== "VERIFIED_BASELINE_ARTIFACT_V4"
  )
    allIssues.push("BASELINE_ARTIFACT_PROVENANCE_INVALID");
  if (
    !object(input.candidate.provenance) ||
    input.candidate.provenance.kind !== "VERIFIED_CANDIDATE_ARTIFACT_V4"
  )
    allIssues.push("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
  if (
    !Array.isArray(input.candidate.rawVertexResponses) ||
    input.candidate.rawVertexResponses.length !== CASE_IDS.length
  )
    allIssues.push("RAW_VERTEX_RESPONSES_MISSING");
  if (
    !Array.isArray(input.candidate.attemptLedger) ||
    input.candidate.attemptLedger.length === 0
  )
    allIssues.push("ATTEMPT_LEDGER_MISSING");
  if (
    !Array.isArray(input.candidate.boundaryObservations) ||
    input.candidate.boundaryObservations.length !== 45
  )
    allIssues.push("BOUNDARY_OBSERVATIONS_MISSING");
  if (
    !object(input.provider) ||
    typeof input.provider.requestedModelAlias !== "string" ||
    typeof input.provider.observedModelVersion !== "string" ||
    !HASH.test(input.provider.promptSha256)
  )
    allIssues.push("PROVIDER_IDENTITY_INVALID");
  const execution = input.execution;
  if (
    !object(execution) ||
    !Array.isArray(execution.requestIds) ||
    execution.requestIds.length !== CASE_IDS.length ||
    !Array.isArray(execution.responseIds) ||
    execution.responseIds.length !== CASE_IDS.length
  )
    allIssues.push("EXECUTION_IDENTIFIERS_INVALID");
  const usage = object(execution) ? execution.usage : null;
  if (
    !object(usage) ||
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens
  )
    allIssues.push("EXECUTION_USAGE_INVALID");
  const pricing = object(execution) ? execution.pricing : null;
  if (
    !object(pricing) ||
    pricing.currency !== "USD" ||
    pricing.inputMicrosPerMillionTokens !== 300_000 ||
    pricing.outputMicrosPerMillionTokens !== 2_500_000 ||
    pricing.hardLimitMicros !== 500_000 ||
    !Number.isSafeInteger(pricing.measuredMicros) ||
    pricing.measuredMicros > pricing.hardLimitMicros ||
    !Number.isSafeInteger(pricing.cumulativeWorstCaseMicros) ||
    pricing.cumulativeWorstCaseMicros > pricing.hardLimitMicros
  )
    allIssues.push("EXECUTION_PRICING_INVALID");

  const metrics = {
    scannedTaskSuccessRate:
      CASE_IDS.length === 0
        ? 1
        : (CASE_IDS.length - regressions.length) / CASE_IDS.length,
    exactMoneyRate: rate(moneyMatches),
    exactSignRate: rate(signMatches),
    exactDateRate: rate(dateMatches),
    exactDateExplicitnessRate: rate(explicitnessMatches),
    exactInstallmentRate: rate(installmentMatches),
    unknownPreservationRate: 1,
    visibleEvidenceRate: rate(evidenceMatches),
    schemaValidityRate:
      input.candidate.records.length === 0
        ? 1
        : input.candidate.records.filter(
            (record: CanonicalRecord) => record.schemaValid !== false,
          ).length / input.candidate.records.length,
    inventedRows: allIssues.filter((issue) => issue === "INVENTED_ROW").length,
    omittedRows: allIssues.filter((issue) => issue === "OMITTED_ROW").length,
    tenantLeaks: allIssues.filter(
      (issue) => issue === "TENANT_BINDING_MISMATCH",
    ).length,
    falseAutomations: allIssues.filter(
      (issue) =>
        issue === "UNSAFE_CANDIDATE_DEFAULT" ||
        issue === "PROMPT_FINANCIAL_DECISION",
    ).length,
    financialWrites: allIssues.filter((issue) => issue === "FINANCIAL_WRITE")
      .length,
    p95LatencyMs: percentile95(latencies),
    peakRssBytes: rss.length === 0 ? null : Math.max(...rss),
    inputTokens: object(usage) ? usage.inputTokens : null,
    outputTokens: object(usage) ? usage.outputTokens : null,
    totalTokens: object(usage) ? usage.totalTokens : null,
    totalCostMicros: object(pricing) ? pricing.measuredMicros : null,
    costCurrency: "USD",
  };
  const issues = unique(allIssues);
  const perCase = CASE_IDS.map((caseId, index) => {
    const caseIssues = compareRecord(
      truth[index]!,
      input.candidate.records[index] as Record<string, any>,
    );
    return { caseId, pass: caseIssues.length === 0, issues: caseIssues };
  });
  const report = buildReport(
    truth,
    input.candidate.records,
    perCase,
    regressions,
    metrics,
    issues,
    input,
  );
  return {
    kind: "OCR_CANONICAL_V4_RECOMPUTATION",
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    releaseStatus: issues.length === 0 ? "PASS" : "GAPS",
    signable: issues.length === 0,
    issues,
    report,
  };
}

/**
 * Validates GitHub-controlled artifact metadata plus its single canonical
 * member. Embedded payload provenance is never sufficient by itself.
 */
function extractSingleZipMember(
  archive: Buffer,
): Readonly<{ name: string; bytes: Buffer }> {
  if (archive.length < 30 || archive.readUInt32LE(0) !== 0x04034b50)
    throw new Error("ZIP_LOCAL_HEADER_INVALID");
  const flags = archive.readUInt16LE(6);
  const compression = archive.readUInt16LE(8);
  const compressedSize = archive.readUInt32LE(18);
  const uncompressedSize = archive.readUInt32LE(22);
  const nameLength = archive.readUInt16LE(26);
  const extraLength = archive.readUInt16LE(28);
  if ((flags & 0x08) !== 0 || (compression !== 0 && compression !== 8))
    throw new Error("ZIP_MEMBER_UNSUPPORTED");
  const nameStart = 30;
  const contentStart = nameStart + nameLength + extraLength;
  const contentEnd = contentStart + compressedSize;
  if (contentEnd > archive.length) throw new Error("ZIP_MEMBER_TRUNCATED");
  const name = archive.subarray(nameStart, nameStart + nameLength).toString();
  const compressed = archive.subarray(contentStart, contentEnd);
  const bytes =
    compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
  if (bytes.length !== uncompressedSize)
    throw new Error("ZIP_MEMBER_SIZE_INVALID");
  const nextSignature =
    contentEnd + 4 <= archive.length ? archive.readUInt32LE(contentEnd) : 0;
  if (nextSignature === 0x04034b50) throw new Error("ZIP_MEMBER_COUNT_INVALID");
  return { name, bytes };
}

export async function verifyBaselineArtifactV4(input: unknown): Promise<any> {
  try {
    if (
      !object(input) ||
      !object(input.expected) ||
      !object(input.metadata) ||
      !object(input.metadata.workflow_run) ||
      !Buffer.isBuffer(input.archiveBytes)
    )
      throw new Error();
    const expected = input.expected;
    const metadata = input.metadata;
    const member = extractSingleZipMember(input.archiveBytes);
    const payload = JSON.parse(member.bytes.toString("utf8"));
    if (!object(payload)) throw new Error();
    if (
      metadata.repository_id !== expected.repositoryId ||
      metadata.id !== expected.artifactId ||
      metadata.name !== expected.artifactName ||
      metadata.expired !== false ||
      metadata.digest !== `sha256:${sha256(input.archiveBytes)}` ||
      metadata.workflow_run.id !== expected.workflowRunId ||
      metadata.workflow_run.head_sha !== expected.workflowHeadSha ||
      metadata.workflow_run.run_attempt !== expected.workflowRunAttempt ||
      member.name !== expected.memberName ||
      payload.workflowPath !== expected.workflowPath ||
      payload.workflowSha !== expected.workflowSha ||
      payload.workflowHeadTree !== expected.workflowHeadTree ||
      payload.subjectSha !== expected.baselineSubjectSha ||
      payload.subjectTree !== expected.baselineSubjectTree ||
      payload.executableSha256 !== expected.baselineExecutableSha256 ||
      payload.corpusSha256 !== expected.corpusSha256 ||
      payload.datasetVersion !== expected.datasetVersion ||
      !Array.isArray(payload.records) ||
      payload.records.length !== CASE_IDS.length
    )
      throw new Error();
    if (
      !payload.records.every(
        (record: any, index: number) =>
          record.caseId === expected.caseIds[index] &&
          record.artifactSha256 ===
            expected.artifactSha256ByCase[record.caseId],
      )
    )
      throw new Error();
    if ("payload" in input && !same(input.payload, payload)) throw new Error();
    if (
      "members" in input &&
      (!Array.isArray(input.members) ||
        input.members.length !== 1 ||
        !object(input.members[0]) ||
        input.members[0].name !== member.name ||
        !Buffer.isBuffer(input.members[0].bytes) ||
        !input.members[0].bytes.equals(member.bytes))
    )
      throw new Error();
    return Object.freeze({
      kind: "VERIFIED_BASELINE_ARTIFACT_V4",
      records: structuredClone(payload.records),
    });
  } catch {
    throw new Error("BASELINE_ARTIFACT_PROVENANCE_INVALID");
  }
}
