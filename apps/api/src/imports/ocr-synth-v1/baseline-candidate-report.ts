import { createHash } from "node:crypto";

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
    if (wanted.amountCents !== observed.amountCents)
      issues.push("MONEY_MISMATCH");
    if (wanted.sign !== observed.sign) issues.push("SIGN_MISMATCH");
    if (
      wanted.rawDate !== observed.rawDate ||
      wanted.normalizedDate !== observed.normalizedDate
    )
      issues.push("DATE_MISMATCH");
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
  if (!object(expected.outcome) || !object(actual.outcome))
    return unique([...issues, "SCHEMA_INVALID"]);
  if (expected.outcome.kind !== actual.outcome.kind) {
    issues.push("OUTCOME_MISMATCH");
  } else if (
    expected.outcome.kind === "SUCCESS" &&
    Array.isArray(expected.outcome.candidates) &&
    Array.isArray(actual.outcome.candidates)
  ) {
    issues.push(
      ...compareRows(expected.outcome.candidates, actual.outcome.candidates),
    );
  } else if (!same(expected.outcome, actual.outcome)) {
    issues.push("OUTCOME_MISMATCH");
  }
  return unique(issues);
}

function emptyAuthorityReport(datasetVersion: string, corpusSha256: string) {
  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    datasetVersion,
    bindings: { corpusSha256 },
    regressions: [] as Array<{ caseId: string; issues: string[] }>,
    metrics: {
      exactMoneyRate: 1,
      exactSignRate: 1,
      exactDateRate: 1,
      exactDateExplicitnessRate: 1,
      exactInstallmentRate: 1,
      visibleEvidenceRate: 1,
      inventedRows: 0,
      omittedRows: 0,
      tenantLeaks: 0,
      falseAutomations: 0,
      financialWrites: 0,
      p95LatencyMs: null as number | null,
      peakRssBytes: null as number | null,
    },
  };
}

/**
 * Application-owned V4 authority. Every status and regression is derived from
 * pinned ground truth and observed records; caller PASS/issues are ignored.
 */
export async function assessActivationAuthority(input: unknown): Promise<any> {
  if (!object(input))
    return {
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      releaseStatus: "GAPS",
      signable: false,
      issues: ["REPORT_V4_SCHEMA_INVALID"],
    };
  const datasetVersion =
    typeof input.datasetVersion === "string"
      ? input.datasetVersion
      : DATASET_VERSION;
  const corpusSha256 =
    typeof input.corpusSha256 === "string" ? input.corpusSha256 : "";
  const report = emptyAuthorityReport(datasetVersion, corpusSha256);
  if (!object(input.baseline) || !Array.isArray(input.baseline.records))
    return {
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      releaseStatus: "GAPS",
      signable: false,
      issues: ["MISSING_BASELINE_EXECUTION"],
      report,
    };
  if (!object(input.candidate) || !Array.isArray(input.candidate.records))
    return {
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      releaseStatus: "GAPS",
      signable: false,
      issues: ["MISSING_LIVE_CANDIDATE_EXECUTION"],
      report,
    };
  if (
    !Array.isArray(input.groundTruth) ||
    input.groundTruth.length !== CASE_IDS.length ||
    input.baseline.records.length !== CASE_IDS.length ||
    input.candidate.records.length !== CASE_IDS.length
  )
    return {
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      releaseStatus: "GAPS",
      signable: false,
      issues: ["CASE_IDENTITY_INVALID"],
      report,
    };
  const identityInvalid = [
    input.groundTruth,
    input.baseline.records,
    input.candidate.records,
  ].some((records) =>
    records.some(
      (record: any, index: number) => record?.caseId !== CASE_IDS[index],
    ),
  );
  if (identityInvalid)
    return {
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      releaseStatus: "GAPS",
      signable: false,
      issues: ["CASE_IDENTITY_INVALID"],
      report,
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
    const truth = input.groundTruth[index] as Record<string, any>;
    const baseline = input.baseline.records[index] as Record<string, any>;
    const candidate = input.candidate.records[index] as Record<string, any>;
    const baselineIssues = compareRecord(truth, baseline);
    const candidateIssues = compareRecord(truth, candidate);
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
      truth.outcome?.kind === "SUCCESS" &&
      Array.isArray(truth.outcome.candidates) &&
      Array.isArray(candidate.outcome?.candidates)
    ) {
      expectedRows += truth.outcome.candidates.length;
      truth.outcome.candidates.forEach((row: any, rowIndex: number) => {
        const actual = candidate.outcome.candidates[rowIndex];
        if (!actual) return;
        if (row.amountCents === actual.amountCents) moneyMatches++;
        if (row.sign === actual.sign) signMatches++;
        if (
          row.rawDate === actual.rawDate &&
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
  if (rss.some((value) => value > MAX_RSS_BYTES))
    allIssues.push("RSS_LIMIT_NOT_MET");
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const p95 =
    sortedLatencies.length === 0
      ? null
      : sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1]!;
  const rate = (matches: number): number =>
    expectedRows === 0 ? 1 : matches / expectedRows;
  report.regressions = regressions;
  report.metrics = {
    ...report.metrics,
    exactMoneyRate: rate(moneyMatches),
    exactSignRate: rate(signMatches),
    exactDateRate: rate(dateMatches),
    exactDateExplicitnessRate: rate(explicitnessMatches),
    exactInstallmentRate: rate(installmentMatches),
    visibleEvidenceRate: rate(evidenceMatches),
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
    p95LatencyMs: p95,
    peakRssBytes: rss.length === 0 ? null : Math.max(...rss),
  };
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
  if (!Array.isArray(input.candidate.rawVertexResponses))
    allIssues.push("MISSING_RAW_VERTEX_RESPONSE_BYTES");
  if (!Array.isArray(input.candidate.attemptLedger))
    allIssues.push("MISSING_LIVE_ATTEMPT_LEDGER");
  if (!Array.isArray(input.candidate.boundaryObservations))
    allIssues.push("MISSING_LIVE_BOUNDARY_OBSERVATIONS");
  const issues = unique(allIssues);
  return {
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
export async function verifyBaselineArtifactV4(input: unknown): Promise<any> {
  try {
    if (
      !object(input) ||
      !object(input.expected) ||
      !object(input.metadata) ||
      !object(input.metadata.workflow_run) ||
      !Buffer.isBuffer(input.archiveBytes) ||
      !Array.isArray(input.members) ||
      input.members.length !== 1 ||
      !object(input.members[0]) ||
      !Buffer.isBuffer(input.members[0].bytes) ||
      !object(input.payload)
    )
      throw new Error();
    const expected = input.expected;
    const metadata = input.metadata;
    const payload = input.payload;
    if (
      metadata.id !== expected.artifactId ||
      metadata.name !== expected.artifactName ||
      metadata.expired !== false ||
      metadata.digest !== `sha256:${sha256(input.archiveBytes)}` ||
      metadata.workflow_run.id !== expected.workflowRunId ||
      metadata.workflow_run.head_sha !== expected.workflowHeadSha ||
      input.members[0].name !== expected.memberName ||
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
    const member = JSON.parse(input.members[0].bytes.toString("utf8"));
    if (
      member.datasetVersion !== payload.datasetVersion ||
      member.corpusSha256 !== payload.corpusSha256 ||
      !same(member.records, payload.records) ||
      !payload.records.every(
        (record: any, index: number) =>
          record.caseId === expected.caseIds[index] &&
          record.artifactSha256 ===
            expected.artifactSha256ByCase[record.caseId],
      )
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
