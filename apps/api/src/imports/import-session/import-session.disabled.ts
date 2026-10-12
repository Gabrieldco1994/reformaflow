import { ImportSessionErrorCode } from "@reformaflow/domain";
import { ImportSessionError } from "./import-session.errors";

/** No route, provider, tool, grant issuer or environment override enables this bootstrap. */
export const IMPORT_SESSION_WRITES_ENABLED = false;

const OPERATION_REQUIRES_ENABLED = {
  CREATE: true,
  RESERVE: true,
  UPLOAD: true,
  FINALIZE_UPLOAD: true,
  ANALYZE: true,
  EDIT: true,
  PREPARE: true,
  CHALLENGE: true,
  FIRST_CONFIRM: true,
  EXECUTE_UNAPPLIED: true,
  READ_SESSION: false,
  READ_RESULT: false,
  READ_PRIVATE_EXISTING: false,
  CANCEL: false,
  REPLAY_CONFIRMATION: false,
  REPLAY_APPLIED_RECEIPT: false,
  REAP: false,
} as const;
export type ImportSessionOperation = keyof typeof OPERATION_REQUIRES_ENABLED;

export class ImportSessionCapabilityDisabledError extends ImportSessionError {
  constructor() {
    super(ImportSessionErrorCode.CAPABILITY_DISABLED);
    this.name = "ImportSessionCapabilityDisabledError";
  }
}

/** Only a kill-switch policy, NOT authorization or an implementation of these operations. */
export function assertImportSessionOperationAvailable(
  operation: ImportSessionOperation,
  writesEnabled: boolean = IMPORT_SESSION_WRITES_ENABLED,
): void {
  // An unknown operation also fails closed if a future untyped adapter bypasses TypeScript.
  if (!writesEnabled && OPERATION_REQUIRES_ENABLED[operation] !== false) {
    throw new ImportSessionCapabilityDisabledError();
  }
}
