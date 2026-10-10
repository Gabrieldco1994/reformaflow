import {
  IMPORT_SESSION_PROTOCOL_VERSION,
  ImportSessionDocumentFormat,
  ImportSessionEntryUnavailableReason,
  type ImportSessionEntryV1,
} from "@reformaflow/domain";
import type { ImportSessionCapability } from "./import-session.capability";
import { ImportSessionCapabilityDisabledError } from "./import-session.disabled";
import type { ImportVaultGate } from "./vault/vault-state";

const CSV_ENTRY_FORMATS = Object.freeze([
  ImportSessionDocumentFormat.CSV,
]) as readonly [typeof ImportSessionDocumentFormat.CSV];
const MALFORMED_PRODUCER = "Invalid import entry producer";

function qualifiedFormats(
  capability: ImportSessionCapability,
): readonly [] | typeof CSV_ENTRY_FORMATS {
  const formats = capability.newImportFormats();
  if (!Array.isArray(formats)) throw new TypeError(MALFORMED_PRODUCER);

  let count = 0;
  for (const format of formats) {
    count += 1;
    if (format !== ImportSessionDocumentFormat.CSV)
      throw new TypeError(MALFORMED_PRODUCER);
  }
  if (count !== formats.length || count > 1)
    throw new TypeError(MALFORMED_PRODUCER);
  return count === 0 ? Object.freeze([]) : CSV_ENTRY_FORMATS;
}

/**
 * Pure projection over the boot-snapshotted producer and current vault authority. Catalog reads
 * never perform documentary I/O or lock rechecks.
 */
export function projectImportSessionEntry(
  capability: ImportSessionCapability,
  gate: ImportVaultGate,
): ImportSessionEntryV1 {
  // Validate the internal producer first so corruption never masquerades as normal unavailability.
  const formats = qualifiedFormats(capability);
  const writesEnabled = capability.writesEnabled();
  if (typeof writesEnabled !== "boolean")
    throw new TypeError(MALFORMED_PRODUCER);
  if (!writesEnabled) {
    return {
      kind: "UNAVAILABLE",
      version: IMPORT_SESSION_PROTOCOL_VERSION,
      reason: ImportSessionEntryUnavailableReason.NOT_ENABLED,
    };
  }
  if (
    gate.boot.state() !== "ON" ||
    gate.boot.stopped.aborted ||
    gate.boot.runtime() === null
  ) {
    return {
      kind: "UNAVAILABLE",
      version: IMPORT_SESSION_PROTOCOL_VERSION,
      reason: ImportSessionEntryUnavailableReason.RUNTIME_UNAVAILABLE,
    };
  }
  if (formats.length === 0) {
    return {
      kind: "UNAVAILABLE",
      version: IMPORT_SESSION_PROTOCOL_VERSION,
      reason: ImportSessionEntryUnavailableReason.NO_QUALIFIED_FORMAT,
    };
  }
  return {
    kind: "CARD_INVOICE",
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    formats: CSV_ENTRY_FORMATS,
  };
}

/**
 * CREATE authority: project first, prove the live lock, then project again to close revocation
 * during the proof. Every normal unavailable state deliberately collapses to the same 503.
 */
export async function assertImportSessionIntakeAvailable(
  capability: ImportSessionCapability,
  gate: ImportVaultGate,
): Promise<void> {
  if (projectImportSessionEntry(capability, gate).kind === "UNAVAILABLE")
    throw new ImportSessionCapabilityDisabledError();
  const proof = await gate.boot.recheckLock();
  if (
    !proof.ok ||
    projectImportSessionEntry(capability, gate).kind === "UNAVAILABLE"
  )
    throw new ImportSessionCapabilityDisabledError();
}
