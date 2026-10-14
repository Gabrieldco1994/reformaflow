import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import trustSource from "./ocr-release-trust.json";
import { parseStrictJson } from "./strict-json";

const ALGORITHM = "EC_SIGN_P256_SHA256" as const;
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface ParsedEnvelope {
  readonly schemaVersion: 1;
  readonly trust: "UNTRUSTED";
  readonly payloadBase64: string;
  readonly payloadBytes: Buffer;
  readonly signature: Readonly<{
    keyId: string;
    algorithm: string;
    valueBase64: string;
    bytes: Buffer;
  }>;
}

export interface OcrTrustedSignatureKey {
  readonly keyId: string;
  readonly algorithm: string;
  readonly publicKeyPem: string;
  readonly publicKeySha256?: string;
  readonly notBefore?: string;
  readonly notAfter?: string;
  readonly allowedWorkflowSha?: string;
}

export interface OcrTrustedSignatureRuntime {
  readonly now: Date;
  /** Test seam. Production omits this and consumes the compiled trust source. */
  readonly embeddedTrustBundle?: Readonly<{
    keys: readonly OcrTrustedSignatureKey[];
  }>;
}

interface VerificationRuntime {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly imageDigest: string;
  readonly applicationEntrypointPath: string;
  readonly executableSha256: string;
  readonly runtimeSubjectArtifactSha256: string;
  readonly activationSubjectSha256: string;
  readonly allowedWorkflowShas: readonly string[];
  readonly now: Date;
  /** Test seam. Production omits this and consumes the compiled trust source. */
  readonly embeddedTrustBundle?: Readonly<{
    keys: readonly OcrTrustedSignatureKey[];
  }>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const fail = (code: string): never => {
  throw new Error(code);
};
const decodeBase64 = (value: unknown, code: string): Buffer => {
  if (typeof value !== "string" || value.length === 0 || !BASE64.test(value))
    fail(code);
  const canonical = value as string;
  const bytes = Buffer.from(canonical, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== canonical) fail(code);
  return bytes;
};

export function parseOcrReleaseEnvelope(raw: string): ParsedEnvelope {
  let value: unknown;
  try {
    value = parseStrictJson(raw);
  } catch {
    fail("OCR_ATTESTATION_SCHEMA_INVALID");
  }
  if (
    !object(value) ||
    !exact(value, ["schemaVersion", "payloadBase64", "signature"]) ||
    value.schemaVersion !== 1 ||
    !object(value.signature) ||
    !exact(value.signature, ["keyId", "algorithm", "valueBase64"]) ||
    typeof value.signature.keyId !== "string" ||
    value.signature.keyId.length === 0 ||
    typeof value.signature.algorithm !== "string"
  )
    fail("OCR_ATTESTATION_SCHEMA_INVALID");
  const parsed = value as Record<string, unknown>;
  const parsedSignature = parsed.signature as Record<string, unknown>;
  const payloadBytes = decodeBase64(
    parsed.payloadBase64,
    "OCR_ATTESTATION_SCHEMA_INVALID",
  );
  const signatureBytes = decodeBase64(
    parsedSignature.valueBase64,
    "OCR_ATTESTATION_SCHEMA_INVALID",
  );
  return Object.freeze({
    schemaVersion: 1,
    trust: "UNTRUSTED",
    payloadBase64: parsed.payloadBase64 as string,
    payloadBytes,
    signature: Object.freeze({
      keyId: parsedSignature.keyId as string,
      algorithm: parsedSignature.algorithm as string,
      valueBase64: parsedSignature.valueBase64 as string,
      bytes: signatureBytes,
    }),
  });
}

function trustKeys(
  runtime: OcrTrustedSignatureRuntime,
): readonly OcrTrustedSignatureKey[] {
  if (runtime.embeddedTrustBundle) return runtime.embeddedTrustBundle.keys;
  const source = trustSource as Readonly<{
    schemaVersion: number;
    keys: readonly OcrTrustedSignatureKey[];
  }>;
  return source.schemaVersion === 1 && Array.isArray(source.keys)
    ? source.keys
    : [];
}

function requireP256(
  key: OcrTrustedSignatureKey,
): ReturnType<typeof createPublicKey> {
  const publicKey = (() => {
    try {
      return createPublicKey(key.publicKeyPem);
    } catch {
      return fail("OCR_ATTESTATION_KEY_INVALID");
    }
  })();
  if (
    publicKey.asymmetricKeyType !== "ec" ||
    publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    fail("OCR_ATTESTATION_KEY_INVALID");
  if (
    key.publicKeySha256 !== undefined &&
    createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex") !== key.publicKeySha256
  )
    fail("OCR_ATTESTATION_KEY_INVALID");
  return publicKey;
}

function requireDerSignature(bytes: Buffer): void {
  if (
    bytes.length < 8 ||
    bytes.length > 72 ||
    bytes[0] !== 0x30 ||
    bytes[1] !== bytes.length - 2
  )
    fail("OCR_ATTESTATION_SIGNATURE_INVALID");
}

/**
 * Verifies detached bytes only against the compiled OCR trust bundle.
 * Callers supply the signed bytes, never a public key.
 */
export function verifyTrustedOcrP256Signature(
  input: Readonly<{
    keyId: string;
    payloadBytes: Buffer;
    signatureBase64: string;
  }>,
  runtime: OcrTrustedSignatureRuntime = { now: new Date() },
): true {
  if (
    typeof input.keyId !== "string" ||
    input.keyId.length === 0 ||
    !Buffer.isBuffer(input.payloadBytes) ||
    input.payloadBytes.length === 0
  )
    fail("OCR_ATTESTATION_SCHEMA_INVALID");
  const trustedKey = trustKeys(runtime).find(
    (candidate) =>
      candidate.keyId === input.keyId && candidate.algorithm === ALGORITHM,
  );
  if (!trustedKey) fail("OCR_ATTESTATION_KEY_NOT_ALLOWED");
  const admittedKey = trustedKey as OcrTrustedSignatureKey;
  if (
    (admittedKey.notBefore && runtime.now < new Date(admittedKey.notBefore)) ||
    (admittedKey.notAfter && runtime.now > new Date(admittedKey.notAfter))
  )
    fail("OCR_ATTESTATION_KEY_NOT_ALLOWED");
  const signature = decodeBase64(
    input.signatureBase64,
    "OCR_ATTESTATION_SIGNATURE_INVALID",
  );
  requireDerSignature(signature);
  if (
    !verifySignature(
      "sha256",
      input.payloadBytes,
      requireP256(admittedKey),
      signature,
    )
  )
    fail("OCR_ATTESTATION_SIGNATURE_INVALID");
  return true;
}

function parsePayload(bytes: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    fail("OCR_ATTESTATION_SCHEMA_INVALID");
  }
  if (!object(value)) fail("OCR_ATTESTATION_SCHEMA_INVALID");
  return value as Record<string, unknown>;
}

function verifyValidity(
  notBefore: unknown,
  expiresAt: unknown,
  now: Date,
): void {
  if (typeof notBefore !== "string" || typeof expiresAt !== "string")
    fail("OCR_ATTESTATION_SCHEMA_INVALID");
  const start = new Date(notBefore as string);
  const end = new Date(expiresAt as string);
  if (
    !Number.isFinite(start.valueOf()) ||
    !Number.isFinite(end.valueOf()) ||
    now < start ||
    now > end
  )
    fail("OCR_ATTESTATION_EXPIRED");
}

function verifySubject(
  subject: Record<string, unknown>,
  runtime: VerificationRuntime,
): void {
  for (const [key, expected] of [
    ["commitSha", runtime.commitSha],
    ["treeSha", runtime.treeSha],
    ["imageDigest", runtime.imageDigest],
    ["applicationEntrypointPath", runtime.applicationEntrypointPath],
    ["executableSha256", runtime.executableSha256],
    ["runtimeSubjectArtifactSha256", runtime.runtimeSubjectArtifactSha256],
  ] as const)
    if (subject[key] !== expected) fail("OCR_ATTESTATION_SUBJECT_MISMATCH");
}

function verifyFlatPayload(
  payload: Record<string, unknown>,
  runtime: VerificationRuntime,
): Readonly<{ commitSha: string; treeSha: string; workflowSha: string }> {
  if (payload.verdict !== "PASS") fail("OCR_ATTESTATION_NOT_PASS");
  if (!object(payload.workflow)) fail("OCR_ATTESTATION_SCHEMA_INVALID");
  const workflow = payload.workflow as Record<string, unknown>;
  const workflowSha = workflow.sha;
  if (
    typeof workflowSha !== "string" ||
    !runtime.allowedWorkflowShas.includes(workflowSha)
  )
    fail("OCR_ATTESTATION_WORKFLOW_NOT_ALLOWED");
  if (payload.activationSubjectSha256 !== runtime.activationSubjectSha256)
    fail("OCR_ATTESTATION_SUBJECT_MISMATCH");
  verifySubject(payload, runtime);
  verifyValidity(payload.validFrom, payload.validThrough, runtime.now);
  if (
    payload.version !== 1 ||
    !COMMIT.test(payload.commitSha as string) ||
    !COMMIT.test(payload.treeSha as string) ||
    !DIGEST.test(payload.imageDigest as string) ||
    !HASH.test(payload.executableSha256 as string) ||
    !HASH.test(payload.runtimeSubjectArtifactSha256 as string) ||
    !object(payload.provider) ||
    payload.provider.id !== "GOOGLE_VERTEX_AI"
  )
    fail("OCR_ATTESTATION_SCHEMA_INVALID");
  return Object.freeze({
    commitSha: payload.commitSha as string,
    treeSha: payload.treeSha as string,
    workflowSha: workflowSha as string,
  });
}

function verifyWirePayload(
  payload: Record<string, unknown>,
  runtime: VerificationRuntime,
): Readonly<{ commitSha: string; treeSha: string; workflowSha: string }> {
  if (payload.verdict !== "PASS") fail("OCR_ATTESTATION_NOT_PASS");
  if (
    payload.schemaVersion !== 1 ||
    payload.kind !== "REFORMAFLOW_OCR_RELEASE" ||
    !object(payload.subject) ||
    !object(payload.workflow) ||
    !object(payload.closure) ||
    !object(payload.provider) ||
    !object(payload.validity)
  )
    fail("OCR_ATTESTATION_SCHEMA_INVALID");
  const workflow = payload.workflow as Record<string, unknown>;
  const subject = payload.subject as Record<string, unknown>;
  const validity = payload.validity as Record<string, unknown>;
  const workflowSha = workflow.workflowSha;
  if (
    typeof workflowSha !== "string" ||
    !runtime.allowedWorkflowShas.includes(workflowSha)
  )
    fail("OCR_ATTESTATION_WORKFLOW_NOT_ALLOWED");
  if (payload.activationSubjectSha256 !== runtime.activationSubjectSha256)
    fail("OCR_ATTESTATION_SUBJECT_MISMATCH");
  verifySubject(subject, runtime);
  verifyValidity(validity.notBefore, validity.expiresAt, runtime.now);
  return Object.freeze({
    commitSha: subject.commitSha as string,
    treeSha: subject.treeSha as string,
    workflowSha: workflowSha as string,
  });
}

export function verifyOcrReleaseEnvelope(
  envelope: unknown,
  runtime: VerificationRuntime,
): Readonly<{
  kind: "VERIFIED";
  algorithm: typeof ALGORITHM;
  commitSha: string;
  treeSha: string;
  activationSubjectSha256: string;
}> {
  if (
    !object(envelope) ||
    envelope.trust !== "UNTRUSTED" ||
    !Buffer.isBuffer(envelope.payloadBytes) ||
    !object(envelope.signature)
  )
    fail("OCR_ATTESTATION_SCHEMA_INVALID");
  const parsedEnvelope = envelope as Record<string, unknown>;
  const parsedSignature = parsedEnvelope.signature as Record<string, unknown>;
  if (parsedSignature.algorithm !== ALGORITHM)
    fail("OCR_ATTESTATION_SCHEMA_INVALID");
  const key = trustKeys(runtime).find(
    (candidate) =>
      candidate.keyId === parsedSignature.keyId &&
      candidate.algorithm === ALGORITHM,
  );
  if (!key) fail("OCR_ATTESTATION_KEY_NOT_ALLOWED");
  const trustedKey = key as OcrTrustedSignatureKey;
  const now = runtime.now;
  if (
    (trustedKey.notBefore && now < new Date(trustedKey.notBefore)) ||
    (trustedKey.notAfter && now > new Date(trustedKey.notAfter))
  )
    fail("OCR_ATTESTATION_KEY_NOT_ALLOWED");
  const publicKey = requireP256(trustedKey);
  const signature = parsedSignature.bytes;
  if (!Buffer.isBuffer(signature)) fail("OCR_ATTESTATION_SIGNATURE_INVALID");
  const signatureBytes = signature as Buffer;
  requireDerSignature(signatureBytes);
  if (
    !verifySignature(
      "sha256",
      parsedEnvelope.payloadBytes as Buffer,
      publicKey,
      signatureBytes,
    )
  )
    fail("OCR_ATTESTATION_SIGNATURE_INVALID");
  const payload = parsePayload(parsedEnvelope.payloadBytes as Buffer);
  const verified =
    payload.kind === "REFORMAFLOW_OCR_RELEASE"
      ? verifyWirePayload(payload, runtime)
      : runtime.embeddedTrustBundle
        ? verifyFlatPayload(payload, runtime)
        : fail("OCR_ATTESTATION_SCHEMA_INVALID");
  if (
    trustedKey.allowedWorkflowSha !== undefined &&
    trustedKey.allowedWorkflowSha !== verified.workflowSha
  )
    fail("OCR_ATTESTATION_WORKFLOW_NOT_ALLOWED");
  return Object.freeze({
    kind: "VERIFIED",
    algorithm: ALGORITHM,
    commitSha: verified.commitSha,
    treeSha: verified.treeSha,
    activationSubjectSha256: runtime.activationSubjectSha256,
  });
}
