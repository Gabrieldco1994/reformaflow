export const IMPORT_OCR_ENV_KEY = "IMPORT_OCR_ENABLED" as const;
const ENABLED_ENV_VALUE = "true";

export interface PdfOcrPrerequisiteReadiness {
  readonly providerReady: boolean;
  readonly consentV2Ready: boolean;
  readonly vaultReady: boolean;
}

export type PdfOcrEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Qualification gate only. It is intentionally not wired into import format
 * advertisement or a Nest provider in PR-A.
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
