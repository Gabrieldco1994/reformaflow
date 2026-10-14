#!/usr/bin/env node
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;
const DECIMAL_ID = /^[1-9][0-9]*$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const WORKFLOW_PATH = ".github/workflows/ocr-qualification.yml";
const REVIEW_ROLES = Object.freeze([
  "DATA_OWNER_RISK_ACCEPTANCE",
  "SECURITY",
  "PRIVACY",
  "DATA_OWNER_FINAL",
]);
const PROVIDER = "GOOGLE_VERTEX_AI";
const MODEL = "gemini-2.5-flash";
const REGION = "southamerica-east1";
const ENDPOINT = "https://southamerica-east1-aiplatform.googleapis.com";
const KMS_ALGORITHM = "EC_SIGN_P256_SHA256";
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const QUALIFICATION_HARD_LIMIT_MICROS = 502_000;

function fail(code) {
  throw new Error(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, keys, code = "ATTESTATION_SCHEMA_INVALID") {
  if (!isObject(value)) fail(code);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    fail(code);
  return value;
}

function string(value, code = "ATTESTATION_SCHEMA_INVALID") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.normalize("NFC")
  )
    fail(code);
  return value;
}

function integer(value, minimum = 0, code = "ATTESTATION_SCHEMA_INVALID") {
  if (!Number.isSafeInteger(value) || value < minimum || Object.is(value, -0))
    fail(code);
  return value;
}

function match(value, pattern, code = "ATTESTATION_SCHEMA_INVALID") {
  string(value, code);
  if (!pattern.test(value)) fail(code);
  return value;
}

function utc(value, code = "ATTESTATION_SCHEMA_INVALID") {
  match(value, ISO_UTC, code);
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString() !== value.replace(/(?<!\.\d{3})Z$/, ".000Z")
  )
    fail(code);
  return parsed;
}

function canonicalP256DerSignature(value, code = "SIGNATURE_INVALID") {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "base64");
  if (!Buffer.isBuffer(value) && bytes.toString("base64") !== value) fail(code);
  if (
    bytes.length < 8 ||
    bytes.length > 72 ||
    bytes[0] !== 0x30 ||
    bytes[1] !== bytes.length - 2
  )
    fail(code);
  let offset = 2;
  for (let index = 0; index < 2; index += 1) {
    if (bytes[offset] !== 0x02) fail(code);
    const length = bytes[offset + 1];
    const start = offset + 2;
    const end = start + length;
    if (
      length < 1 ||
      length > 33 ||
      end > bytes.length ||
      (bytes[start] & 0x80) !== 0 ||
      (length > 1 && bytes[start] === 0 && (bytes[start + 1] & 0x80) === 0)
    )
      fail(code);
    offset = end;
  }
  if (offset !== bytes.length) fail(code);
  return bytes;
}

function p256PublicKey(pem, expectedHash, code = "TRUST_BUNDLE_INVALID") {
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    fail(code);
  }
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    fail(code);
  if (sha256(key.export({ type: "spki", format: "der" })) !== expectedHash)
    fail(code);
  return key;
}

class StrictJsonParser {
  constructor(text) {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_JSON_BYTES)
      fail("JSON_INVALID");
    this.text = text;
    this.index = 0;
  }
  parse() {
    const value = this.value();
    this.space();
    if (this.index !== this.text.length) fail("JSON_INVALID");
    return value;
  }
  space() {
    while (/[\u0009\u000a\u000d\u0020]/.test(this.text[this.index] ?? ""))
      this.index += 1;
  }
  value() {
    this.space();
    const character = this.text[this.index];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"') return this.string();
    if (character === "t") return this.literal("true", true);
    if (character === "f") return this.literal("false", false);
    if (character === "n") return this.literal("null", null);
    return this.number();
  }
  literal(token, value) {
    if (this.text.slice(this.index, this.index + token.length) !== token)
      fail("JSON_INVALID");
    this.index += token.length;
    return value;
  }
  object() {
    this.index += 1;
    const value = Object.create(null);
    const names = new Set();
    this.space();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return value;
    }
    for (;;) {
      this.space();
      if (this.text[this.index] !== '"') fail("JSON_INVALID");
      const name = this.string();
      if (names.has(name)) fail("JSON_DUPLICATE_KEY");
      names.add(name);
      this.space();
      if (this.text[this.index] !== ":") fail("JSON_INVALID");
      this.index += 1;
      value[name] = this.value();
      this.space();
      const delimiter = this.text[this.index];
      this.index += 1;
      if (delimiter === "}") return value;
      if (delimiter !== ",") fail("JSON_INVALID");
    }
  }
  array() {
    this.index += 1;
    const value = [];
    this.space();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return value;
    }
    for (;;) {
      value.push(this.value());
      this.space();
      const delimiter = this.text[this.index];
      this.index += 1;
      if (delimiter === "]") return value;
      if (delimiter !== ",") fail("JSON_INVALID");
    }
  }
  string() {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    for (;;) {
      const character = this.text[this.index];
      if (character === undefined || character.charCodeAt(0) < 0x20)
        fail("JSON_INVALID");
      if (escaped) {
        if (character === "u") {
          if (
            !/^[0-9a-fA-F]{4}$/.test(
              this.text.slice(this.index + 1, this.index + 5),
            )
          )
            fail("JSON_INVALID");
          this.index += 5;
        } else {
          if (!'"\\/bfnrt'.includes(character)) fail("JSON_INVALID");
          this.index += 1;
        }
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        this.index += 1;
        continue;
      }
      if (character === '"') {
        this.index += 1;
        try {
          const result = JSON.parse(this.text.slice(start, this.index));
          if (result !== result.normalize("NFC")) fail("JSON_STRING_NOT_NFC");
          return result;
        } catch (error) {
          if (error instanceof Error && error.message === "JSON_STRING_NOT_NFC")
            throw error;
          fail("JSON_INVALID");
        }
      }
      this.index += 1;
    }
  }
  number() {
    const rest = this.text.slice(this.index);
    const found = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      rest,
    )?.[0];
    if (!found) fail("JSON_INVALID");
    this.index += found.length;
    const value = Number(found);
    if (
      !Number.isSafeInteger(value) ||
      Object.is(value, -0) ||
      String(value) !== found
    )
      fail("JSON_NUMBER_NOT_CANONICAL_INTEGER");
    return value;
  }
}

export function parseStrictJson(text) {
  return new StrictJsonParser(text).parse();
}

export function canonicalize(value) {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") {
    if (value !== value.normalize("NFC")) fail("CANONICAL_STRING_NOT_NFC");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0))
      fail("CANONICAL_NUMBER_INVALID");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (!isObject(value)) fail("CANONICAL_VALUE_INVALID");
  const names = Object.keys(value).sort();
  return `{${names.map((name) => `${JSON.stringify(name)}:${canonicalize(value[name])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateRuntimeReleasePayload(payload) {
  exact(
    payload,
    [
      "schemaVersion",
      "kind",
      "verdict",
      "activationSubjectSha256",
      "subject",
      "workflow",
      "closure",
      "provider",
      "validity",
    ],
    "RUNTIME_PAYLOAD_INVALID",
  );
  if (
    payload.schemaVersion !== 1 ||
    payload.kind !== "REFORMAFLOW_OCR_RELEASE" ||
    payload.verdict !== "PASS"
  )
    fail("RUNTIME_PAYLOAD_INVALID");
  match(payload.activationSubjectSha256, HASH, "RUNTIME_PAYLOAD_INVALID");
  exact(
    payload.subject,
    [
      "commitSha",
      "treeSha",
      "imageDigest",
      "ociConfigDigest",
      "applicationEntrypointPath",
      "applicationEntrypointSize",
      "executableSha256",
      "runtimeSubjectArtifactSha256",
    ],
    "RUNTIME_PAYLOAD_INVALID",
  );
  match(payload.subject.commitSha, COMMIT, "RUNTIME_PAYLOAD_INVALID");
  match(payload.subject.treeSha, COMMIT, "RUNTIME_PAYLOAD_INVALID");
  match(payload.subject.imageDigest, DIGEST, "RUNTIME_PAYLOAD_INVALID");
  match(payload.subject.ociConfigDigest, DIGEST, "RUNTIME_PAYLOAD_INVALID");
  if (
    !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(
      payload.subject.applicationEntrypointPath,
    ) ||
    !Number.isSafeInteger(payload.subject.applicationEntrypointSize) ||
    payload.subject.applicationEntrypointSize <= 0
  )
    fail("RUNTIME_PAYLOAD_INVALID");
  match(payload.subject.executableSha256, HASH, "RUNTIME_PAYLOAD_INVALID");
  match(
    payload.subject.runtimeSubjectArtifactSha256,
    HASH,
    "RUNTIME_PAYLOAD_INVALID",
  );
  exact(
    payload.workflow,
    ["repository", "workflowSha", "runId", "runAttempt"],
    "RUNTIME_PAYLOAD_INVALID",
  );
  if (payload.workflow.repository !== "Gabrieldco1994/reformaflow")
    fail("RUNTIME_PAYLOAD_INVALID");
  match(payload.workflow.workflowSha, COMMIT, "RUNTIME_PAYLOAD_INVALID");
  match(payload.workflow.runId, DECIMAL_ID, "RUNTIME_PAYLOAD_INVALID");
  integer(payload.workflow.runAttempt, 1, "RUNTIME_PAYLOAD_INVALID");
  exact(
    payload.closure,
    [
      "policySha256",
      "corpusSha256",
      "rawEvidenceSha256",
      "reportSha256",
      "reviews",
    ],
    "RUNTIME_PAYLOAD_INVALID",
  );
  for (const value of [
    payload.closure.policySha256,
    payload.closure.corpusSha256,
    payload.closure.rawEvidenceSha256,
    payload.closure.reportSha256,
  ])
    match(value, HASH, "RUNTIME_PAYLOAD_INVALID");
  if (
    !Array.isArray(payload.closure.reviews) ||
    payload.closure.reviews.length !== REVIEW_ROLES.length
  )
    fail("RUNTIME_PAYLOAD_INVALID");
  for (let index = 0; index < REVIEW_ROLES.length; index += 1) {
    const review = payload.closure.reviews[index];
    exact(review, ["role", "descriptorSha256"], "RUNTIME_PAYLOAD_INVALID");
    if (review.role !== REVIEW_ROLES[index]) fail("RUNTIME_PAYLOAD_INVALID");
    match(review.descriptorSha256, HASH, "RUNTIME_PAYLOAD_INVALID");
  }
  exact(
    payload.provider,
    ["provider", "model", "region", "endpoint", "modelVersion", "promptSha256"],
    "RUNTIME_PAYLOAD_INVALID",
  );
  if (
    payload.provider.provider !== PROVIDER ||
    payload.provider.model !== MODEL ||
    payload.provider.region !== REGION ||
    payload.provider.endpoint !== ENDPOINT ||
    !/^[!-~]{1,192}$/.test(payload.provider.modelVersion)
  )
    fail("RUNTIME_PAYLOAD_INVALID");
  match(payload.provider.promptSha256, HASH, "RUNTIME_PAYLOAD_INVALID");
  exact(
    payload.validity,
    ["issuedAt", "notBefore", "expiresAt"],
    "RUNTIME_PAYLOAD_INVALID",
  );
  const issued = utc(payload.validity.issuedAt, "RUNTIME_PAYLOAD_INVALID");
  const notBefore = utc(payload.validity.notBefore, "RUNTIME_PAYLOAD_INVALID");
  const expires = utc(payload.validity.expiresAt, "RUNTIME_PAYLOAD_INVALID");
  if (
    notBefore.valueOf() > issued.valueOf() ||
    issued.valueOf() >= expires.valueOf() ||
    expires.valueOf() - issued.valueOf() > 24 * 60 * 60 * 1000
  )
    fail("RUNTIME_PAYLOAD_INVALID");
  return payload;
}

function activationSubject(activationPayload) {
  const value = structuredClone(activationPayload);
  delete value.attestationId;
  delete value.runtimeRelease;
  return value;
}

export function activationSubjectSha256(activationPayload) {
  return sha256(canonicalize(activationSubject(activationPayload)));
}

function projectRuntimeReleasePayload(activationPayload) {
  const payload = {
    schemaVersion: 1,
    kind: "REFORMAFLOW_OCR_RELEASE",
    verdict: "PASS",
    activationSubjectSha256: activationSubjectSha256(activationPayload),
    subject: {
      commitSha: activationPayload.subject.git.sha,
      treeSha: activationPayload.subject.git.tree,
      imageDigest: activationPayload.subject.productionImage.digest,
      ociConfigDigest:
        activationPayload.subject.productionImage.ociConfigDigest,
      applicationEntrypointPath:
        activationPayload.subject.productionImage.applicationEntrypointPath,
      applicationEntrypointSize:
        activationPayload.subject.productionImage.applicationEntrypointSize,
      executableSha256:
        activationPayload.subject.productionImage.executableSha256,
      runtimeSubjectArtifactSha256:
        activationPayload.subject.productionImage.runtimeSubjectArtifactSha256,
    },
    workflow: {
      repository: activationPayload.subject.repository.name,
      workflowSha: activationPayload.workflow.sha,
      runId: activationPayload.workflow.runId,
      runAttempt: activationPayload.workflow.runAttempt,
    },
    closure: {
      policySha256: activationPayload.policy.sha256,
      corpusSha256: activationPayload.corpus.sha256,
      rawEvidenceSha256: activationPayload.evidence.raw.sha256,
      reportSha256: activationPayload.evidence.report.sha256,
      reviews: activationPayload.reviews.map((review) => ({
        role: review.role,
        descriptorSha256: review.sha256,
      })),
    },
    provider: {
      provider: activationPayload.provider.provider,
      model: activationPayload.provider.model,
      region: activationPayload.provider.region,
      endpoint: activationPayload.provider.endpoint,
      modelVersion: activationPayload.provider.modelVersion,
      promptSha256: activationPayload.provider.promptSha256,
    },
    validity: structuredClone(activationPayload.validity),
  };
  validateRuntimeReleasePayload(payload);
  return payload;
}

export function prepareRuntimeReleaseDraft(activationPayloadInput) {
  const activationPayloadDraft = structuredClone(activationPayloadInput);
  activationPayloadDraft.attestationId = "0".repeat(64);
  const runtimePayload = projectRuntimeReleasePayload(activationPayloadDraft);
  const runtimePayloadBytes = Buffer.from(canonicalize(runtimePayload));
  activationPayloadDraft.runtimeRelease = {
    activationSubjectSha256: runtimePayload.activationSubjectSha256,
    runtimeEnvelopeSha256: "0".repeat(64),
  };
  validatePayload(activationPayloadDraft, { allowRuntimeDraft: true });
  return Object.freeze({
    schemaVersion: 1,
    activationPayloadDraft,
    runtimePayloadBase64: runtimePayloadBytes.toString("base64"),
  });
}

export function validateTrustBundle(trust) {
  exact(trust, ["schemaVersion", "keys"], "TRUST_BUNDLE_INVALID");
  if (trust.schemaVersion !== 1 || !Array.isArray(trust.keys))
    fail("TRUST_BUNDLE_INVALID");
  for (const key of trust.keys) {
    exact(
      key,
      [
        "keyId",
        "algorithm",
        "publicKeyPem",
        "publicKeySha256",
        "notBefore",
        "notAfter",
        "allowedWorkflowSha",
      ],
      "TRUST_BUNDLE_INVALID",
    );
    string(key.keyId, "TRUST_BUNDLE_INVALID");
    if (
      key.algorithm !== KMS_ALGORITHM ||
      !key.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----\n")
    )
      fail("TRUST_BUNDLE_INVALID");
    match(key.publicKeySha256, HASH, "TRUST_BUNDLE_INVALID");
    match(key.allowedWorkflowSha, COMMIT, "TRUST_BUNDLE_INVALID");
    p256PublicKey(key.publicKeyPem, key.publicKeySha256);
    if (
      utc(key.notBefore, "TRUST_BUNDLE_INVALID").valueOf() >=
      utc(key.notAfter, "TRUST_BUNDLE_INVALID").valueOf()
    )
      fail("TRUST_BUNDLE_INVALID");
  }
  if (new Set(trust.keys.map((key) => key.keyId)).size !== trust.keys.length)
    fail("TRUST_BUNDLE_INVALID");
  return trust;
}

export function makeRuntimeReleaseEnvelope(payloadBytes, signature) {
  if (
    !Buffer.isBuffer(payloadBytes) ||
    payloadBytes.length === 0 ||
    payloadBytes.length > MAX_JSON_BYTES
  )
    fail("RUNTIME_ENVELOPE_INVALID");
  validateRuntimeReleasePayload(parseStrictJson(payloadBytes.toString("utf8")));
  exact(
    signature,
    ["keyId", "algorithm", "valueBase64"],
    "RUNTIME_ENVELOPE_INVALID",
  );
  string(signature.keyId, "RUNTIME_ENVELOPE_INVALID");
  if (
    signature.algorithm !== KMS_ALGORITHM ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signature.valueBase64)
  )
    fail("RUNTIME_ENVELOPE_INVALID");
  canonicalP256DerSignature(signature.valueBase64, "RUNTIME_ENVELOPE_INVALID");
  return {
    schemaVersion: 1,
    payloadBase64: payloadBytes.toString("base64"),
    signature,
  };
}

export async function verifyRuntimeReleaseEnvelope(
  envelope,
  trust,
  options = {},
) {
  exact(
    envelope,
    ["schemaVersion", "payloadBase64", "signature"],
    "RUNTIME_ENVELOPE_INVALID",
  );
  if (
    envelope.schemaVersion !== 1 ||
    typeof envelope.payloadBase64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      envelope.payloadBase64,
    )
  )
    fail("RUNTIME_ENVELOPE_INVALID");
  exact(
    envelope.signature,
    ["keyId", "algorithm", "valueBase64"],
    "RUNTIME_ENVELOPE_INVALID",
  );
  if (
    envelope.signature.algorithm !== KMS_ALGORITHM ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature.valueBase64)
  )
    fail("RUNTIME_ENVELOPE_INVALID");
  const payloadBytes = Buffer.from(envelope.payloadBase64, "base64");
  if (
    payloadBytes.length === 0 ||
    payloadBytes.toString("base64") !== envelope.payloadBase64
  )
    fail("RUNTIME_ENVELOPE_INVALID");
  const payload = validateRuntimeReleasePayload(
    parseStrictJson(payloadBytes.toString("utf8")),
  );
  validateTrustBundle(trust);
  const matches = trust.keys.filter(
    (key) => key.keyId === envelope.signature.keyId,
  );
  if (matches.length !== 1) fail("KEY_NOT_ALLOWLISTED");
  const key = matches[0];
  if (
    key.algorithm !== envelope.signature.algorithm ||
    key.allowedWorkflowSha !== payload.workflow.workflowSha
  )
    fail("KEY_NOT_ALLOWLISTED");
  const now = options.now ?? new Date();
  if (
    !(now instanceof Date) ||
    Number.isNaN(now.valueOf()) ||
    now.valueOf() < utc(key.notBefore).valueOf() ||
    now.valueOf() >= utc(key.notAfter).valueOf() ||
    now.valueOf() < utc(payload.validity.notBefore).valueOf() ||
    now.valueOf() >= utc(payload.validity.expiresAt).valueOf()
  )
    fail("ATTESTATION_EXPIRED");
  const publicKey = p256PublicKey(
    key.publicKeyPem,
    key.publicKeySha256,
    "PUBLIC_KEY_HASH_INVALID",
  );
  const runtimeSignature = canonicalP256DerSignature(
    envelope.signature.valueBase64,
  );
  if (!verifySignature("sha256", payloadBytes, publicKey, runtimeSignature))
    fail("SIGNATURE_INVALID");
  if (
    options.expectedMainSha &&
    payload.subject.gitSha !== options.expectedMainSha
  )
    fail("STALE_MAIN");
  if (
    options.expectedProductionImageDigest &&
    payload.subject.imageDigest !== options.expectedProductionImageDigest
  )
    fail("STALE_PRODUCTION_IMAGE");
  if (
    options.expectedExecutableSha256 &&
    payload.subject.executableSha256 !== options.expectedExecutableSha256
  )
    fail("EXECUTABLE_BINDING_INVALID");
  return Object.freeze({ payload, payloadBytes });
}

export function verifyReleaseCrossBinding(
  activationPayload,
  runtimeEnvelopeBytes,
) {
  if (!isObject(activationPayload?.runtimeRelease))
    fail("ACTIVATION_SUBJECT_DIGEST_MISMATCH");
  const recomputedSubject = activationSubjectSha256(activationPayload);
  if (
    recomputedSubject !==
    activationPayload.runtimeRelease.activationSubjectSha256
  )
    fail("ACTIVATION_SUBJECT_DIGEST_MISMATCH");
  if (
    !Buffer.isBuffer(runtimeEnvelopeBytes) ||
    sha256(runtimeEnvelopeBytes) !==
      activationPayload.runtimeRelease.runtimeEnvelopeSha256
  )
    fail("RUNTIME_ENVELOPE_DIGEST_MISMATCH");
  validatePayload(activationPayload);
  const text = runtimeEnvelopeBytes.toString("utf8");
  const envelope = parseStrictJson(text);
  if (canonicalize(envelope) !== text) fail("RUNTIME_ENVELOPE_DIGEST_MISMATCH");
  exact(
    envelope,
    ["schemaVersion", "payloadBase64", "signature"],
    "RUNTIME_ENVELOPE_DIGEST_MISMATCH",
  );
  const runtimePayload = validateRuntimeReleasePayload(
    parseStrictJson(
      Buffer.from(envelope.payloadBase64, "base64").toString("utf8"),
    ),
  );
  if (runtimePayload.activationSubjectSha256 !== recomputedSubject)
    fail("ACTIVATION_SUBJECT_DIGEST_MISMATCH");
  return true;
}

export function finalizeActivationPayload(
  activationPayloadDraft,
  runtimeEnvelopeBytes,
) {
  validatePayload(activationPayloadDraft, { allowRuntimeDraft: true });
  const recomputedSubject = activationSubjectSha256(activationPayloadDraft);
  if (
    recomputedSubject !==
    activationPayloadDraft.runtimeRelease.activationSubjectSha256
  )
    fail("ACTIVATION_SUBJECT_DIGEST_MISMATCH");
  if (
    !Buffer.isBuffer(runtimeEnvelopeBytes) ||
    runtimeEnvelopeBytes.length === 0
  )
    fail("RUNTIME_ENVELOPE_DIGEST_MISMATCH");
  const text = runtimeEnvelopeBytes.toString("utf8");
  const envelope = parseStrictJson(text);
  if (canonicalize(envelope) !== text) fail("RUNTIME_ENVELOPE_DIGEST_MISMATCH");
  const runtimePayload = validateRuntimeReleasePayload(
    parseStrictJson(
      Buffer.from(envelope.payloadBase64, "base64").toString("utf8"),
    ),
  );
  if (
    runtimePayload.activationSubjectSha256 !== recomputedSubject ||
    canonicalize(projectRuntimeReleasePayload(activationPayloadDraft)) !==
      Buffer.from(envelope.payloadBase64, "base64").toString("utf8")
  )
    fail("ACTIVATION_SUBJECT_DIGEST_MISMATCH");
  const payload = structuredClone(activationPayloadDraft);
  payload.runtimeRelease.runtimeEnvelopeSha256 = sha256(runtimeEnvelopeBytes);
  payload.attestationId = makeAttestationId(payload);
  validatePayload(payload);
  verifyReleaseCrossBinding(payload, runtimeEnvelopeBytes);
  return payload;
}

const REVIEW_ENVIRONMENTS = Object.freeze({
  DATA_OWNER_RISK_ACCEPTANCE: "ocr-review-data-owner-risk",
  SECURITY: "ocr-review-security",
  PRIVACY: "ocr-review-privacy",
  DATA_OWNER_FINAL: "ocr-review-data-owner-final",
});

export function validateReviewSet(reviews, binding) {
  exact(
    binding,
    ["subjectSha", "subjectTree", "policySha256", "runId", "runAttempt"],
    "REVIEW_SET_INVALID",
  );
  match(binding.subjectSha, COMMIT, "REVIEW_SET_INVALID");
  match(binding.subjectTree, COMMIT, "REVIEW_SET_INVALID");
  match(binding.policySha256, HASH, "REVIEW_SET_INVALID");
  match(binding.runId, DECIMAL_ID, "REVIEW_SET_INVALID");
  integer(binding.runAttempt, 1, "REVIEW_SET_INVALID");
  if (!Array.isArray(reviews) || reviews.length !== REVIEW_ROLES.length)
    fail("REVIEW_SET_INVALID");
  const reviewers = new Set();
  for (let index = 0; index < REVIEW_ROLES.length; index += 1) {
    const review = reviews[index];
    exact(
      review,
      [
        "role",
        "path",
        "blobSha",
        "sha256",
        "policySha256",
        "subjectSha",
        "subjectTree",
        "decision",
        "approvalSource",
        "approvalEnvironment",
        "reviewerId",
        "reviewerLogin",
        "approvalRunId",
        "qualificationRunAttempt",
        "approvalEvidenceObservedAt",
      ],
      "REVIEW_SET_INVALID",
    );
    if (
      review.role !== REVIEW_ROLES[index] ||
      !/^deploy\/ocr\/reviews\/[a-z0-9-]+\.json$/.test(review.path) ||
      review.policySha256 !== binding.policySha256 ||
      review.subjectSha !== binding.subjectSha ||
      review.subjectTree !== binding.subjectTree ||
      review.decision !== "APPROVED" ||
      review.approvalSource !== "GITHUB_PROTECTED_ENVIRONMENT" ||
      review.approvalEnvironment !== REVIEW_ENVIRONMENTS[review.role] ||
      review.approvalRunId !== binding.runId ||
      review.qualificationRunAttempt !== binding.runAttempt
    )
      fail("REVIEW_SET_INVALID");
    match(review.blobSha, COMMIT, "REVIEW_SET_INVALID");
    match(review.sha256, HASH, "REVIEW_SET_INVALID");
    match(review.reviewerId, DECIMAL_ID, "REVIEW_SET_INVALID");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(review.reviewerLogin))
      fail("REVIEW_SET_INVALID");
    utc(review.approvalEvidenceObservedAt, "REVIEW_SET_INVALID");
    if (reviewers.has(review.reviewerId)) fail("REVIEW_ACTORS_NOT_DISTINCT");
    reviewers.add(review.reviewerId);
  }
  return reviews;
}

export function projectReviewSet(documents, approvals, binding) {
  if (
    !Array.isArray(documents) ||
    !Array.isArray(approvals) ||
    documents.length !== REVIEW_ROLES.length ||
    approvals.length !== REVIEW_ROLES.length
  )
    fail("REVIEW_SET_INVALID");
  const projected = REVIEW_ROLES.map((role, index) => {
    const document = documents[index];
    const approval = approvals[index];
    exact(
      document,
      ["role", "path", "blobSha", "sha256", "policySha256"],
      "REVIEW_SET_INVALID",
    );
    exact(
      approval,
      [
        "schemaVersion",
        "source",
        "role",
        "environment",
        "state",
        "reviewerId",
        "reviewerLogin",
        "observedAt",
        "workflowRunId",
        "subjectSha",
      ],
      "REVIEW_SET_INVALID",
    );
    if (
      document.role !== role ||
      document.policySha256 !== binding.policySha256 ||
      approval.schemaVersion !== 1 ||
      approval.source !== "GITHUB_PROTECTED_ENVIRONMENT" ||
      approval.role !== role ||
      approval.environment !== REVIEW_ENVIRONMENTS[role] ||
      approval.state !== "APPROVED" ||
      approval.workflowRunId !== binding.runId ||
      approval.subjectSha !== binding.subjectSha
    )
      fail("REVIEW_SET_INVALID");
    return {
      role,
      path: document.path,
      blobSha: document.blobSha,
      sha256: document.sha256,
      policySha256: document.policySha256,
      subjectSha: binding.subjectSha,
      subjectTree: binding.subjectTree,
      decision: "APPROVED",
      approvalSource: approval.source,
      approvalEnvironment: approval.environment,
      reviewerId: approval.reviewerId,
      reviewerLogin: approval.reviewerLogin,
      approvalRunId: approval.workflowRunId,
      qualificationRunAttempt: binding.runAttempt,
      approvalEvidenceObservedAt: approval.observedAt,
    };
  });
  validateReviewSet(projected, binding);
  return Object.freeze(projected);
}

export function validatePayload(payload, options = {}) {
  exact(payload, [
    "schemaVersion",
    "attestationId",
    "subject",
    "workflow",
    "runIdentity",
    "policy",
    "corpus",
    "pricing",
    "reviews",
    "provider",
    "evidence",
    "spend",
    "recoveryEvidence",
    "runtimeRelease",
    "validity",
    "kms",
  ]);
  if (payload.schemaVersion !== 1) fail("ATTESTATION_SCHEMA_INVALID");
  match(payload.attestationId, HASH);

  exact(payload.subject, [
    "repository",
    "git",
    "productionImage",
    "qualificationImage",
  ]);
  exact(payload.subject.repository, ["name", "id", "ownerId"]);
  if (payload.subject.repository.name !== "Gabrieldco1994/reformaflow")
    fail("REPOSITORY_BINDING_INVALID");
  match(payload.subject.repository.id, DECIMAL_ID);
  match(payload.subject.repository.ownerId, DECIMAL_ID);
  exact(payload.subject.git, ["sha", "tree"]);
  match(payload.subject.git.sha, COMMIT);
  match(payload.subject.git.tree, COMMIT);
  exact(payload.subject.productionImage, [
    "reference",
    "digest",
    "ociConfigDigest",
    "applicationEntrypointPath",
    "applicationEntrypointSize",
    "executableSha256",
    "runtimeSubjectArtifactId",
    "runtimeSubjectGithubArtifactDigest",
    "runtimeSubjectArtifactSha256",
    "runtimeSubjectWorkflowRunId",
    "runtimeSubjectWorkflowRunAttempt",
  ]);
  match(payload.subject.productionImage.reference, IMAGE);
  match(payload.subject.productionImage.digest, DIGEST);
  match(payload.subject.productionImage.ociConfigDigest, DIGEST);
  if (
    !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(
      payload.subject.productionImage.applicationEntrypointPath,
    )
  )
    fail("PRODUCTION_IMAGE_BINDING_INVALID");
  integer(payload.subject.productionImage.applicationEntrypointSize, 1);
  match(payload.subject.productionImage.executableSha256, HASH);
  match(payload.subject.productionImage.runtimeSubjectArtifactId, DECIMAL_ID);
  match(
    payload.subject.productionImage.runtimeSubjectGithubArtifactDigest,
    DIGEST,
  );
  match(payload.subject.productionImage.runtimeSubjectArtifactSha256, HASH);
  match(
    payload.subject.productionImage.runtimeSubjectWorkflowRunId,
    DECIMAL_ID,
  );
  integer(payload.subject.productionImage.runtimeSubjectWorkflowRunAttempt, 1);
  if (
    !payload.subject.productionImage.reference.endsWith(
      `@${payload.subject.productionImage.digest}`,
    )
  )
    fail("PRODUCTION_IMAGE_BINDING_INVALID");
  exact(payload.subject.qualificationImage, ["digest", "executableDigest"]);
  match(payload.subject.qualificationImage.digest, DIGEST);
  match(payload.subject.qualificationImage.executableDigest, DIGEST);

  exact(payload.workflow, [
    "path",
    "sha",
    "runId",
    "runAttempt",
    "ref",
    "event",
  ]);
  if (
    payload.workflow.path !== WORKFLOW_PATH ||
    payload.workflow.sha !== payload.subject.git.sha ||
    payload.workflow.ref !== "refs/heads/main" ||
    payload.workflow.event !== "workflow_dispatch"
  )
    fail("WORKFLOW_BINDING_INVALID");
  match(payload.workflow.sha, COMMIT);
  match(payload.workflow.runId, DECIMAL_ID);
  integer(payload.workflow.runAttempt, 1);

  exact(payload.runIdentity, [
    "repositoryId",
    "repositoryOwnerId",
    "actorId",
    "runId",
    "runAttempt",
  ]);
  if (
    payload.runIdentity.repositoryId !== payload.subject.repository.id ||
    payload.runIdentity.repositoryOwnerId !==
      payload.subject.repository.ownerId ||
    payload.runIdentity.runId !== payload.workflow.runId ||
    payload.runIdentity.runAttempt !== payload.workflow.runAttempt
  )
    fail("RUN_IDENTITY_INVALID");
  match(payload.runIdentity.actorId, DECIMAL_ID);

  exact(payload.policy, ["path", "sha256", "version", "validThroughUtc"]);
  string(payload.policy.path);
  match(payload.policy.sha256, HASH);
  string(payload.policy.version);
  utc(payload.policy.validThroughUtc);
  exact(payload.corpus, ["path", "sha256", "datasetVersion"]);
  string(payload.corpus.path);
  match(payload.corpus.sha256, HASH);
  string(payload.corpus.datasetVersion);

  exact(payload.pricing, [
    "source",
    "observedOn",
    "recheckThroughUtc",
    "currency",
    "inputMicrosPerMillionTokens",
    "outputMicrosPerMillionTokens",
    "maxTotalCostMicros",
  ]);
  if (
    !payload.pricing.source.startsWith("https://") ||
    payload.pricing.currency !== "USD"
  )
    fail("PRICING_BINDING_INVALID");
  utc(payload.pricing.observedOn);
  utc(payload.pricing.recheckThroughUtc);
  integer(payload.pricing.inputMicrosPerMillionTokens, 1);
  integer(payload.pricing.outputMicrosPerMillionTokens, 1);
  integer(payload.pricing.maxTotalCostMicros, 1);
  validateReviewSet(payload.reviews, {
    subjectSha: payload.subject.git.sha,
    subjectTree: payload.subject.git.tree,
    policySha256: payload.policy.sha256,
    runId: payload.workflow.runId,
    runAttempt: payload.workflow.runAttempt,
  });

  exact(payload.provider, [
    "provider",
    "model",
    "modelVersion",
    "region",
    "endpoint",
    "promptSha256",
  ]);
  if (
    payload.provider.provider !== PROVIDER ||
    payload.provider.model !== MODEL ||
    payload.provider.region !== REGION ||
    payload.provider.endpoint !== ENDPOINT
  )
    fail("PROVIDER_BINDING_INVALID");
  if (!/^[!-~]{1,192}$/.test(payload.provider.modelVersion))
    fail("PROVIDER_BINDING_INVALID");
  match(payload.provider.promptSha256, HASH, "PROVIDER_BINDING_INVALID");

  exact(payload.evidence, [
    "raw",
    "report",
    "assessment",
    "requestIds",
    "responseIds",
  ]);
  for (const artifact of [payload.evidence.raw, payload.evidence.report]) {
    exact(artifact, ["sha256", "size", "artifactId"]);
    match(artifact.sha256, HASH);
    integer(artifact.size, 1);
    match(artifact.artifactId, DECIMAL_ID);
  }
  exact(payload.evidence.assessment, [
    "sha256",
    "size",
    "artifactId",
    "githubArtifactDigest",
  ]);
  match(payload.evidence.assessment.sha256, HASH);
  integer(payload.evidence.assessment.size, 1);
  match(payload.evidence.assessment.artifactId, DECIMAL_ID);
  match(
    payload.evidence.assessment.githubArtifactDigest,
    /^sha256:[0-9a-f]{64}$/,
  );
  for (const ids of [
    payload.evidence.requestIds,
    payload.evidence.responseIds,
  ]) {
    if (
      !Array.isArray(ids) ||
      ids.length !== 18 ||
      new Set(ids).size !== ids.length ||
      ids.some(
        (id) => typeof id !== "string" || id.length < 8 || id.length > 192,
      )
    )
      fail("EVIDENCE_IDENTITY_INVALID");
  }

  exact(payload.spend, [
    "currency",
    "hardLimitMicros",
    "reservedMicros",
    "measuredMicros",
    "admissionSha256",
    "admittedAt",
  ]);
  if (payload.spend.currency !== "USD") fail("SPEND_GUARD_INVALID");
  integer(payload.spend.hardLimitMicros, 1, "SPEND_GUARD_INVALID");
  integer(payload.spend.reservedMicros, 1, "SPEND_GUARD_INVALID");
  integer(payload.spend.measuredMicros, 0, "SPEND_GUARD_INVALID");
  if (
    payload.spend.hardLimitMicros !== payload.pricing.maxTotalCostMicros ||
    payload.spend.reservedMicros > payload.spend.hardLimitMicros ||
    payload.spend.measuredMicros > payload.spend.reservedMicros
  )
    fail("SPEND_GUARD_INVALID");
  match(payload.spend.admissionSha256, HASH, "SPEND_GUARD_INVALID");
  utc(payload.spend.admittedAt, "SPEND_GUARD_INVALID");

  exact(
    payload.recoveryEvidence,
    ["producer", "backupRestore", "legacyUpgrade"],
    "RECOVERY_EVIDENCE_INVALID",
  );
  exact(
    payload.recoveryEvidence.producer,
    [
      "workflowPath",
      "workflowSha",
      "runId",
      "runAttempt",
      "artifactId",
      "githubArtifactDigest",
      "payloadSha256",
    ],
    "RECOVERY_EVIDENCE_INVALID",
  );
  if (
    payload.recoveryEvidence.producer.workflowPath !==
      ".github/workflows/ocr-recovery-evidence.yml" ||
    payload.recoveryEvidence.producer.runAttempt !== 1
  )
    fail("RECOVERY_EVIDENCE_INVALID");
  match(
    payload.recoveryEvidence.producer.workflowSha,
    COMMIT,
    "RECOVERY_EVIDENCE_INVALID",
  );
  match(
    payload.recoveryEvidence.producer.runId,
    DECIMAL_ID,
    "RECOVERY_EVIDENCE_INVALID",
  );
  match(
    payload.recoveryEvidence.producer.artifactId,
    DECIMAL_ID,
    "RECOVERY_EVIDENCE_INVALID",
  );
  match(
    payload.recoveryEvidence.producer.githubArtifactDigest,
    DIGEST,
    "RECOVERY_EVIDENCE_INVALID",
  );
  match(
    payload.recoveryEvidence.producer.payloadSha256,
    HASH,
    "RECOVERY_EVIDENCE_INVALID",
  );
  for (const evidence of [
    payload.recoveryEvidence.backupRestore,
    payload.recoveryEvidence.legacyUpgrade,
  ]) {
    exact(evidence, ["receiptSha256"], "RECOVERY_EVIDENCE_INVALID");
    match(evidence.receiptSha256, HASH, "RECOVERY_EVIDENCE_INVALID");
  }

  exact(
    payload.runtimeRelease,
    ["activationSubjectSha256", "runtimeEnvelopeSha256"],
    "RUNTIME_RELEASE_BINDING_INVALID",
  );
  match(
    payload.runtimeRelease.activationSubjectSha256,
    HASH,
    "RUNTIME_RELEASE_BINDING_INVALID",
  );
  match(
    payload.runtimeRelease.runtimeEnvelopeSha256,
    HASH,
    "RUNTIME_RELEASE_BINDING_INVALID",
  );
  if (
    !options.allowRuntimeDraft &&
    payload.runtimeRelease.runtimeEnvelopeSha256 === "0".repeat(64)
  )
    fail("RUNTIME_RELEASE_BINDING_INVALID");

  exact(payload.validity, ["issuedAt", "notBefore", "expiresAt"]);
  const issued = utc(payload.validity.issuedAt);
  const notBefore = utc(payload.validity.notBefore);
  const expires = utc(payload.validity.expiresAt);
  if (
    notBefore.valueOf() > issued.valueOf() ||
    issued.valueOf() >= expires.valueOf() ||
    expires.valueOf() - issued.valueOf() > 24 * 60 * 60 * 1000
  )
    fail("ATTESTATION_VALIDITY_INVALID");
  if (
    expires.valueOf() > utc(payload.policy.validThroughUtc).valueOf() ||
    expires.valueOf() > utc(payload.pricing.recheckThroughUtc).valueOf()
  )
    fail("ATTESTATION_VALIDITY_INVALID");
  for (const review of payload.reviews)
    if (
      utc(review.approvalEvidenceObservedAt).valueOf() >
      utc(payload.spend.admittedAt).valueOf()
    )
      fail("REVIEW_ORDER_INVALID");
  if (utc(payload.spend.admittedAt).valueOf() > issued.valueOf())
    fail("SPEND_GUARD_INVALID");

  exact(payload.kms, [
    "keyResource",
    "cryptoKeyVersion",
    "algorithm",
    "publicKeySha256",
  ]);
  string(payload.kms.keyResource);
  string(payload.kms.cryptoKeyVersion);
  if (
    !payload.kms.cryptoKeyVersion.startsWith(
      `${payload.kms.keyResource}/cryptoKeyVersions/`,
    ) ||
    payload.kms.algorithm !== KMS_ALGORITHM
  )
    fail("KMS_BINDING_INVALID");
  match(payload.kms.publicKeySha256, HASH);

  const expectedId = sha256(
    canonicalize({ ...payload, attestationId: "0".repeat(64) }),
  );
  if (options.allowRuntimeDraft) {
    if (payload.attestationId !== "0".repeat(64))
      fail("ATTESTATION_ID_INVALID");
  } else if (payload.attestationId !== expectedId)
    fail("ATTESTATION_ID_INVALID");
  return payload;
}

export function makeAttestationId(payload) {
  return sha256(canonicalize({ ...payload, attestationId: "0".repeat(64) }));
}

async function readBounded(path, maximum = MAX_JSON_BYTES) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximum)
      fail("FILE_INVALID");
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.size) fail("FILE_CHANGED");
    return bytes;
  } finally {
    await handle.close();
  }
}

function safeRelative(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

export async function verifyEnvelope(envelope, allowlist, options = {}) {
  exact(
    envelope,
    ["schemaVersion", "payload", "signature"],
    "ENVELOPE_SCHEMA_INVALID",
  );
  if (envelope.schemaVersion !== 1) fail("ENVELOPE_SCHEMA_INVALID");
  validatePayload(envelope.payload);
  exact(
    envelope.signature,
    [
      "keyResource",
      "cryptoKeyVersion",
      "algorithm",
      "publicKeySha256",
      "valueBase64",
    ],
    "SIGNATURE_INVALID",
  );
  if (
    envelope.signature.keyResource !== envelope.payload.kms.keyResource ||
    envelope.signature.cryptoKeyVersion !==
      envelope.payload.kms.cryptoKeyVersion ||
    envelope.signature.algorithm !== envelope.payload.kms.algorithm ||
    envelope.signature.publicKeySha256 !==
      envelope.payload.kms.publicKeySha256 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature.valueBase64)
  )
    fail("SIGNATURE_INVALID");

  validateTrustBundle(allowlist);
  const matches = allowlist.keys.filter(
    (key) => key.keyId === envelope.signature.cryptoKeyVersion,
  );
  if (matches.length !== 1) fail("KEY_NOT_ALLOWLISTED");
  const key = matches[0];
  if (
    key.algorithm !== KMS_ALGORITHM ||
    key.publicKeySha256 !== envelope.signature.publicKeySha256 ||
    key.allowedWorkflowSha !== envelope.payload.workflow.sha
  )
    fail("KEY_NOT_ALLOWLISTED");
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.valueOf()))
    fail("NOW_INVALID");
  if (
    now.valueOf() < utc(envelope.payload.validity.notBefore).valueOf() ||
    now.valueOf() >= utc(envelope.payload.validity.expiresAt).valueOf() ||
    now.valueOf() < utc(key.notBefore).valueOf() ||
    now.valueOf() >= utc(key.notAfter).valueOf()
  )
    fail("ATTESTATION_EXPIRED");
  if (
    options.expectedRunId &&
    envelope.payload.workflow.runId !== String(options.expectedRunId)
  )
    fail("RUN_IDENTITY_INVALID");
  if (
    options.expectedRunAttempt &&
    envelope.payload.workflow.runAttempt !== Number(options.expectedRunAttempt)
  )
    fail("RUN_IDENTITY_INVALID");
  if (
    options.expectedMainSha &&
    envelope.payload.subject.git.sha !== options.expectedMainSha
  )
    fail("STALE_MAIN");
  if (
    options.expectedProductionImage &&
    envelope.payload.subject.productionImage.reference !==
      options.expectedProductionImage
  )
    fail("STALE_PRODUCTION_IMAGE");
  if (
    options.expectedBackupRestoreSha256 &&
    envelope.payload.recoveryEvidence.backupRestore.sha256 !==
      options.expectedBackupRestoreSha256
  )
    fail("RECOVERY_EVIDENCE_MISMATCH");
  if (
    options.expectedBackupRestoreArtifactId &&
    envelope.payload.recoveryEvidence.backupRestore.artifactId !==
      String(options.expectedBackupRestoreArtifactId)
  )
    fail("RECOVERY_EVIDENCE_MISMATCH");
  if (
    options.expectedLegacyUpgradeSha256 &&
    envelope.payload.recoveryEvidence.legacyUpgrade.sha256 !==
      options.expectedLegacyUpgradeSha256
  )
    fail("RECOVERY_EVIDENCE_MISMATCH");
  if (
    options.expectedLegacyUpgradeArtifactId &&
    envelope.payload.recoveryEvidence.legacyUpgrade.artifactId !==
      String(options.expectedLegacyUpgradeArtifactId)
  )
    fail("RECOVERY_EVIDENCE_MISMATCH");
  if (options.seenAttestationIds?.has(envelope.payload.attestationId))
    fail("ATTESTATION_REPLAY");

  const publicKey = p256PublicKey(
    key.publicKeyPem,
    key.publicKeySha256,
    "PUBLIC_KEY_HASH_INVALID",
  );
  const signature = canonicalP256DerSignature(envelope.signature.valueBase64);
  if (
    !verifySignature(
      "sha256",
      Buffer.from(canonicalize(envelope.payload)),
      publicKey,
      signature,
    )
  )
    fail("SIGNATURE_INVALID");
  options.seenAttestationIds?.add(envelope.payload.attestationId);
  return envelope.payload;
}

function git(root, args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], {
    encoding,
    maxBuffer: MAX_JSON_BYTES,
  });
}

export async function verifyRepositoryBindings(payload, root) {
  validatePayload(payload);
  const headTree = git(root, [
    "rev-parse",
    `${payload.subject.git.sha}^{tree}`,
  ]).trim();
  if (headTree !== payload.subject.git.tree) fail("TREE_BINDING_INVALID");
  const bound = [
    [payload.policy.path, payload.policy.sha256],
    [payload.corpus.path, payload.corpus.sha256],
    [payload.workflow.path, null],
    ...payload.reviews.map((review) => [review.path, review.sha256]),
  ];
  for (const [path, expectedHash] of bound) {
    if (!safeRelative(path)) fail("REPOSITORY_BINDING_INVALID");
    const bytes = git(
      root,
      ["show", `${payload.subject.git.sha}:${path}`],
      null,
    );
    if (expectedHash && sha256(bytes) !== expectedHash)
      fail("REPOSITORY_BINDING_INVALID");
    if (path.startsWith("deploy/ocr/reviews/")) {
      const review = payload.reviews.find((item) => item.path === path);
      const blob = git(root, [
        "rev-parse",
        `${payload.subject.git.sha}:${path}`,
      ]).trim();
      if (!review || review.blobSha !== blob)
        fail("REPOSITORY_BINDING_INVALID");
    }
  }
  return true;
}

export async function reserveSpend(request, path) {
  exact(
    request,
    [
      "schemaVersion",
      "subjectSha",
      "subjectTree",
      "productionImage",
      "qualificationImageDigest",
      "executableDigest",
      "workflowSha",
      "policySha256",
      "corpusSha256",
      "reviewSetSha256",
      "runId",
      "runAttempt",
      "currency",
      "hardLimitMicros",
      "reservedMicros",
      "provider",
      "requestedModelAlias",
      "region",
      "endpoint",
      "promptSha256",
      "inputMicrosPerMillionTokens",
      "outputMicrosPerMillionTokens",
      "expectedCaseCount",
      "admittedAt",
    ],
    "SPEND_GUARD_INVALID",
  );
  if (
    request.schemaVersion !== 1 ||
    request.currency !== "USD" ||
    request.provider !== PROVIDER ||
    request.requestedModelAlias !== MODEL ||
    request.region !== REGION ||
    request.endpoint !== ENDPOINT
  )
    fail("SPEND_GUARD_INVALID");
  match(request.subjectSha, COMMIT, "SPEND_GUARD_INVALID");
  match(request.subjectTree, COMMIT, "SPEND_GUARD_INVALID");
  match(request.productionImage, IMAGE, "SPEND_GUARD_INVALID");
  match(request.qualificationImageDigest, DIGEST, "SPEND_GUARD_INVALID");
  match(request.executableDigest, DIGEST, "SPEND_GUARD_INVALID");
  match(request.workflowSha, COMMIT, "SPEND_GUARD_INVALID");
  match(request.policySha256, HASH, "SPEND_GUARD_INVALID");
  match(request.corpusSha256, HASH, "SPEND_GUARD_INVALID");
  match(request.promptSha256, HASH, "SPEND_GUARD_INVALID");
  match(request.reviewSetSha256, HASH, "SPEND_GUARD_INVALID");
  match(request.runId, DECIMAL_ID, "SPEND_GUARD_INVALID");
  integer(request.runAttempt, 1, "SPEND_GUARD_INVALID");
  integer(request.hardLimitMicros, 1, "SPEND_GUARD_INVALID");
  integer(request.reservedMicros, 1, "SPEND_GUARD_INVALID");
  integer(request.inputMicrosPerMillionTokens, 1, "SPEND_GUARD_INVALID");
  integer(request.outputMicrosPerMillionTokens, 1, "SPEND_GUARD_INVALID");
  integer(request.expectedCaseCount, 1, "SPEND_GUARD_INVALID");
  if (
    request.hardLimitMicros !== QUALIFICATION_HARD_LIMIT_MICROS ||
    request.reservedMicros !== request.hardLimitMicros ||
    request.expectedCaseCount !== 18
  )
    fail("SPEND_GUARD_INVALID");
  utc(request.admittedAt, "SPEND_GUARD_INVALID");
  const canonical = canonicalize(request);
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_RDWR |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(canonical);
    await handle.sync();
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size !== Buffer.byteLength(canonical)
    )
      fail("SPEND_RESERVATION_INVALID");
    return Object.freeze({
      handle,
      dev: metadata.dev,
      ino: metadata.ino,
      sha256: sha256(canonical),
      canonical,
    });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function assertSpendReservation(reservation, path) {
  const descriptor = await reservation.handle.stat();
  const linked = await lstat(path);
  if (
    !descriptor.isFile() ||
    !linked.isFile() ||
    descriptor.dev !== reservation.dev ||
    descriptor.ino !== reservation.ino ||
    linked.dev !== reservation.dev ||
    linked.ino !== reservation.ino ||
    (descriptor.mode & 0o777) !== 0o600
  )
    fail("SPEND_RESERVATION_CHANGED");
  const buffer = Buffer.alloc(descriptor.size);
  const result = await reservation.handle.read(buffer, 0, buffer.length, 0);
  if (result.bytesRead !== descriptor.size) fail("SPEND_RESERVATION_CHANGED");
  const bytes = buffer.toString("utf8");
  if (sha256(bytes) !== reservation.sha256 || bytes !== reservation.canonical)
    fail("SPEND_RESERVATION_CHANGED");
  return true;
}

async function readJson(path) {
  return parseStrictJson((await readBounded(path)).toString("utf8"));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "canonicalize" && args.length === 1) {
    process.stdout.write(canonicalize(await readJson(args[0])));
    return;
  }
  if (command === "prepare-payload" && args.length === 1) {
    const payload = await readJson(args[0]);
    if (!isObject(payload) || !Object.hasOwn(payload, "attestationId"))
      fail("ATTESTATION_SCHEMA_INVALID");
    payload.attestationId = makeAttestationId(payload);
    validatePayload(payload);
    process.stdout.write(canonicalize(payload));
    return;
  }
  if (command === "validate-trust" && args.length === 1) {
    validateTrustBundle(await readJson(args[0]));
    process.stdout.write("TRUST_BUNDLE_OK\n");
    return;
  }
  if (command === "extract-activation-draft" && args.length === 1) {
    const packageValue = await readJson(args[0]);
    exact(
      packageValue,
      ["schemaVersion", "activationPayloadDraft", "runtimePayloadBase64"],
      "UNSIGNED_PACKAGE_INVALID",
    );
    if (packageValue.schemaVersion !== 1) fail("UNSIGNED_PACKAGE_INVALID");
    validatePayload(packageValue.activationPayloadDraft, {
      allowRuntimeDraft: true,
    });
    process.stdout.write(canonicalize(packageValue.activationPayloadDraft));
    return;
  }
  if (command === "extract-runtime-payload" && args.length === 1) {
    const packageValue = await readJson(args[0]);
    exact(
      packageValue,
      ["schemaVersion", "activationPayloadDraft", "runtimePayloadBase64"],
      "UNSIGNED_PACKAGE_INVALID",
    );
    const bytes = Buffer.from(packageValue.runtimePayloadBase64, "base64");
    const payload = validateRuntimeReleasePayload(
      parseStrictJson(bytes.toString("utf8")),
    );
    if (
      bytes.toString("base64") !== packageValue.runtimePayloadBase64 ||
      payload.activationSubjectSha256 !==
        packageValue.activationPayloadDraft.runtimeRelease
          .activationSubjectSha256
    )
      fail("UNSIGNED_PACKAGE_INVALID");
    process.stdout.write(bytes);
    return;
  }
  if (command === "make-runtime-envelope" && args.length === 2) {
    const payloadBytes = await readBounded(args[0]);
    const signature = await readJson(args[1]);
    process.stdout.write(
      canonicalize(makeRuntimeReleaseEnvelope(payloadBytes, signature)),
    );
    return;
  }
  if (command === "finalize-activation" && args.length === 2) {
    const draft = await readJson(args[0]);
    const runtimeEnvelopeBytes = await readBounded(args[1]);
    process.stdout.write(
      canonicalize(finalizeActivationPayload(draft, runtimeEnvelopeBytes)),
    );
    return;
  }
  if (command === "verify-cross-binding" && args.length === 2) {
    const activationPayload = await readJson(args[0]);
    const runtimeEnvelopeBytes = await readBounded(args[1]);
    verifyReleaseCrossBinding(activationPayload, runtimeEnvelopeBytes);
    process.stdout.write("RELEASE_CROSS_BINDING_OK\n");
    return;
  }
  if (command === "verify-runtime" && args.length >= 2) {
    const envelope = await readJson(args[0]);
    const trust = await readJson(args[1]);
    const expected = args[2] ? await readJson(args[2]) : Object.create(null);
    const verified = await verifyRuntimeReleaseEnvelope(envelope, trust, {
      now: expected.now ? new Date(expected.now) : new Date(),
      expectedMainSha: expected.mainSha,
      expectedProductionImageDigest: expected.productionImageDigest,
      expectedExecutableSha256: expected.executableSha256,
    });
    process.stdout.write(canonicalize(verified.payload));
    return;
  }
  if (command === "make-envelope" && args.length === 2) {
    const payload = await readJson(args[0]);
    const signature = await readJson(args[1]);
    validatePayload(payload);
    exact(
      signature,
      [
        "keyResource",
        "cryptoKeyVersion",
        "algorithm",
        "publicKeySha256",
        "valueBase64",
      ],
      "SIGNATURE_INVALID",
    );
    const envelope = { schemaVersion: 1, payload, signature };
    process.stdout.write(canonicalize(envelope));
    return;
  }
  if (command === "verify" && args.length >= 2) {
    const envelope = await readJson(args[0]);
    const allowlist = await readJson(args[1]);
    const expected = args[2] ? await readJson(args[2]) : Object.create(null);
    const payload = await verifyEnvelope(envelope, allowlist, {
      root: dirname(resolve(args[1])),
      now: expected.now ? new Date(expected.now) : new Date(),
      expectedRunId: expected.runId,
      expectedRunAttempt: expected.runAttempt,
      expectedMainSha: expected.mainSha,
      expectedProductionImage: expected.productionImage,
      expectedBackupRestoreSha256: expected.backupRestoreSha256,
      expectedBackupRestoreArtifactId: expected.backupRestoreArtifactId,
      expectedLegacyUpgradeSha256: expected.legacyUpgradeSha256,
      expectedLegacyUpgradeArtifactId: expected.legacyUpgradeArtifactId,
    });
    if (expected.repositoryRoot)
      await verifyRepositoryBindings(payload, expected.repositoryRoot);
    process.stdout.write(canonicalize(payload));
    return;
  }
  if (command === "verify-repository" && args.length === 2) {
    await verifyRepositoryBindings(await readJson(args[0]), args[1]);
    process.stdout.write("REPOSITORY_BINDINGS_OK\n");
    return;
  }
  if (command === "reserve-spend" && args.length === 2) {
    const reservation = await reserveSpend(await readJson(args[0]), args[1]);
    await assertSpendReservation(reservation, args[1]);
    await reservation.handle.close();
    process.stdout.write(`${reservation.sha256}\n`);
    return;
  }
  fail("USAGE_INVALID");
}

const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked)
  void main().catch((error) => {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "OCR_ATTESTATION_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
