import * as fs from "node:fs";

const OS_ERRNOS = [
  "EACCES",
  "EBADF",
  "EBUSY",
  "EDQUOT",
  "EFAULT",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENAMETOOLONG",
  "ENFILE",
  "ENOENT",
  "ENOMEM",
  "ENOSPC",
  "ENOSYS",
  "ENOTDIR",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EOVERFLOW",
  "EPERM",
  "EROFS",
  "ESTALE",
  "ETIMEDOUT",
] as const;
export type VaultErrno = (typeof OS_ERRNOS)[number] | "UNKNOWN";
export type FsFailure = {
  ok: false;
  outcome: "FS_ERROR";
  code: VaultErrno;
  closeCode?: VaultErrno;
};
type Settled = { ok: false; outcome: "SETTLED" };
export type FsyncResult = { ok: true } | FsFailure | Settled;
export type SpaceResult =
  | { ok: true; available: bigint }
  | FsFailure
  | Settled
  | { ok: false; outcome: "INVALID_STATFS" };
export type CleanupError = { step: "fsync-close"; code: VaultErrno };

/** Only known OS errnos cross the diagnostic boundary, including for hostile getters/proxies. */
export function boundedCode(error: unknown): VaultErrno {
  try {
    const raw =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    return OS_ERRNOS.find((code) => code === raw) ?? "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

const settledResult = (): Settled => ({ ok: false, outcome: "SETTLED" });

/**
 * Capability probe for this directory's FS, not proof of past writes' durability.
 * Owns only the handle it opens; close is mandatory even after settlement or a callback throw.
 */
export async function fsyncProbe(
  dir: string,
  isSettled: () => boolean,
  onCleanupError: (error: CleanupError) => void,
): Promise<FsyncResult> {
  if (isSettled()) return settledResult();
  let handle;
  try {
    handle = await fs.promises.open(
      dir,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    return { ok: false, outcome: "FS_ERROR", code: boundedCode(error) };
  }

  let stopped = false;
  let syncCode: VaultErrno | undefined;
  let closeCode: VaultErrno | undefined;
  let callbackThrew = false;
  let callbackError: unknown;
  try {
    stopped = isSettled();
    if (!stopped) {
      try {
        await handle.sync();
      } catch (error) {
        syncCode = boundedCode(error);
      }
    }
  } catch (error) {
    // This is a callback failure, NOT an errno from sync/open.
    callbackThrew = true;
    callbackError = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      closeCode = boundedCode(error);
    }
  }
  if (callbackThrew) {
    if (closeCode !== undefined)
      onCleanupError({ step: "fsync-close", code: closeCode });
    throw callbackError;
  }
  // Genuine FS failures survive a timeout; SETTLED must never erase either code.
  if (syncCode !== undefined) {
    return {
      ok: false,
      outcome: "FS_ERROR",
      code: syncCode,
      ...(closeCode !== undefined ? { closeCode } : {}),
    };
  }
  if (closeCode !== undefined)
    return { ok: false, outcome: "FS_ERROR", code: closeCode };
  return isSettled() || stopped ? settledResult() : { ok: true };
}

/** Measures the FS containing t, using non-privileged available blocks, never Number transport. */
export async function availableBytes(
  dir: string,
  isSettled: () => boolean,
): Promise<SpaceResult> {
  if (isSettled()) return settledResult();
  let stats;
  try {
    stats = await fs.promises.statfs(dir, { bigint: true });
  } catch (error) {
    return { ok: false, outcome: "FS_ERROR", code: boundedCode(error) };
  }
  if (
    !stats ||
    typeof stats.bavail !== "bigint" ||
    typeof stats.bsize !== "bigint" ||
    stats.bavail < 0n ||
    stats.bsize <= 0n
  )
    return { ok: false, outcome: "INVALID_STATFS" };
  if (isSettled()) return settledResult();
  return { ok: true, available: stats.bavail * stats.bsize };
}
