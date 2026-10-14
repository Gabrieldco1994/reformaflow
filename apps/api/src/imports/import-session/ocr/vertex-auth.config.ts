import {
  PDF_OCR_PROVIDER_ID,
  type VertexAuthTraceV2,
} from "@reformaflow/domain";
import { parseStrictJson } from "./strict-json";

export const VERTEX_AUTH_STARTUP_ERROR = "VERTEX_AUTH_CONFIG_INVALID";

export type VertexAuthConfig =
  | Readonly<{ state: "OCR_DISABLED" }>
  | Readonly<{
      state: "OCR_ENABLED";
      authMode: "local-adc" | "service-account-file";
      authTrace: VertexAuthTraceV2;
      projectId: string;
    }>;

const API_KEY_ENVIRONMENT_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "VERTEX_API_KEY",
] as const;
const AMBIENT_CREDENTIAL_ENVIRONMENT_KEYS = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_CONFIG",
  "GCE_METADATA_HOST",
  "GCE_METADATA_IP",
] as const;

function isPresent(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function invalid(): VertexAuthConfig {
  return Object.freeze({ state: "OCR_DISABLED" });
}

export interface OcrActivationAttestationVerifier {
  verify(
    input: Readonly<{
      keyId: string;
      candidateSha: string;
      imageDigest: string;
      executableSha256: string;
      provider: typeof PDF_OCR_PROVIDER_ID;
      evidenceSha256: string;
      signature: string;
    }>,
  ): boolean;
}

export interface VertexAuthConfigDependencies {
  readonly verifier?: OcrActivationAttestationVerifier;
  readonly releaseVerified?: boolean;
}

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

function activationVerified(
  environment: Readonly<Record<string, string | undefined>>,
  verifier: OcrActivationAttestationVerifier | undefined,
): boolean {
  if (!verifier) return false;
  let value: unknown;
  try {
    value = parseStrictJson(environment.OCR_QUALIFICATION_ATTESTATION ?? "");
  } catch {
    return false;
  }
  const keys = [
    "keyId",
    "candidateSha",
    "imageDigest",
    "executableSha256",
    "provider",
    "evidenceSha256",
    "signature",
  ] as const;
  if (
    !object(value) ||
    !exact(value, keys) ||
    typeof value.keyId !== "string" ||
    value.keyId.length === 0 ||
    typeof value.candidateSha !== "string" ||
    !SHA.test(value.candidateSha) ||
    typeof value.imageDigest !== "string" ||
    !IMAGE_DIGEST.test(value.imageDigest) ||
    typeof value.executableSha256 !== "string" ||
    !HASH.test(value.executableSha256) ||
    value.provider !== PDF_OCR_PROVIDER_ID ||
    typeof value.evidenceSha256 !== "string" ||
    !HASH.test(value.evidenceSha256) ||
    typeof value.signature !== "string" ||
    value.signature.length === 0 ||
    value.candidateSha !== environment.OCR_CANDIDATE_SHA ||
    value.imageDigest !== environment.OCR_IMAGE_DIGEST ||
    value.executableSha256 !== environment.OCR_EXECUTABLE_SHA256
  )
    return false;
  try {
    return verifier.verify({
      keyId: value.keyId,
      candidateSha: value.candidateSha,
      imageDigest: value.imageDigest,
      executableSha256: value.executableSha256,
      provider: PDF_OCR_PROVIDER_ID,
      evidenceSha256: value.evidenceSha256,
      signature: value.signature,
    });
  } catch {
    return false;
  }
}

/**
 * Resolves the single admitted Vertex credential source before provider startup.
 * Disabled OCR deliberately short-circuits before inspecting auth-related values.
 */
export function parseVertexAuthConfig(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: VertexAuthConfigDependencies = {},
): VertexAuthConfig {
  if (environment.IMPORT_OCR_ENABLED !== "true") {
    return Object.freeze({ state: "OCR_DISABLED" });
  }
  if (
    dependencies.releaseVerified !== true &&
    !activationVerified(environment, dependencies.verifier)
  )
    return invalid();

  const projectId = environment.GOOGLE_CLOUD_PROJECT?.trim();
  if (
    !projectId ||
    API_KEY_ENVIRONMENT_KEYS.some((key) => isPresent(environment[key])) ||
    AMBIENT_CREDENTIAL_ENVIRONMENT_KEYS.some((key) =>
      isPresent(environment[key]),
    )
  ) {
    return invalid();
  }

  const production = environment.NODE_ENV === "production";
  if (!production) {
    if (environment.VERTEX_AUTH_MODE !== "local-adc") {
      return invalid();
    }
    return Object.freeze({
      state: "OCR_ENABLED",
      authMode: "local-adc",
      authTrace: "LOCAL_ADC",
      projectId,
    });
  }

  if (environment.VERTEX_AUTH_MODE !== "service-account-file") {
    return invalid();
  }

  return Object.freeze({
    state: "OCR_ENABLED",
    authMode: "service-account-file",
    authTrace: "SERVICE_ACCOUNT_FILE_ADC",
    projectId,
  });
}
