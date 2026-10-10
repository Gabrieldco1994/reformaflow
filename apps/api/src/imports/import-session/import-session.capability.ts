import { ImportSessionDocumentFormat } from "@reformaflow/domain";
import { IMPORT_SESSION_WRITES_ENABLED } from "./import-session.disabled";

export interface ImportSessionClock {
  now(): Date;
}
export const IMPORT_SESSION_CLOCK = Symbol("IMPORT_SESSION_CLOCK");

export class SystemImportSessionClock implements ImportSessionClock {
  now(): Date {
    return new Date();
  }
}

/** Boot-snapshotted production intake capability; tests may override the Nest token. */
export interface ImportSessionCapability {
  writesEnabled(): boolean;
  /** Qualified RAW intake, never inferred from parser or EXTRACTED support. */
  newImportFormats(): ReadonlyArray<"CSV">;
}
export const IMPORT_SESSION_CAPABILITY = Symbol("IMPORT_SESSION_CAPABILITY");

export const IMPORT_SESSION_INTAKE_MODE_ENV = "IMPORT_SESSION_INTAKE_MODE";
const ImportSessionIntakeMode = {
  OFF: "off",
  CSV: "csv",
} as const;
type ImportSessionIntakeMode =
  (typeof ImportSessionIntakeMode)[keyof typeof ImportSessionIntakeMode];
const NO_IMPORT_FORMATS = Object.freeze([]) as readonly [];
const CSV_IMPORT_FORMATS = Object.freeze([
  ImportSessionDocumentFormat.CSV,
]) as readonly [typeof ImportSessionDocumentFormat.CSV];

/** Immutable boot snapshot. Direct construction remains OFF for test fixtures. */
export class DefaultImportSessionCapability implements ImportSessionCapability {
  constructor(
    private readonly mode: ImportSessionIntakeMode = ImportSessionIntakeMode.OFF,
  ) {}

  writesEnabled(): boolean {
    return this.mode === ImportSessionIntakeMode.CSV
      ? true
      : IMPORT_SESSION_WRITES_ENABLED;
  }

  newImportFormats(): ReturnType<ImportSessionCapability["newImportFormats"]> {
    return this.mode === ImportSessionIntakeMode.CSV
      ? CSV_IMPORT_FORMATS
      : NO_IMPORT_FORMATS;
  }
}

/**
 * Parses the sole production activation input once. No legacy environment key can activate
 * intake, and malformed values abort Nest provider construction rather than degrading silently.
 */
export function createImportSessionCapability(
  env: NodeJS.ProcessEnv,
): ImportSessionCapability {
  const mode = env[IMPORT_SESSION_INTAKE_MODE_ENV];
  if (mode === undefined || mode === ImportSessionIntakeMode.OFF)
    return new DefaultImportSessionCapability();
  if (mode === ImportSessionIntakeMode.CSV)
    return new DefaultImportSessionCapability(mode);
  throw new TypeError("Invalid import session intake mode");
}

export const IMPORT_SESSION_GRANT_VERIFIER = Symbol(
  "IMPORT_SESSION_GRANT_VERIFIER",
);
