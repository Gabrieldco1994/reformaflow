#!/usr/bin/env node
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
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
const MAX_CANDIDATE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const QUALIFICATION_HARD_LIMIT_MICROS = 502_000;
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
const CANONICAL_CASE_IDS = Object.freeze(
  Array.from(
    { length: 18 },
    (_, index) => `scan-${String(index + 1).padStart(3, "0")}`,
  ),
);
const CANONICAL_REPORT_SCHEMA =
  "apps/api/src/imports/ocr-synth-v1/report.schema.json";
const MAX_RAW_VERTEX_RESPONSE_BYTES = 16 * 1024 * 1024;
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
  hardLimitMicros = QUALIFICATION_HARD_LIMIT_MICROS,
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

function canonicalAuthorityAssessment(report, rawEvidence, issues) {
  const values = [...issues];
  return Object.freeze({
    reportSchemaVersion: 4,
    releaseStatus: values.length === 0 ? "PASS" : "GAPS",
    signable: values.length === 0,
    issues: values,
    bindings: {
      rawEvidenceSha256: sha256(Buffer.from(canonicalize(rawEvidence))),
      reportSha256: sha256(Buffer.from(canonicalize(report))),
      reportSchemaSha256: null,
    },
  });
}

function exactRawVertexBytes(entry, missingCode) {
  if (!object(entry) || !Object.hasOwn(entry, "bytesBase64")) fail(missingCode);
  if (
    typeof entry.bytesBase64 !== "string" ||
    entry.bytesBase64.length >
      Math.ceil((MAX_RAW_VERTEX_RESPONSE_BYTES + 2) / 3) * 4
  )
    fail("RAW_VERTEX_RESPONSE_BYTES_INVALID");
  const bytes = Buffer.from(entry.bytesBase64, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_RAW_VERTEX_RESPONSE_BYTES ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      entry.bytesBase64,
    ) ||
    bytes.toString("base64") !== entry.bytesBase64 ||
    entry.byteLength !== bytes.length ||
    entry.sha256 !== sha256(bytes)
  )
    fail("RAW_VERTEX_RESPONSE_BYTES_INVALID");
  return bytes;
}

function parseRawVertexJson(bytes) {
  try {
    return parseStrictJson(bytes.toString("utf8"));
  } catch {
    fail("RAW_VERTEX_RESPONSE_SCHEMA_INVALID");
  }
}

function validateCandidateArtifactAuthority(authority) {
  exact(
    authority,
    [
      "repositoryId",
      "workflowPath",
      "workflowSha",
      "workflowRunId",
      "workflowRunAttempt",
      "workflowHeadSha",
      "workflowHeadTree",
      "subjectSha",
      "subjectTree",
      "artifactId",
      "artifactName",
      "artifactDigest",
      "memberName",
    ],
    "CANDIDATE_ARTIFACT_AUTHORITY_INVALID",
  );
  integer(authority.repositoryId, "CANDIDATE_ARTIFACT_AUTHORITY_INVALID");
  nonempty(authority.workflowPath, "CANDIDATE_ARTIFACT_AUTHORITY_INVALID");
  match(authority.workflowSha, COMMIT, "CANDIDATE_ARTIFACT_AUTHORITY_INVALID");
  integer(authority.workflowRunId, "CANDIDATE_ARTIFACT_AUTHORITY_INVALID");
  integer(authority.workflowRunAttempt, "CANDIDATE_ARTIFACT_AUTHORITY_INVALID");
  match(
    authority.workflowHeadSha,
    COMMIT,
    "CANDIDATE_ARTIFACT_AUTHORITY_INVALID",
  );
  match(
    authority.workflowHeadTree,
    COMMIT,
    "CANDIDATE_ARTIFACT_AUTHORITY_INVALID",
  );
  match(authority.subjectSha, COMMIT, "CANDIDATE_ARTIFACT_AUTHORITY_INVALID");
  match(authority.subjectTree, COMMIT, "CANDIDATE_ARTIFACT_AUTHORITY_INVALID");
  integer(authority.artifactId, "CANDIDATE_ARTIFACT_AUTHORITY_INVALID");
  nonempty(authority.artifactName, "CANDIDATE_ARTIFACT_AUTHORITY_INVALID");
  match(
    authority.artifactDigest,
    /^sha256:[0-9a-f]{64}$/,
    "CANDIDATE_ARTIFACT_AUTHORITY_INVALID",
  );
  nonempty(authority.memberName, "CANDIDATE_ARTIFACT_AUTHORITY_INVALID");
  return authority;
}

function extractZipMember(archive, expectedName) {
  if (!Buffer.isBuffer(archive) || archive.length < 22)
    fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
  let eocd = -1;
  for (
    let offset = archive.length - 22;
    offset >= Math.max(0, archive.length - 65_557);
    offset -= 1
  ) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
  const entryCount = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  let member;
  const names = new Set();
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > archive.length ||
      archive.readUInt32LE(offset) !== 0x02014b50
    )
      fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > archive.length || (flags & 1) !== 0)
      fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
    const name = archive.subarray(offset + 46, nameEnd).toString("utf8");
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").includes("..") ||
      names.has(name)
    )
      fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
    names.add(name);
    if (name === expectedName) {
      if (
        localOffset + 30 > archive.length ||
        archive.readUInt32LE(localOffset) !== 0x04034b50
      )
        fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > archive.length)
        fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
      const compressed = archive.subarray(dataStart, dataEnd);
      const bytes =
        method === 0
          ? Buffer.from(compressed)
          : method === 8
            ? inflateRawSync(compressed)
            : fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
      if (bytes.length !== uncompressedSize)
        fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
      member = bytes;
    }
    offset = nameEnd + extraLength + commentLength;
  }
  if (!member) fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
  return member;
}

function validateCandidateArtifactShape(value, authorityInput, payloadInput) {
  const authority = validateCandidateArtifactAuthority(authorityInput);
  exact(
    value,
    ["expected", "metadata", "archiveBytesBase64", "bindings"],
    "CANDIDATE_ARTIFACT_PROVENANCE_INVALID",
  );
  const { expected, metadata, archiveBytesBase64, bindings } = value;
  if (
    typeof archiveBytesBase64 !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(archiveBytesBase64)
  )
    fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
  const archiveBytes = Buffer.from(archiveBytesBase64, "base64");
  if (
    archiveBytes.length === 0 ||
    archiveBytes.length > MAX_CANDIDATE_ARTIFACT_BYTES ||
    archiveBytes.toString("base64") !== archiveBytesBase64
  )
    fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
  const memberBytes = extractZipMember(archiveBytes, authority.memberName);
  if (
    !object(expected) ||
    !object(metadata) ||
    expected.memberName !== authority.memberName ||
    metadata.id !== expected.artifactId ||
    metadata.name !== expected.artifactName ||
    metadata.expired !== false ||
    metadata.digest !== `sha256:${sha256(archiveBytes)}` ||
    !object(metadata.workflow_run) ||
    metadata.workflow_run.id !== expected.workflowRunId ||
    metadata.workflow_run.head_sha !== expected.workflowHeadSha ||
    !object(bindings) ||
    bindings.workflowPath !== expected.workflowPath ||
    bindings.workflowSha !== expected.workflowSha ||
    bindings.workflowHeadTree !== expected.workflowHeadTree ||
    bindings.subjectSha !== expected.subjectSha ||
    bindings.subjectTree !== expected.subjectTree ||
    expected.repositoryId !== authority.repositoryId ||
    expected.workflowPath !== authority.workflowPath ||
    expected.workflowSha !== authority.workflowSha ||
    expected.workflowRunId !== authority.workflowRunId ||
    expected.workflowRunAttempt !== authority.workflowRunAttempt ||
    expected.workflowHeadSha !== authority.workflowHeadSha ||
    expected.workflowHeadTree !== authority.workflowHeadTree ||
    expected.subjectSha !== authority.subjectSha ||
    expected.subjectTree !== authority.subjectTree ||
    expected.artifactId !== authority.artifactId ||
    expected.artifactName !== authority.artifactName ||
    expected.memberName !== authority.memberName ||
    metadata.id !== authority.artifactId ||
    metadata.name !== authority.artifactName ||
    metadata.digest !== authority.artifactDigest ||
    metadata.workflow_run.id !== authority.workflowRunId ||
    metadata.workflow_run.head_sha !== authority.workflowHeadSha ||
    bindings.workflowPath !== authority.workflowPath ||
    bindings.workflowSha !== authority.workflowSha ||
    bindings.workflowHeadTree !== authority.workflowHeadTree ||
    bindings.subjectSha !== authority.subjectSha ||
    bindings.subjectTree !== authority.subjectTree ||
    canonicalize(parseRawVertexJson(memberBytes)) !== canonicalize(payloadInput)
  )
    fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
}

export async function verifyCandidateArtifactV4(value, authority, payload) {
  try {
    validateCandidateArtifactShape(value, authority, payload ?? value?.payload);
    return payload ?? value.payload;
  } catch {
    fail("CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
  }
}

function validateCanonicalReportV4(report) {
  exact(report, [
    "reportSchemaVersion",
    "historicalComparison",
    "datasetVersion",
    "corpusSampleCount",
    "releaseScannedPdfSampleCount",
    "routingSafetySampleCount",
    "futureImageSampleCount",
    "baseline",
    "candidate",
    "thresholds",
    "metrics",
    "perCase",
    "regressions",
    "routingCases",
    "safetyProbes",
    "fallbackSafety",
    "liveEvidenceGaps",
    "functionalStatus",
    "releaseStatus",
  ]);
  if (
    report.reportSchemaVersion !== 4 ||
    report.historicalComparison !== "NOT_PERFORMED_P1_DEFERRED" ||
    report.datasetVersion !== "ocr-synth-v1-direct-pdf-vertex-v3" ||
    report.corpusSampleCount !== 52 ||
    report.releaseScannedPdfSampleCount !== 18 ||
    report.routingSafetySampleCount !== 10 ||
    report.futureImageSampleCount !== 12 ||
    !object(report.baseline) ||
    report.baseline.behavior !== "OCR_REQUIRED" ||
    report.baseline.sampleCount !== 18 ||
    !object(report.candidate) ||
    (report.candidate.mode !== "LIVE_CAPTURE" &&
      report.candidate.evidenceClass !== "LIVE") ||
    !Array.isArray(report.perCase) ||
    report.perCase.length !== 18 ||
    !Array.isArray(report.routingCases) ||
    report.routingCases.length !== 10 ||
    !Array.isArray(report.safetyProbes) ||
    report.safetyProbes.length !== 35 ||
    !Array.isArray(report.regressions) ||
    !Array.isArray(report.liveEvidenceGaps)
  )
    fail("REPORT_V4_SCHEMA_INVALID");
}

function validateCanonicalRawCandidate(rawCase, index, issues) {
  if (!object(rawCase)) fail("RAW_VERTEX_RESPONSE_SCHEMA_INVALID");
  const countTokensBytes = exactRawVertexBytes(
    rawCase.countTokens,
    "RAW_VERTEX_RESPONSE_BYTES_MISSING",
  );
  const generationBytes = exactRawVertexBytes(
    rawCase.generation,
    "RAW_VERTEX_RESPONSE_BYTES_MISSING",
  );
  const countTokens = parseRawVertexJson(countTokensBytes);
  const generation = parseRawVertexJson(generationBytes);
  if (
    !object(countTokens) ||
    !Number.isSafeInteger(countTokens.totalTokens) ||
    Reflect.ownKeys(countTokens).length !== 1 ||
    !object(generation) ||
    !exact(
      generation,
      ["responseId", "modelVersion", "candidates", "usageMetadata"],
      "RAW_VERTEX_RESPONSE_SCHEMA_INVALID",
    ) ||
    !nonempty(generation.responseId, "RAW_VERTEX_RESPONSE_SCHEMA_INVALID") ||
    !nonempty(generation.modelVersion, "RAW_VERTEX_RESPONSE_SCHEMA_INVALID") ||
    !Array.isArray(generation.candidates) ||
    generation.candidates.length !== 1 ||
    !object(generation.candidates[0]) ||
    !object(generation.candidates[0].content) ||
    !Array.isArray(generation.candidates[0].content.parts) ||
    generation.candidates[0].content.parts.length !== 1 ||
    !object(generation.candidates[0].content.parts[0]) ||
    typeof generation.candidates[0].content.parts[0].text !== "string" ||
    !object(generation.usageMetadata)
  )
    fail("RAW_VERTEX_RESPONSE_SCHEMA_INVALID");
  const usage = generation.usageMetadata;
  if (
    !Number.isSafeInteger(usage.promptTokenCount) ||
    !Number.isSafeInteger(usage.candidatesTokenCount) ||
    !Number.isSafeInteger(usage.totalTokenCount) ||
    usage.totalTokenCount !==
      usage.promptTokenCount + usage.candidatesTokenCount
  )
    fail("RAW_VERTEX_RESPONSE_SCHEMA_INVALID");
  const generationClaim = rawCase.generation;
  if (
    (Object.hasOwn(generationClaim, "responseId") &&
      generationClaim.responseId !== generation.responseId) ||
    (Object.hasOwn(generationClaim, "modelVersion") &&
      generationClaim.modelVersion !== generation.modelVersion) ||
    (Object.hasOwn(generationClaim, "usage") &&
      (!object(generationClaim.usage) ||
        generationClaim.usage.promptTokenCount !== usage.promptTokenCount ||
        generationClaim.usage.candidatesTokenCount !==
          usage.candidatesTokenCount ||
        generationClaim.usage.totalTokenCount !== usage.totalTokenCount))
  )
    fail("RAW_VERTEX_RESPONSE_BINDING_INVALID");
  let providerPayload;
  try {
    providerPayload = parseStrictJson(
      generation.candidates[0].content.parts[0].text,
    );
  } catch {
    fail("RAW_VERTEX_RESPONSE_SCHEMA_INVALID");
  }
  if (
    !object(providerPayload) ||
    !Array.isArray(providerPayload.candidates) ||
    providerPayload.candidates.length !== 1 ||
    !object(providerPayload.candidates[0])
  )
    fail("RAW_VERTEX_RESPONSE_SCHEMA_INVALID");
  if (providerPayload.candidates[0].amountCents !== String(index + 1))
    add(issues, "MONEY_MISMATCH");
}

async function recomputeApplicationReport(rawEvidence) {
  const module =
    await import("../../apps/api/dist/imports/ocr-synth-v1/offline-report.js");
  if (typeof module.evaluateOfflineReport !== "function")
    fail("CANONICAL_REPORT_V4_AUTHORITY_NOT_IMPLEMENTED");
  return await module.evaluateOfflineReport(canonicalize(rawEvidence));
}

export async function assessCanonicalReport(
  input,
  authority,
  dependencies = {},
) {
  if (!object(input)) fail("REPORT_V4_SCHEMA_INVALID");
  if (input.evidenceClass === "TEST_ONLY") {
    return Object.freeze({
      reportSchemaVersion: 4,
      releaseStatus: "GAPS",
      signable: false,
      issues: [
        "LIVE_PROVIDER_RUN_NOT_SUPPLIED",
        "MISSING_BASELINE_EXECUTION",
        "MISSING_LIVE_CANDIDATE_EXECUTION",
        "MISSING_RAW_VERTEX_RESPONSE_BYTES",
        "MISSING_LIVE_ATTEMPT_LEDGER",
        "MISSING_LIVE_BOUNDARY_OBSERVATIONS",
      ],
      bindings: {
        rawEvidenceSha256: sha256(
          Buffer.from(canonicalize(input.rawEvidence ?? null)),
        ),
        reportSha256: sha256(Buffer.from(canonicalize(input.report ?? null))),
        reportSchemaSha256: sha256(
          await readFile(
            resolve(import.meta.dirname, "../..", CANONICAL_REPORT_SCHEMA),
          ),
        ),
      },
    });
  }
  const issues = new Set();
  if (
    object(input.rawEvidence?.run) &&
    Array.isArray(input.rawEvidence?.predictions)
  ) {
    try {
      validateCanonicalReportV4(input.report);
      if (input.evidenceClass !== "LIVE") fail("LIVE_EVIDENCE_BINDING_INVALID");
      await verifyCandidateArtifactV4(
        input.candidateArtifact,
        authority,
        input.rawEvidence,
      );
      const recomputed = await (
        dependencies.recompute ?? recomputeApplicationReport
      )(input.rawEvidence);
      if (!same(recomputed, input.report))
        fail("REPORT_V4_DERIVATION_MISMATCH");
    } catch (error) {
      add(
        issues,
        error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "REPORT_V4_SCHEMA_INVALID",
      );
    }
    const result = canonicalAuthorityAssessment(
      input.report,
      input.rawEvidence,
      issues,
    );
    return Object.freeze({
      ...result,
      bindings: Object.freeze({
        ...result.bindings,
        reportSchemaSha256: sha256(
          await readFile(
            resolve(import.meta.dirname, "../..", CANONICAL_REPORT_SCHEMA),
          ),
        ),
      }),
    });
  }
  return canonicalAuthorityAssessment(
    input.report,
    input.rawEvidence,
    new Set(["RAW_VERTEX_RESPONSE_SCHEMA_INVALID"]),
  );
  /*
   * The pre-application V4 fixture assessor below is deliberately unreachable.
   * Production accepts only parser/evaluator-owned raw evidence and report V4.
   */
  try {
    validateCanonicalReportV4(input.report);
    if (
      input.evidenceClass !== "LIVE" ||
      input.rawEvidence?.evidenceClass !== "LIVE" ||
      input.rawEvidence?.datasetVersion !== input.report.datasetVersion ||
      !Array.isArray(input.rawEvidence?.cases) ||
      input.rawEvidence.cases.length !== 18
    )
      fail("RAW_VERTEX_RESPONSE_SCHEMA_INVALID");
    if (
      input.baselineArtifact?.verified !== true ||
      !Array.isArray(input.baselineArtifact.records) ||
      canonicalize(input.baselineArtifact.records) !==
        canonicalize(CANONICAL_CASE_IDS) ||
      input.boundaryObservations?.verified !== true ||
      input.boundaryObservations.count !== 45 ||
      input.attemptLedger?.verified !== true ||
      input.attemptLedger.runAttempt !== 1
    )
      fail("LIVE_EVIDENCE_BINDING_INVALID");
    const candidatePayload = await verifyCandidateArtifactV4(
      input.candidateArtifact,
      authority,
      input.rawEvidence,
    );
    input.rawEvidence.cases.forEach((rawCase, index) =>
      validateCanonicalRawCandidate(rawCase, index, issues),
    );
    if (canonicalize(candidatePayload) !== canonicalize(input.rawEvidence))
      add(issues, "CANDIDATE_ARTIFACT_PROVENANCE_INVALID");
    if (issues.size > 0) add(issues, "REPORT_V4_DERIVATION_MISMATCH");
    else if (
      input.report.functionalStatus !== "PASS" ||
      input.report.releaseStatus !== "PASS" ||
      input.report.liveEvidenceGaps.length !== 0 ||
      input.report.regressions.length !== 0 ||
      input.report.perCase.some(
        (item, index) =>
          !object(item) ||
          item.caseId !== CANONICAL_CASE_IDS[index] ||
          item.pass !== true ||
          !Array.isArray(item.issues) ||
          item.issues.length !== 0,
      )
    )
      add(issues, "REPORT_V4_DERIVATION_MISMATCH");
  } catch (error) {
    add(
      issues,
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "REPORT_V4_SCHEMA_INVALID",
    );
  }
  const result = canonicalAuthorityAssessment(
    input.report,
    input.rawEvidence,
    issues,
  );
  return Object.freeze({
    ...result,
    bindings: Object.freeze({
      ...result.bindings,
      reportSchemaSha256: sha256(
        await readFile(
          resolve(import.meta.dirname, "../..", CANONICAL_REPORT_SCHEMA),
        ),
      ),
    }),
  });
}

function assessRetiredFixture(payload, raw, reportBytes) {
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
    (report?.spend?.admissionSha256 ?? payload?.spend?.admissionSha256) !==
      sha256(canonicalize(request)) ||
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
  assessmentBytes,
  options = {},
) {
  if (assessmentBytes !== undefined && !Buffer.isBuffer(assessmentBytes))
    fail("PERSISTED_REPORT_ASSESSMENT_INVALID");
  const payload = structuredClone(payloadInput);
  payload.attestationId = "0".repeat(64);
  let persistedAssessment;
  if (assessmentBytes) {
    try {
      const rawValue = parseStrictJson(raw.toString("utf8"));
      const reportValue = parseStrictJson(reportBytes.toString("utf8"));
      persistedAssessment = parseStrictJson(assessmentBytes.toString("utf8"));
      if (
        persistedAssessment.reportSchemaVersion !== 4 ||
        persistedAssessment.releaseStatus !== "PASS" ||
        persistedAssessment.signable !== true ||
        !Array.isArray(persistedAssessment.issues) ||
        persistedAssessment.issues.length !== 0 ||
        persistedAssessment.bindings?.rawEvidenceSha256 !==
          sha256(Buffer.from(canonicalize(rawValue))) ||
        persistedAssessment.bindings?.reportSha256 !==
          sha256(Buffer.from(canonicalize(reportValue))) ||
        reportValue.reportSchemaVersion !== 4 ||
        reportValue.historicalComparison !== "NOT_PERFORMED_P1_DEFERRED" ||
        reportValue.releaseStatus !== "PASS"
      )
        fail("PERSISTED_REPORT_ASSESSMENT_INVALID");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "PERSISTED_REPORT_ASSESSMENT_INVALID"
      )
        throw error;
      fail("PERSISTED_REPORT_ASSESSMENT_INVALID");
    }
  }
  if (!assessmentBytes)
    return assessment(
      reportBytes,
      raw,
      new Set(["PERSISTED_REPORT_ASSESSMENT_REQUIRED"]),
    );
  const reportAssessment = persistedAssessment;
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
    payload.evidence.report.size !== reportBytes.length ||
    (assessmentBytes &&
      (payload.evidence.assessment?.sha256 !== sha256(assessmentBytes) ||
        payload.evidence.assessment?.size !== assessmentBytes.length))
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
  const rawValue = parseStrictJson(raw.toString("utf8"));
  payload.evidence.requestIds = rawValue.predictions.map(
    (item) => item.adapterTrace.requestId,
  );
  payload.evidence.responseIds = rawValue.predictions.map(
    (item) => item.adapterTrace.responseId,
  );
  if (
    typeof rawValue.run?.modelVersion !== "string" ||
    rawValue.run.modelVersion.length === 0
  )
    fail("LIVE_EVIDENCE_BINDING_INVALID");
  payload.provider.modelVersion = rawValue.run.modelVersion;
  payload.spend.measuredMicros = report.metrics.totalCostMicros;
  return prepareRuntimeReleaseDraft(payload);
}
export async function buildUnsignedPayload(
  input,
  root = process.cwd(),
  options = {},
) {
  if (
    !object(input) ||
    Reflect.ownKeys(input).length !== 6 ||
    input.schemaVersion !== 1 ||
    input.mode !== "FILES" ||
    typeof input.rawEvidencePath !== "string" ||
    typeof input.reportPath !== "string" ||
    typeof input.spendRequestPath !== "string" ||
    typeof input.assessmentPath !== "string" ||
    !input.payload
  )
    fail("UNSIGNED_INPUT_INVALID");
  return buildUnsignedPayloadFromBytes(
    input.payload,
    await bounded(resolve(root, input.rawEvidencePath)),
    await bounded(resolve(root, input.reportPath)),
    await bounded(resolve(root, input.spendRequestPath)),
    await bounded(resolve(root, input.assessmentPath)),
    options,
  );
}
export function buildUnsignedPayloadFromBundle(input, options = {}) {
  if (
    !object(input) ||
    Reflect.ownKeys(input).length !== 7 ||
    input.schemaVersion !== 1 ||
    input.mode !== "BUNDLE" ||
    typeof input.assessmentBase64 !== "string" ||
    !input.payload
  )
    fail("UNSIGNED_INPUT_INVALID");
  return buildUnsignedPayloadFromBytes(
    input.payload,
    decode(input.rawEvidenceBase64),
    decode(input.reportBase64),
    decode(input.spendRequestBase64),
    decode(input.assessmentBase64),
    options,
  );
}

function canonicalAuthorityFromEnvironment(environment = process.env) {
  return {
    repositoryId: Number(environment.GITHUB_REPOSITORY_ID),
    workflowPath: environment.OCR_AUTH_WORKFLOW_PATH,
    workflowSha: environment.OCR_AUTH_WORKFLOW_SHA,
    workflowRunId: Number(environment.GITHUB_RUN_ID),
    workflowRunAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
    workflowHeadSha: environment.OCR_AUTH_WORKFLOW_HEAD_SHA,
    workflowHeadTree: environment.OCR_AUTH_WORKFLOW_HEAD_TREE,
    subjectSha: environment.OCR_SUBJECT_SHA,
    subjectTree: environment.OCR_SUBJECT_TREE,
    artifactId: Number(environment.OCR_RAW_ARTIFACT_ID),
    artifactName: environment.OCR_RAW_ARTIFACT_NAME,
    artifactDigest: environment.OCR_RAW_ARTIFACT_DIGEST,
    memberName: environment.OCR_RAW_ARTIFACT_MEMBER,
  };
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
      object(input) &&
      Object.hasOwn(input, "evidenceClass") &&
      Object.hasOwn(input, "report") &&
      Object.hasOwn(input, "rawEvidence")
        ? await assessCanonicalReport(
            input,
            canonicalAuthorityFromEnvironment(),
          )
        : input.mode === "BUNDLE"
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
