#!/usr/bin/env node
import {
  parseStrictJson,
  reserveSpend,
  assertSpendReservation,
  sha256,
  canonicalize,
  validateReviewSet,
} from "../../scripts/ci/ocr-attestation.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TOKEN_BYTES = 16 * 1024;
const RESERVATION = "/run/ocr/spend-reservation.json";
const EXPECTED_CURRENCY = "USD";
const EXPECTED_PROVIDER = "GOOGLE_VERTEX_AI";
const EXPECTED_REGION = "southamerica-east1";
const EXPECTED_ENDPOINT =
  "https://southamerica-east1-aiplatform.googleapis.com";

function fail(code) {
  throw new Error(code);
}

async function readToken(stream = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_TOKEN_BYTES) fail("WIF_TOKEN_INVALID");
    chunks.push(chunk);
  }
  const token = Buffer.concat(chunks).toString("utf8").trim();
  if (!/^[A-Za-z0-9._~-]{20,16384}$/.test(token)) fail("WIF_TOKEN_INVALID");
  return token;
}

function authenticatedReviewSet(environment = process.env) {
  const reviews = parseStrictJson(
    Buffer.from(environment.OCR_REVIEW_SET_B64 ?? "", "base64").toString(
      "utf8",
    ),
  );
  validateReviewSet(reviews, {
    subjectSha: environment.OCR_SUBJECT_SHA,
    subjectTree: environment.OCR_SUBJECT_TREE,
    policySha256: environment.OCR_POLICY_SHA256,
    runId: environment.OCR_WORKFLOW_RUN_ID,
    runAttempt: Number(environment.OCR_WORKFLOW_RUN_ATTEMPT),
  });
  return reviews;
}

function authenticateRequest(environment) {
  const reviews = authenticatedReviewSet(environment);
  const reviewSetSha256 = sha256(canonicalize(reviews));
  const request = parseStrictJson(
    Buffer.from(environment.OCR_SPEND_REQUEST_B64 ?? "", "base64").toString(
      "utf8",
    ),
  );
  if (request.reviewSetSha256 !== reviewSetSha256) fail("REVIEW_SET_INVALID");
  if (
    request.subjectSha !== environment.OCR_SUBJECT_SHA ||
    request.subjectTree !== environment.OCR_SUBJECT_TREE ||
    request.productionImage !== environment.OCR_PRODUCTION_IMAGE ||
    request.qualificationImageDigest !==
      environment.OCR_QUALIFICATION_IMAGE_DIGEST ||
    request.executableDigest !== environment.OCR_EXECUTABLE_DIGEST ||
    request.workflowSha !== environment.OCR_WORKFLOW_SHA ||
    request.policySha256 !== environment.OCR_POLICY_SHA256 ||
    request.corpusSha256 !== environment.OCR_CORPUS_SHA256 ||
    String(request.runId) !== environment.OCR_WORKFLOW_RUN_ID ||
    request.runAttempt !== Number(environment.OCR_WORKFLOW_RUN_ATTEMPT) ||
    request.currency !== EXPECTED_CURRENCY ||
    request.hardLimitMicros !== Number(environment.OCR_MAX_TOTAL_COST_MICROS) ||
    request.reservedMicros !== Number(environment.OCR_MAX_TOTAL_COST_MICROS) ||
    request.provider !== EXPECTED_PROVIDER ||
    request.requestedModelAlias !== environment.OCR_REQUESTED_MODEL_ALIAS ||
    request.region !== EXPECTED_REGION ||
    request.endpoint !== EXPECTED_ENDPOINT ||
    request.promptSha256 !== environment.OCR_PROMPT_SHA256 ||
    request.inputMicrosPerMillionTokens !==
      Number(environment.OCR_INPUT_MICROS_PER_MILLION_TOKENS) ||
    request.outputMicrosPerMillionTokens !==
      Number(environment.OCR_OUTPUT_MICROS_PER_MILLION_TOKENS) ||
    request.expectedCaseCount !== Number(environment.OCR_EXPECTED_CASE_COUNT)
  )
    fail("CAPTURE_BINDING_INVALID");
  return request;
}

const defaultDependencies = Object.freeze({
  authenticateRequest,
  reserve: (request) => reserveSpend(request, RESERVATION),
  assertReservation: (reservation) =>
    assertSpendReservation(reservation, RESERVATION),
  readToken: () => readToken(),
  capture: async (input) => {
    const captureModule =
      await import("../../apps/api/dist/imports/ocr-synth-v1/capture-live.js");
    if (typeof captureModule.runProtectedWifLiveCapture !== "function")
      fail("OCR_CAPTURE_WIF_EXECUTABLE_NOT_AVAILABLE");
    return await captureModule.runProtectedWifLiveCapture(input);
  },
  write: (value) => process.stdout.write(value),
});

export async function runWifCaptureAdapter(
  environment = process.env,
  dependencies = {},
) {
  const runtime = { ...defaultDependencies, ...dependencies };
  if (
    environment.OCR_CAPTURE_AUTH_MODE !== "GITHUB_OIDC_WIF" ||
    environment.OCR_KMS_KEY_RESOURCE ||
    environment.OCR_KMS_SIGNING_SERVICE_ACCOUNT
  )
    fail("CAPTURE_CAPABILITY_INVALID");
  const projectId = environment.OCR_GCP_PROJECT_ID?.trim();
  if (!projectId) fail("OCR_CAPTURE_WIF_CONFIG_INVALID");
  const request = await runtime.authenticateRequest(environment);
  const reservation = await runtime.reserve(request);
  try {
    await runtime.assertReservation(reservation);
    const token = await runtime.readToken();
    if (!token) fail("WIF_TOKEN_INVALID");
    await runtime.assertReservation(reservation);
    const evidence = await runtime.capture({
      authMode: "GITHUB_OIDC_WIF",
      projectId,
      accessToken: token,
    });
    await runtime.assertReservation(reservation);
    runtime.write(`${canonicalize(evidence)}\n`);
    return evidence;
  } finally {
    await reservation.handle.close().catch(() => undefined);
  }
}

const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked)
  void runWifCaptureAdapter().catch((error) => {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "OCR_CAPTURE_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
