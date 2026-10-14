#!/usr/bin/env node
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  parseStrictJson,
  sha256,
  prepareRuntimeReleaseDraft,
} from "../../scripts/ci/ocr-attestation.mjs";

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DECIMAL_ID = /^[1-9][0-9]*$/;
const WORKFLOW = ".github/workflows/ocr-qualification.yml";
const REPOSITORY = "Gabrieldco1994/reformaflow";
const PERSISTED = "PERSISTED_WORKFLOW_ARTIFACT";
const TABLES = Object.freeze([
  "Expense",
  "CashFlowEntry",
  "Receipt",
  "RateioAllocation",
  "Settlement",
  "InvoiceLiquidation",
]);
const ROUTES = Object.freeze(
  Array.from(
    { length: 10 },
    (_, index) => "mixed-" + String(index + 1).padStart(3, "0"),
  ),
);
const PROBES = Object.freeze([
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
  "EXACT_CONSENT_CAPABILITY",
  "SELECTED_TRUE_DEFAULT",
  "VERIFIED_DEFAULT",
  "MISSING_CONSENT",
  "MISSING_ATTESTATION",
  "FINANCIAL_WRITE",
  "KNOWN_SAFETY_FINISH_REASONS",
  "TERMINAL_FAILURE_REPLAY_NO_CALL",
  "CAPABILITY_OFF",
  "PRIOR_CONSENT_DECLARATION",
  "RESIDUAL_RISK_ACCEPTANCE",
]);
const OUTCOME_MAP = Object.freeze({
  SUCCEEDED: "SUCCESS",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  AUTH: "OCR_UNAVAILABLE",
  CONFIG: "OCR_UNAVAILABLE",
  NOT_DISPATCHED: "OCR_UNAVAILABLE",
  DOCUMENT_UNREADABLE: "DOCUMENT_UNREADABLE",
  SAFETY: "OCR_SAFETY_BLOCKED",
  MALFORMED_RESPONSE: "OCR_MALFORMED_RESPONSE",
});

function fail(code) {
  throw new Error(code);
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value, keys, code = "REPORT_V4_SCHEMA_INVALID") {
  if (
    !object(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    fail(code);
  return value;
}
function nonempty(value, code = "REPORT_V4_SCHEMA_INVALID") {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 192 ||
    value !== value.normalize("NFC")
  )
    fail(code);
  return value;
}
function integer(value, code = "REPORT_V4_SCHEMA_INVALID") {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
    fail(code);
  return value;
}
function match(value, pattern, code = "REPORT_V4_SCHEMA_INVALID") {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}
function same(left, right) {
  return canonicalize(left) === canonicalize(right);
}
function add(issues, code) {
  issues.add(code);
}
function sorted(issues) {
  return [...issues].sort();
}

async function bounded(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > 64 * 1024 * 1024
    )
      fail("UNSIGNED_INPUT_INVALID");
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.size) fail("UNSIGNED_INPUT_CHANGED");
    return bytes;
  } finally {
    await handle.close();
  }
}
function decode(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    fail("UNSIGNED_INPUT_INVALID");
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > 64 * 1024 * 1024 ||
    bytes.toString("base64") !== value
  )
    fail("UNSIGNED_INPUT_INVALID");
  return bytes;
}

export function admitCumulativeSpend(
  spentBeforeMicros,
  currentWorstCaseMicros,
  hardLimitMicros = 500000,
) {
  integer(spentBeforeMicros, "SPEND_GUARD_INVALID");
  integer(currentWorstCaseMicros, "SPEND_GUARD_INVALID");
  integer(hardLimitMicros, "SPEND_GUARD_INVALID");
  const total = spentBeforeMicros + currentWorstCaseMicros;
  if (!Number.isSafeInteger(total)) fail("SPEND_GUARD_INVALID");
  return Object.freeze({
    status: total <= hardLimitMicros ? "ADMITTED" : "CAPTURE_SPEND_LIMIT",
    cumulativeWorstCaseMicros: total,
  });
}

function validateProvenance(value, records, payload, candidate) {
  exact(value, [
    "evidenceClass",
    "executionKind",
    "repository",
    "workflowPath",
    "workflowSha",
    "runId",
    "runAttempt",
    "subjectSha",
    "subjectTree",
    "corpusSha256",
    "artifactId",
    "artifactSha256",
  ]);
  if (
    value.evidenceClass !== "LIVE" ||
    value.executionKind !== PERSISTED ||
    value.repository !== REPOSITORY ||
    value.workflowPath !== WORKFLOW
  )
    fail("EXECUTION_PROVENANCE_INVALID");
  match(value.workflowSha, COMMIT, "EXECUTION_PROVENANCE_INVALID");
  match(value.runId, DECIMAL_ID, "EXECUTION_PROVENANCE_INVALID");
  integer(value.runAttempt, "EXECUTION_PROVENANCE_INVALID");
  if (value.runAttempt < 1) fail("EXECUTION_PROVENANCE_INVALID");
  match(value.subjectSha, COMMIT, "EXECUTION_PROVENANCE_INVALID");
  match(value.subjectTree, COMMIT, "EXECUTION_PROVENANCE_INVALID");
  match(value.corpusSha256, HASH, "EXECUTION_PROVENANCE_INVALID");
  match(value.artifactId, DECIMAL_ID, "EXECUTION_PROVENANCE_INVALID");
  match(value.artifactSha256, HASH, "EXECUTION_PROVENANCE_INVALID");
  if (value.corpusSha256 !== payload.corpus.sha256)
    fail("EXECUTION_PROVENANCE_INVALID");
  if (
    candidate &&
    (value.workflowSha !== payload.workflow.sha ||
      value.runId !== payload.workflow.runId ||
      value.runAttempt !== payload.workflow.runAttempt ||
      value.subjectSha !== payload.subject.git.sha ||
      value.subjectTree !== payload.subject.git.tree)
  )
    fail("MIXED_RELEASE_EVIDENCE");
}
function validateExecutionArtifact(entry, provenance, records) {
  exact(entry, ["artifactId", "bytesBase64"], "EXECUTION_ARTIFACT_INVALID");
  if (entry.artifactId !== provenance.artifactId)
    fail("EXECUTION_ARTIFACT_INVALID");
  const bytes = decode(entry.bytesBase64);
  if (sha256(bytes) !== provenance.artifactSha256)
    fail("EXECUTION_ARTIFACT_INVALID");
  const artifact = parseStrictJson(bytes.toString("utf8"));
  exact(
    artifact,
    [
      "repository",
      "workflowSha",
      "runId",
      "runAttempt",
      "subjectSha",
      "subjectTree",
      "corpusSha256",
      "recordsSha256",
    ],
    "EXECUTION_ARTIFACT_INVALID",
  );
  if (
    artifact.repository !== provenance.repository ||
    artifact.workflowSha !== provenance.workflowSha ||
    artifact.runId !== provenance.runId ||
    artifact.runAttempt !== provenance.runAttempt ||
    artifact.subjectSha !== provenance.subjectSha ||
    artifact.subjectTree !== provenance.subjectTree ||
    artifact.corpusSha256 !== provenance.corpusSha256 ||
    artifact.recordsSha256 !== sha256(canonicalize(records))
  )
    fail("EXECUTION_ARTIFACT_INVALID");
}
function baselineRecord(value) {
  exact(value, ["caseId", "artifactSha256", "outcome"]);
  nonempty(value.caseId);
  match(value.artifactSha256, HASH);
  nonempty(value.outcome);
  return value;
}
function validateUsage(value) {
  exact(value, ["inputTokens", "outputTokens", "totalTokens"]);
  integer(value.inputTokens);
  integer(value.outputTokens);
  integer(value.totalTokens);
  if (value.totalTokens !== value.inputTokens + value.outputTokens)
    fail("USAGE_INVALID");
  return value;
}
function costMicros(value, pricing) {
  const numerator =
    value.inputTokens * pricing.inputMicrosPerMillionTokens +
    value.outputTokens * pricing.outputMicrosPerMillionTokens;
  if (!Number.isSafeInteger(numerator)) fail("MEASURED_SPEND_INVALID");
  return Math.ceil(numerator / 1000000);
}
function candidateRecord(value, payload) {
  exact(value, [
    "caseId",
    "artifactSha256",
    "providerOutcome",
    "outcome",
    "requestedModelAlias",
    "modelVersion",
    "promptSha256",
    "latencyMs",
    "usage",
    "cost",
    "requestId",
    "responseId",
    "rawResponseSha256",
    "admission",
  ]);
  nonempty(value.caseId);
  match(value.artifactSha256, HASH);
  nonempty(value.providerOutcome);
  nonempty(value.outcome);
  nonempty(value.requestedModelAlias);
  nonempty(value.modelVersion);
  match(value.promptSha256, HASH);
  integer(value.latencyMs);
  validateUsage(value.usage);
  exact(value.cost, ["currency", "amountMicros"]);
  if (value.cost.currency !== "USD") fail("PRICING_BINDING_INVALID");
  integer(value.cost.amountMicros);
  nonempty(value.requestId);
  nonempty(value.responseId);
  match(value.rawResponseSha256, HASH);
  exact(value.admission, [
    "attemptId",
    "sequence",
    "spentBeforeMicros",
    "countedInputTokens",
    "reservedOutputTokens",
    "worstCaseCurrentMicros",
    "hardLimitMicros",
    "status",
  ]);
  nonempty(value.admission.attemptId);
  integer(value.admission.sequence);
  integer(value.admission.spentBeforeMicros);
  integer(value.admission.countedInputTokens);
  integer(value.admission.reservedOutputTokens);
  integer(value.admission.worstCaseCurrentMicros);
  integer(value.admission.hardLimitMicros);
  nonempty(value.admission.status);
  if (
    value.requestedModelAlias !== payload.provider.model ||
    value.promptSha256 !== payload.provider.promptSha256
  )
    fail("PROMPT_OR_MODEL_BINDING_INVALID");
  return value;
}
function validateRawResponse(rawEntry, candidate) {
  exact(rawEntry, ["caseId", "responseId", "bytesBase64"]);
  if (
    rawEntry.caseId !== candidate.caseId ||
    rawEntry.responseId !== candidate.responseId
  )
    fail("RAW_RESPONSE_BINDING_INVALID");
  const bytes = decode(rawEntry.bytesBase64);
  if (sha256(bytes) !== candidate.rawResponseSha256)
    fail("RAW_RESPONSE_BINDING_INVALID");
  const wire = parseStrictJson(bytes.toString("utf8"));
  exact(wire, ["responseId", "modelVersion", "usageMetadata", "result"]);
  exact(wire.usageMetadata, [
    "promptTokenCount",
    "candidatesTokenCount",
    "totalTokenCount",
  ]);
  exact(wire.result, ["providerOutcome"]);
  if (
    wire.responseId !== candidate.responseId ||
    wire.modelVersion !== candidate.modelVersion ||
    wire.result.providerOutcome !== candidate.providerOutcome ||
    wire.usageMetadata.promptTokenCount !== candidate.usage.inputTokens ||
    wire.usageMetadata.candidatesTokenCount !== candidate.usage.outputTokens ||
    wire.usageMetadata.totalTokenCount !== candidate.usage.totalTokens
  )
    fail("RAW_RESPONSE_BINDING_INVALID");
}
function validateObservation(value, identity, route) {
  exact(value, [
    "identity",
    "boundary",
    "scenarioSha256",
    "outcome",
    "countTokensCalls",
    "generationCalls",
    "financialDeltas",
  ]);
  if (value.identity !== identity) fail("BOUNDARY_EVIDENCE_INCOMPLETE");
  nonempty(value.boundary, "BOUNDARY_EVIDENCE_INVALID");
  match(value.scenarioSha256, HASH, "BOUNDARY_EVIDENCE_INVALID");
  integer(value.countTokensCalls, "BOUNDARY_EVIDENCE_INVALID");
  integer(value.generationCalls, "BOUNDARY_EVIDENCE_INVALID");
  if (
    value.outcome !== (route ? "ROUTED_LOCALLY" : "GUARDED") ||
    (route && (value.countTokensCalls !== 0 || value.generationCalls !== 0))
  )
    fail("BOUNDARY_EVIDENCE_MUTATED");
  exact(value.financialDeltas, TABLES, "FINANCIAL_DELTA_INVALID");
  if (TABLES.some((table) => value.financialDeltas[table] !== 0))
    fail("FINANCIAL_DELTA_NONZERO");
}
function assessment(reportBytes, raw, issues) {
  const values = sorted(issues);
  return Object.freeze({
    schemaVersion: 1,
    kind: "OCR_REPORT_V4_ASSESSMENT",
    reportSchemaVersion: 4,
    releaseStatus: values.length === 0 ? "PASS" : "GAPS",
    signable: values.length === 0,
    issues: values,
    bindings: {
      rawEvidenceSha256: sha256(raw),
      reportSha256: sha256(reportBytes),
    },
  });
}

export function assessReportV4(payload, raw, reportBytes) {
  const issues = new Set();
  let report;
  try {
    report = parseStrictJson(reportBytes.toString("utf8"));
  } catch {
    add(issues, "REPORT_V4_JSON_INVALID");
    return assessment(reportBytes, raw, issues);
  }
  if (
    !object(report) ||
    report.reportSchemaVersion !== 4 ||
    Object.hasOwn(report, "schemaVersion")
  ) {
    add(issues, "REPORT_V4_REQUIRED");
    return assessment(reportBytes, raw, issues);
  }
  if (report.evidenceClass === "TEST_ONLY") {
    add(issues, "MISSING_BASELINE_EXECUTION");
    add(issues, "MISSING_LIVE_CANDIDATE_EXECUTION");
  }
  if (!object(report.baseline)) add(issues, "MISSING_BASELINE_EXECUTION");
  if (!object(report.candidate))
    add(issues, "MISSING_LIVE_CANDIDATE_EXECUTION");
  if (
    issues.has("MISSING_BASELINE_EXECUTION") ||
    issues.has("MISSING_LIVE_CANDIDATE_EXECUTION")
  )
    return assessment(reportBytes, raw, issues);

  try {
    exact(report, [
      "reportSchemaVersion",
      "evidenceClass",
      "rawEvidenceSha256",
      "provider",
      "pricing",
      "baseline",
      "candidate",
      "boundaryObservations",
      "comparison",
      "regressions",
      "metrics",
      "spend",
      "issues",
      "releaseStatus",
    ]);
    if (report.evidenceClass !== "LIVE") fail("LIVE_EVIDENCE_REQUIRED");
    match(report.rawEvidenceSha256, HASH);
    if (report.rawEvidenceSha256 !== sha256(raw))
      fail("RAW_EVIDENCE_BINDING_INVALID");
    exact(report.provider, [
      "provider",
      "requestedModelAlias",
      "observedModelVersion",
      "region",
      "endpoint",
      "promptSha256",
    ]);
    if (
      report.provider.provider !== payload.provider.provider ||
      report.provider.requestedModelAlias !== payload.provider.model ||
      report.provider.region !== payload.provider.region ||
      report.provider.endpoint !== payload.provider.endpoint ||
      report.provider.promptSha256 !== payload.provider.promptSha256
    )
      fail("PROVIDER_BINDING_INVALID");
    nonempty(report.provider.observedModelVersion);
    exact(report.pricing, [
      "currency",
      "inputMicrosPerMillionTokens",
      "outputMicrosPerMillionTokens",
      "hardLimitMicros",
    ]);
    if (
      report.pricing.currency !== payload.pricing.currency ||
      report.pricing.inputMicrosPerMillionTokens !==
        payload.pricing.inputMicrosPerMillionTokens ||
      report.pricing.outputMicrosPerMillionTokens !==
        payload.pricing.outputMicrosPerMillionTokens ||
      report.pricing.hardLimitMicros !== payload.pricing.maxTotalCostMicros
    )
      fail("PRICING_BINDING_INVALID");
    exact(report.baseline, ["provenance", "records"]);
    exact(report.candidate, ["provenance", "records"]);
    if (
      !Array.isArray(report.baseline.records) ||
      report.baseline.records.length !== 18
    )
      fail("MISSING_BASELINE_EXECUTION");
    if (
      !Array.isArray(report.candidate.records) ||
      report.candidate.records.length !== 18
    )
      fail("MISSING_LIVE_CANDIDATE_EXECUTION");
    report.baseline.records.forEach(baselineRecord);
    report.candidate.records.forEach((record) =>
      candidateRecord(record, payload),
    );
    validateProvenance(
      report.baseline.provenance,
      report.baseline.records,
      payload,
      false,
    );
    validateProvenance(
      report.candidate.provenance,
      report.candidate.records,
      payload,
      true,
    );
    const baselineIds = new Set(
      report.baseline.records.map((item) => item.caseId),
    );
    const candidateIds = new Set(
      report.candidate.records.map((item) => item.caseId),
    );
    const requestIds = new Set(
      report.candidate.records.map((item) => item.requestId),
    );
    const responseIds = new Set(
      report.candidate.records.map((item) => item.responseId),
    );
    if (
      baselineIds.size !== 18 ||
      candidateIds.size !== 18 ||
      requestIds.size !== 18 ||
      responseIds.size !== 18
    )
      fail("CASE_IDENTITY_INVALID");

    let rawEvidence;
    try {
      rawEvidence = parseStrictJson(raw.toString("utf8"));
      exact(rawEvidence, [
        "schemaVersion",
        "evidenceClass",
        "executionArtifacts",
        "responses",
      ]);
      exact(
        rawEvidence.executionArtifacts,
        ["baseline", "candidate"],
        "RAW_EVIDENCE_SCHEMA_INVALID",
      );
      if (
        rawEvidence.schemaVersion !== 4 ||
        rawEvidence.evidenceClass !== "LIVE" ||
        !Array.isArray(rawEvidence.responses) ||
        rawEvidence.responses.length !== 18
      )
        fail("RAW_EVIDENCE_SCHEMA_INVALID");
    } catch (error) {
      if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message))
        throw error;
      fail("RAW_EVIDENCE_SCHEMA_INVALID");
    }
    const rawByCase = new Map(
      rawEvidence.responses.map((item) => [item.caseId, item]),
    );
    if (rawByCase.size !== 18) fail("RAW_RESPONSE_BINDING_INVALID");

    let cumulative = 0;
    let measured = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    const comparisons = [];
    const regressions = [];
    const latencies = [];
    for (let index = 0; index < 18; index += 1) {
      const baseline = report.baseline.records[index];
      const candidate = report.candidate.records[index];
      if (
        baseline.caseId !== candidate.caseId ||
        baseline.artifactSha256 !== candidate.artifactSha256
      )
        fail("CASE_BINDING_INVALID");
      if (
        candidate.modelVersion !== report.provider.observedModelVersion ||
        candidate.requestedModelAlias !== report.provider.requestedModelAlias ||
        candidate.promptSha256 !== report.provider.promptSha256
      )
        fail("PROVIDER_BINDING_INVALID");
      const mapped = OUTCOME_MAP[candidate.providerOutcome];
      if (!mapped || mapped !== candidate.outcome)
        fail("OUTCOME_MAPPING_INVALID");
      validateRawResponse(rawByCase.get(candidate.caseId), candidate);
      const expectedCost = costMicros(candidate.usage, report.pricing);
      if (candidate.cost.amountMicros !== expectedCost)
        fail("MEASURED_SPEND_MISMATCH");
      measured += expectedCost;
      inputTokens += candidate.usage.inputTokens;
      outputTokens += candidate.usage.outputTokens;
      totalTokens += candidate.usage.totalTokens;
      latencies.push(candidate.latencyMs);
      const admission = candidate.admission;
      const attempt =
        report.candidate.provenance.runId +
        ":" +
        report.candidate.provenance.runAttempt;
      const derivedWorstCaseMicros = costMicros(
        {
          inputTokens: admission.countedInputTokens,
          outputTokens: admission.reservedOutputTokens,
        },
        report.pricing,
      );
      if (
        admission.attemptId !== attempt ||
        admission.sequence !== index + 1 ||
        admission.spentBeforeMicros !== cumulative ||
        admission.reservedOutputTokens !== 8192 ||
        admission.worstCaseCurrentMicros !== derivedWorstCaseMicros ||
        admission.hardLimitMicros !== report.pricing.hardLimitMicros
      )
        fail("SPEND_ATTEMPT_STATE_INVALID");
      const decision = admitCumulativeSpend(
        cumulative,
        admission.worstCaseCurrentMicros,
        admission.hardLimitMicros,
      );
      if (decision.status !== admission.status) fail("SPEND_ADMISSION_INVALID");
      if (decision.status !== "ADMITTED") fail("SPEND_LIMIT_EXCEEDED");
      cumulative = decision.cumulativeWorstCaseMicros;
      const caseIssues =
        baseline.outcome === candidate.outcome ? [] : ["OUTCOME_REGRESSION"];
      comparisons.push({
        caseId: candidate.caseId,
        pass: caseIssues.length === 0,
        issues: caseIssues,
      });
      if (caseIssues.length > 0)
        regressions.push({ caseId: candidate.caseId, issues: caseIssues });
    }
    if (measured > report.pricing.hardLimitMicros) fail("SPEND_LIMIT_EXCEEDED");
    validateExecutionArtifact(
      rawEvidence.executionArtifacts.baseline,
      report.baseline.provenance,
      report.baseline.records,
    );
    validateExecutionArtifact(
      rawEvidence.executionArtifacts.candidate,
      report.candidate.provenance,
      report.candidate.records,
    );

    if (
      !Array.isArray(report.boundaryObservations) ||
      report.boundaryObservations.length !== 45
    )
      fail("BOUNDARY_EVIDENCE_INCOMPLETE");
    const identities = [
      ...ROUTES.map((id) => "[ROUTE] " + id),
      ...PROBES.map((id) => "[PROBE] " + id),
    ];
    if (
      new Set(report.boundaryObservations.map((item) => item?.identity))
        .size !== 45
    )
      fail("BOUNDARY_EVIDENCE_INCOMPLETE");
    report.boundaryObservations.forEach((item, index) =>
      validateObservation(item, identities[index], index < 10),
    );

    const ordered = [...latencies].sort((left, right) => left - right);
    const metrics = {
      caseCount: 18,
      passCount: 18 - regressions.length,
      regressionCount: regressions.length,
      p95LatencyMs: ordered[Math.ceil(ordered.length * 0.95) - 1],
      inputTokens,
      outputTokens,
      totalTokens,
      totalCostMicros: measured,
      costCurrency: "USD",
    };
    exact(report.comparison, ["cases"]);
    exact(report.metrics, Object.keys(metrics));
    exact(report.spend, [
      "hardLimitMicros",
      "cumulativeWorstCaseMicros",
      "measuredMicros",
      "admissionSha256",
      "admittedAt",
    ]);
    if (
      !same(report.comparison.cases, comparisons) ||
      !same(report.regressions, regressions) ||
      !same(report.metrics, metrics) ||
      report.spend.hardLimitMicros !== report.pricing.hardLimitMicros ||
      report.spend.cumulativeWorstCaseMicros !== cumulative ||
      report.spend.measuredMicros !== measured ||
      report.spend.admissionSha256 !== payload.spend.admissionSha256 ||
      report.spend.admittedAt !== payload.spend.admittedAt
    )
      fail("PRODUCER_DERIVATION_MISMATCH");
    const derivedIssues = regressions.flatMap((item) => item.issues);
    if (
      !Array.isArray(report.issues) ||
      report.issues.some((item) => typeof item !== "string") ||
      !same(report.issues, [...new Set(derivedIssues)].sort()) ||
      report.releaseStatus !== (derivedIssues.length === 0 ? "PASS" : "GAPS")
    )
      fail("PRODUCER_STATUS_MISMATCH");
    for (const issue of derivedIssues) add(issues, issue);
  } catch (error) {
    add(
      issues,
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "REPORT_V4_SCHEMA_INVALID",
    );
  }
  return assessment(reportBytes, raw, issues);
}

function validateSpendBinding(report, request, payload) {
  if (
    report?.spend?.admissionSha256 !== sha256(canonicalize(request)) ||
    request.subjectSha !== payload.subject.git.sha ||
    request.subjectTree !== payload.subject.git.tree ||
    request.productionImage !== payload.subject.productionImage.reference ||
    request.qualificationImageDigest !==
      payload.subject.qualificationImage.digest ||
    request.executableDigest !==
      payload.subject.qualificationImage.executableDigest ||
    request.workflowSha !== payload.workflow.sha ||
    request.runId !== payload.workflow.runId ||
    request.runAttempt !== payload.workflow.runAttempt ||
    request.policySha256 !== payload.policy.sha256 ||
    request.corpusSha256 !== payload.corpus.sha256 ||
    request.promptSha256 !== payload.provider.promptSha256 ||
    request.requestedModelAlias !== payload.provider.model ||
    request.reviewSetSha256 !== sha256(canonicalize(payload.reviews))
  )
    fail("SPEND_BINDING_INVALID");
}

export function buildUnsignedPayloadFromBytes(
  payloadInput,
  raw,
  reportBytes,
  spendRequestBytes,
  options = {},
) {
  const payload = structuredClone(payloadInput);
  payload.attestationId = "0".repeat(64);
  const reportAssessment = assessReportV4(payload, raw, reportBytes);
  if (!reportAssessment.signable) return reportAssessment;
  let report;
  let request;
  try {
    report = parseStrictJson(reportBytes.toString("utf8"));
    request = parseStrictJson(spendRequestBytes.toString("utf8"));
  } catch {
    return assessment(reportBytes, raw, new Set(["SPEND_REQUEST_INVALID"]));
  }
  if (
    payload.evidence.raw.sha256 !== sha256(raw) ||
    payload.evidence.raw.size !== raw.length ||
    payload.evidence.report.sha256 !== sha256(reportBytes) ||
    payload.evidence.report.size !== reportBytes.length
  )
    return assessment(
      reportBytes,
      raw,
      new Set(["EVIDENCE_ARTIFACT_MISMATCH"]),
    );
  try {
    validateSpendBinding(report, request, payload);
  } catch {
    return assessment(reportBytes, raw, new Set(["SPEND_BINDING_INVALID"]));
  }
  if (options.assessmentOnly) return reportAssessment;
  payload.evidence.requestIds = report.candidate.records.map(
    (item) => item.requestId,
  );
  payload.evidence.responseIds = report.candidate.records.map(
    (item) => item.responseId,
  );
  payload.provider.modelVersion = report.provider.observedModelVersion;
  payload.spend.measuredMicros = report.spend.measuredMicros;
  return prepareRuntimeReleaseDraft(payload);
}
export async function buildUnsignedPayload(
  input,
  root = process.cwd(),
  options = {},
) {
  if (
    !object(input) ||
    Reflect.ownKeys(input).length !== 5 ||
    input.schemaVersion !== 1 ||
    input.mode !== "FILES" ||
    typeof input.rawEvidencePath !== "string" ||
    typeof input.reportPath !== "string" ||
    typeof input.spendRequestPath !== "string" ||
    !input.payload
  )
    fail("UNSIGNED_INPUT_INVALID");
  return buildUnsignedPayloadFromBytes(
    input.payload,
    await bounded(resolve(root, input.rawEvidencePath)),
    await bounded(resolve(root, input.reportPath)),
    await bounded(resolve(root, input.spendRequestPath)),
    options,
  );
}
export function buildUnsignedPayloadFromBundle(input, options = {}) {
  if (
    !object(input) ||
    Reflect.ownKeys(input).length !== 6 ||
    input.schemaVersion !== 1 ||
    input.mode !== "BUNDLE" ||
    !input.payload
  )
    fail("UNSIGNED_INPUT_INVALID");
  return buildUnsignedPayloadFromBytes(
    input.payload,
    decode(input.rawEvidenceBase64),
    decode(input.reportBase64),
    decode(input.spendRequestBase64),
    options,
  );
}

const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [inputPath, mode, root] = process.argv.slice(2);
  try {
    if (!inputPath || (mode && mode !== "--assessment")) fail("USAGE_INVALID");
    const input = parseStrictJson(
      inputPath === "-"
        ? await new Response(process.stdin).text()
        : await readFile(inputPath, "utf8"),
    );
    const options = { assessmentOnly: mode === "--assessment" };
    const value =
      input.mode === "BUNDLE"
        ? buildUnsignedPayloadFromBundle(input, options)
        : await buildUnsignedPayload(
            input,
            resolve(root ?? process.cwd()),
            options,
          );
    process.stdout.write(canonicalize(value));
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "UNSIGNED_ATTESTATION_FAILED";
    process.stderr.write(code + "\n");
    process.exitCode = 1;
  }
}
