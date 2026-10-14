#!/usr/bin/env node
import {
  parseStrictJson,
  reserveSpend,
  assertSpendReservation,
  sha256,
  canonicalize,
  validateReviewSet,
} from "../../scripts/ci/ocr-attestation.mjs";

const MAX_TOKEN_BYTES = 16 * 1024;
const ROOT = "/opt/qualification";
const RESERVATION = "/run/ocr/spend-reservation.json";

function fail(code) {
  throw new Error(code);
}

async function readToken() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_TOKEN_BYTES) fail("WIF_TOKEN_INVALID");
    chunks.push(chunk);
  }
  const token = Buffer.concat(chunks).toString("utf8").trim();
  if (!/^[A-Za-z0-9._~-]{20,16384}$/.test(token)) fail("WIF_TOKEN_INVALID");
  return token;
}

function authenticatedReviewSet() {
  const reviews = parseStrictJson(
    Buffer.from(process.env.OCR_REVIEW_SET_B64 ?? "", "base64").toString(
      "utf8",
    ),
  );
  validateReviewSet(reviews, {
    subjectSha: process.env.OCR_SUBJECT_SHA,
    subjectTree: process.env.OCR_SUBJECT_TREE,
    policySha256: process.env.OCR_POLICY_SHA256,
    runId: process.env.OCR_WORKFLOW_RUN_ID,
    runAttempt: Number(process.env.OCR_WORKFLOW_RUN_ATTEMPT),
  });
  return reviews;
}

async function main() {
  if (
    process.env.OCR_CAPTURE_AUTH_MODE !== "GITHUB_OIDC_WIF" ||
    process.env.OCR_KMS_KEY_RESOURCE ||
    process.env.OCR_KMS_SIGNING_SERVICE_ACCOUNT
  )
    fail("CAPTURE_CAPABILITY_INVALID");
  const reviews = authenticatedReviewSet();
  const reviewSetSha256 = sha256(canonicalize(reviews));
  const request = parseStrictJson(
    Buffer.from(process.env.OCR_SPEND_REQUEST_B64 ?? "", "base64").toString(
      "utf8",
    ),
  );
  if (request.reviewSetSha256 !== reviewSetSha256) fail("REVIEW_SET_INVALID");
  if (
    request.subjectSha !== process.env.OCR_SUBJECT_SHA ||
    request.subjectTree !== process.env.OCR_SUBJECT_TREE ||
    request.productionImage !== process.env.OCR_PRODUCTION_IMAGE ||
    request.qualificationImageDigest !==
      process.env.OCR_QUALIFICATION_IMAGE_DIGEST ||
    request.executableDigest !== process.env.OCR_EXECUTABLE_DIGEST ||
    request.workflowSha !== process.env.OCR_WORKFLOW_SHA ||
    request.corpusSha256 !== process.env.OCR_CORPUS_SHA256 ||
    request.requestedModelAlias !== process.env.OCR_REQUESTED_MODEL_ALIAS ||
    request.promptSha256 !== process.env.OCR_PROMPT_SHA256 ||
    request.inputMicrosPerMillionTokens !==
      Number(process.env.OCR_INPUT_MICROS_PER_MILLION_TOKENS) ||
    request.outputMicrosPerMillionTokens !==
      Number(process.env.OCR_OUTPUT_MICROS_PER_MILLION_TOKENS) ||
    request.expectedCaseCount !== Number(process.env.OCR_EXPECTED_CASE_COUNT)
  )
    fail("CAPTURE_BINDING_INVALID");
  const reservation = await reserveSpend(request, RESERVATION);
  try {
    await assertSpendReservation(reservation, RESERVATION);
    const token = await readToken();
    if (!token) fail("WIF_TOKEN_INVALID");
    await assertSpendReservation(reservation, RESERVATION);
    const projectId = process.env.OCR_GCP_PROJECT_ID?.trim();
    if (!projectId) fail("OCR_CAPTURE_WIF_EXECUTABLE_NOT_AVAILABLE");
    const captureModule =
      await import("../../apps/api/dist/imports/ocr-synth-v1/capture-live.js");
    if (typeof captureModule.runProtectedWifLiveCapture !== "function")
      fail("OCR_CAPTURE_WIF_EXECUTABLE_NOT_AVAILABLE");
    await captureModule.runProtectedWifLiveCapture({
      authMode: "GITHUB_OIDC_WIF",
      projectId,
    });
    fail("OCR_CAPTURE_WIF_EXECUTABLE_NOT_AVAILABLE");
  } finally {
    await reservation.handle.close().catch(() => undefined);
  }
}

void main().catch((error) => {
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "OCR_CAPTURE_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
