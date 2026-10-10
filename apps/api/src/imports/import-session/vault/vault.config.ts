/**
 * Syntactic configuration of the private import vault (B2a slice 1b). Pure: it interprets the five
 * keys plus the explicit drain binding and touches no filesystem, process, network or framework.
 * `configured: true` means the SYNTAX is complete; it is never "vault ON". Lock ownership, the
 * private root (realpath, owner/modes, outside UPLOADS_DIR, symlinks), fsync and headroom are
 * physical checks made by a later module, and the session writes switch is unrelated to it.
 */
export type VaultConfigReason =
  | "FLAG_OFF"
  | "NO_LOCK_FD"
  | "BAD_ROOT"
  | "IDLE_TIMEOUT_UNSET"
  | "HEADROOM_UNSET"
  | "DRAIN_TIMEOUT_UNSET";

export type VaultConfig =
  | { configured: false; reason: VaultConfigReason }
  | {
      configured: true;
      rootDir: string;
      lockFd: number;
      idleTimeoutMs: number;
      headroomBytes: number;
      drainTimeoutMs: number;
    };

/** First descriptor that is not stdin/stdout/stderr. */
const MIN_LOCK_FD = 3;
const DECIMAL = /^[0-9]+$/;

/** Plain decimal digits (leading zeros allowed, never octal), safe integer, at least `minimum`. */
function decimalAtLeast(
  raw: string | undefined,
  minimum: number,
): number | null {
  if (raw === undefined || !DECIMAL.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum ? value : null;
}

const off = (reason: VaultConfigReason): VaultConfig => ({
  configured: false,
  reason,
});

/**
 * Precedence: FLAG_OFF -> NO_LOCK_FD -> BAD_ROOT -> IDLE_TIMEOUT_UNSET -> HEADROOM_UNSET -> DRAIN_TIMEOUT_UNSET.
 * Only the literal "true" turns the flag on, and any other value returns before the remaining
 * keys are read. The root is returned verbatim: it is not normalised, resolved or checked.
 */
export function parseVaultConfig(env: NodeJS.ProcessEnv): VaultConfig {
  if (env["IMPORT_VAULT_ENABLED"] !== "true") return off("FLAG_OFF");

  const lockFd = decimalAtLeast(env["IMPORT_VAULT_LOCK_FD"], MIN_LOCK_FD);
  if (lockFd === null) return off("NO_LOCK_FD");

  const rootDir = env["VAULT_DIR"];
  if (
    rootDir === undefined ||
    !rootDir.startsWith("/") ||
    rootDir.includes("\0")
  ) {
    return off("BAD_ROOT");
  }

  const idleTimeoutMs = decimalAtLeast(env["IMPORT_VAULT_IDLE_TIMEOUT_MS"], 1);
  if (idleTimeoutMs === null) return off("IDLE_TIMEOUT_UNSET");

  const headroomBytes = decimalAtLeast(env["IMPORT_VAULT_HEADROOM_BYTES"], 1);
  if (headroomBytes === null) return off("HEADROOM_UNSET");

  const drainTimeoutMs = decimalAtLeast(
    env["IMPORT_VAULT_DRAIN_TIMEOUT_MS"],
    0,
  );
  if (drainTimeoutMs === null || drainTimeoutMs > 2147483647)
    return off("DRAIN_TIMEOUT_UNSET");

  return {
    configured: true,
    rootDir,
    lockFd,
    idleTimeoutMs,
    headroomBytes,
    drainTimeoutMs,
  };
}
