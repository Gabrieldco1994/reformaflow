import type { VertexAuthTraceV2 } from "@reformaflow/domain";

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

function invalid(): never {
  throw new Error(VERTEX_AUTH_STARTUP_ERROR);
}

/**
 * Resolves the single admitted Vertex credential source before provider startup.
 * Disabled OCR deliberately short-circuits before inspecting auth-related values.
 */
export function parseVertexAuthConfig(
  environment: Readonly<Record<string, string | undefined>>,
): VertexAuthConfig {
  if (environment.IMPORT_OCR_ENABLED !== "true") {
    return Object.freeze({ state: "OCR_DISABLED" });
  }

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
