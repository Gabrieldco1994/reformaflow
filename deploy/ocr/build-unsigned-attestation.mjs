#!/usr/bin/env node
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  makeAttestationId,
  parseStrictJson,
  sha256,
  prepareRuntimeReleaseDraft,
} from "../../scripts/ci/ocr-attestation.mjs";

function fail(code) {
  throw new Error(code);
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
function same(left, right) {
  return canonicalize(left) === canonicalize(right);
}
async function stdinText() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 90 * 1024 * 1024) fail("UNSIGNED_INPUT_INVALID");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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

function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    fail("REPORT_AUTHORITY_INVALID");
}
function safeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail("REPORT_AUTHORITY_INVALID");
}
function hash(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    fail("REPORT_AUTHORITY_INVALID");
}
function commit(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
    fail("REPORT_AUTHORITY_INVALID");
}
function nonempty(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 192)
    fail("REPORT_AUTHORITY_INVALID");
}
function validateReportAuthority(report, payload) {
  exact(report, [
    "schemaVersion",
    "releaseStatus",
    "evidenceClass",
    "rawEvidenceSha256",
    "provider",
    "requestIds",
    "responseIds",
    "spend",
    "baseline",
    "candidate",
    "comparison",
  ]);
  if (
    report.schemaVersion !== 1 ||
    report.releaseStatus !== "PASS" ||
    report.evidenceClass !== "LIVE"
  )
    fail("REPORT_NOT_SIGNABLE");
  exact(report.baseline, ["gitSha", "treeSha", "executionKind", "cases"]);
  exact(report.candidate, ["gitSha", "treeSha", "executionKind", "cases"]);
  exact(report.comparison, ["cases"]);
  commit(report.baseline.gitSha);
  commit(report.baseline.treeSha);
  commit(report.candidate.gitSha);
  commit(report.candidate.treeSha);
  if (
    report.baseline.executionKind !== "HISTORICAL_REAL" ||
    report.candidate.executionKind !== "VERTEX_LIVE" ||
    report.candidate.gitSha !== payload.subject.git.sha ||
    report.candidate.treeSha !== payload.subject.git.tree
  )
    fail("REPORT_AUTHORITY_INVALID");
  if (
    !Array.isArray(report.baseline.cases) ||
    !Array.isArray(report.candidate.cases) ||
    !Array.isArray(report.comparison?.cases) ||
    report.baseline.cases.length !== 18 ||
    report.candidate.cases.length !== 18 ||
    report.comparison.cases.length !== 18
  )
    fail("REPORT_AUTHORITY_INVALID");
  const ids = new Set();
  for (let index = 0; index < 18; index += 1) {
    const baseline = report.baseline.cases[index];
    const candidate = report.candidate.cases[index];
    const comparison = report.comparison.cases[index];
    exact(baseline, [
      "caseId",
      "artifactSha256",
      "outcome",
      "providerGenerationCalls",
    ]);
    exact(candidate, [
      "caseId",
      "artifactSha256",
      "outcome",
      "requestId",
      "responseId",
      "usage",
      "parsedCandidateFacts",
    ]);
    exact(comparison, ["caseId", "pass", "issues"]);
    nonempty(baseline.caseId);
    hash(baseline.artifactSha256);
    nonempty(candidate.caseId);
    hash(candidate.artifactSha256);
    if (
      ids.has(baseline.caseId) ||
      baseline.caseId !== candidate.caseId ||
      baseline.caseId !== comparison.caseId ||
      baseline.artifactSha256 !== candidate.artifactSha256 ||
      baseline.outcome !== "OCR_REQUIRED" ||
      baseline.providerGenerationCalls !== 0 ||
      candidate.requestId !== report.requestIds[index] ||
      candidate.responseId !== report.responseIds[index] ||
      comparison.pass !== true ||
      !Array.isArray(comparison.issues) ||
      comparison.issues.length !== 0
    )
      fail("REPORT_AUTHORITY_INVALID");
    ids.add(baseline.caseId);
    nonempty(candidate.outcome);
    nonempty(candidate.requestId);
    nonempty(candidate.responseId);
    exact(candidate.usage, ["inputTokens", "outputTokens", "totalTokens"]);
    safeInteger(candidate.usage.inputTokens);
    safeInteger(candidate.usage.outputTokens);
    safeInteger(candidate.usage.totalTokens);
    if (
      candidate.usage.totalTokens !==
        candidate.usage.inputTokens + candidate.usage.outputTokens ||
      !candidate.parsedCandidateFacts ||
      typeof candidate.parsedCandidateFacts !== "object" ||
      Array.isArray(candidate.parsedCandidateFacts)
    )
      fail("REPORT_AUTHORITY_INVALID");
  }
}

export function buildUnsignedPayloadFromBytes(
  payloadInput,
  raw,
  reportBytes,
  spendRequestBytes,
) {
  const report = parseStrictJson(reportBytes.toString("utf8"));
  const spendRequest = parseStrictJson(spendRequestBytes.toString("utf8"));
  const payload = structuredClone(payloadInput);
  payload.attestationId = "0".repeat(64);
  if (
    payload.evidence.raw.sha256 !== sha256(raw) ||
    payload.evidence.raw.size !== raw.length ||
    payload.evidence.report.sha256 !== sha256(reportBytes) ||
    payload.evidence.report.size !== reportBytes.length
  )
    fail("EVIDENCE_ARTIFACT_MISMATCH");
  if (
    report.spend?.admissionSha256 !== sha256(canonicalize(spendRequest)) ||
    spendRequest.subjectSha !== payload.subject.git.sha ||
    spendRequest.productionImage !==
      payload.subject.productionImage.reference ||
    spendRequest.qualificationImageDigest !==
      payload.subject.qualificationImage.digest ||
    spendRequest.executableDigest !==
      payload.subject.qualificationImage.executableDigest ||
    spendRequest.reviewSetSha256 !== sha256(canonicalize(payload.reviews))
  )
    fail("SPEND_BINDING_INVALID");
  validateReportAuthority(report, payload);
  if (
    report.rawEvidenceSha256 !== payload.evidence.raw.sha256 ||
    !same(report.requestIds, payload.evidence.requestIds) ||
    !same(report.responseIds, payload.evidence.responseIds) ||
    !same(report.provider, payload.provider) ||
    !same(report.spend, {
      measuredMicros: payload.spend.measuredMicros,
      admissionSha256: payload.spend.admissionSha256,
      admittedAt: payload.spend.admittedAt,
    })
  )
    fail("REPORT_BINDING_INVALID");
  payload.attestationId = "0".repeat(64);
  return prepareRuntimeReleaseDraft(payload);
}

export async function buildUnsignedPayload(input, root = process.cwd()) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
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
  );
}

export function buildUnsignedPayloadFromBundle(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
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
  );
}

const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [inputPath, root] = process.argv.slice(2);
  try {
    if (!inputPath) fail("USAGE_INVALID");
    const input = parseStrictJson(
      inputPath === "-"
        ? await new Response(process.stdin).text()
        : await readFile(inputPath, "utf8"),
    );
    const payload =
      input.mode === "BUNDLE"
        ? buildUnsignedPayloadFromBundle(input)
        : await buildUnsignedPayload(input, resolve(root ?? process.cwd()));
    process.stdout.write(canonicalize(payload));
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "UNSIGNED_ATTESTATION_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
