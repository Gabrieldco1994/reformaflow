export const IMPORT_OCR_ENV_KEY = "IMPORT_OCR_ENABLED" as const;
const ENABLED_ENV_VALUE = "true";

export interface PdfOcrPrerequisiteReadiness {
  readonly providerReady: boolean;
  readonly consentV2Ready: boolean;
  readonly vaultReady: boolean;
}

export type PdfOcrEnvironment = Readonly<Record<string, string | undefined>>;

export function isPdfOcrProjectConfigured(
  environment: PdfOcrEnvironment,
): boolean {
  return (
    typeof environment.GOOGLE_CLOUD_PROJECT === "string" &&
    environment.GOOGLE_CLOUD_PROJECT.trim().length > 0
  );
}

/**
 * Qualification gate only. OCR remains absent from format advertisement; v2
 * analysis checks this gate after local inspection and before its attempt fence.
 */
export function isPdfOcrEnabled(
  environment: PdfOcrEnvironment,
  readiness: PdfOcrPrerequisiteReadiness,
): boolean {
  return (
    environment[IMPORT_OCR_ENV_KEY] === ENABLED_ENV_VALUE &&
    readiness.providerReady &&
    readiness.consentV2Ready &&
    readiness.vaultReady
  );
}
