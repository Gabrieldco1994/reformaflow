import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import type { OcrEvalInput } from "./evaluator";
import { parseLiveEvidenceJson } from "./live-evidence-parser";

const OUTPUT_MODE = 0o600;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;

type Handle = Awaited<ReturnType<typeof open>>;
type Identity = Readonly<{ dev: number; ino: number }>;

async function assertReservedFile(
  path: string,
  handle: Handle,
  identity: Identity,
): Promise<void> {
  const descriptor = await handle.stat();
  const linked = await lstat(path);
  if (
    !descriptor.isFile() ||
    !linked.isFile() ||
    descriptor.dev !== identity.dev ||
    descriptor.ino !== identity.ino ||
    linked.dev !== identity.dev ||
    linked.ino !== identity.ino ||
    (descriptor.mode & 0o777) !== OUTPUT_MODE ||
    (linked.mode & 0o777) !== OUTPUT_MODE
  )
    throw new Error("LIVE_CAPTURE_RESERVED_FILE_INVALID");
}

async function reserve(path: string): Promise<{
  handle: Handle;
  identity: Identity;
}> {
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    OUTPUT_MODE,
  );
  const metadata = await handle.stat();
  const identity = { dev: metadata.dev, ino: metadata.ino };
  await assertReservedFile(path, handle, identity);
  return { handle, identity };
}

async function removeOwned(path: string, identity: Identity): Promise<void> {
  const current = await lstat(path).catch(() => undefined);
  if (current?.dev === identity.dev && current.ino === identity.ino)
    await unlink(path).catch(() => undefined);
}

/** Exclusive, no-follow evidence write. A failed write leaves no partial file. */
export async function writeLiveEvidenceExclusive(
  outputPath: string,
  evidenceFactory: () => Promise<OcrEvalInput>,
  verifyBeforeWrite: () => Promise<void> = async () => undefined,
): Promise<void> {
  let created = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: Readonly<{ dev: number; ino: number }> | undefined;
  try {
    handle = await open(
      outputPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      OUTPUT_MODE,
    );
    created = true;
    const reserved = await handle.stat();
    identity = { dev: reserved.dev, ino: reserved.ino };
    if (!reserved.isFile() || (reserved.mode & 0o777) !== OUTPUT_MODE)
      throw new Error("LIVE_CAPTURE_OUTPUT_INVALID");
    const evidence = await evidenceFactory();
    await verifyBeforeWrite();
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    parseLiveEvidenceJson(serialized);
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    handle = undefined;
    if (created && identity) {
      const current = await lstat(outputPath).catch(() => undefined);
      if (current?.dev === identity.dev && current.ino === identity.ino)
        await unlink(outputPath).catch(() => undefined);
    }
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

/**
 * Reserves both the evidence path and the fixed repository lock before any
 * provider dispatch. Both files are no-follow, exclusive and identity-checked.
 */
export async function writeQualifiedLiveEvidenceExclusive(
  outputPath: string,
  lockPath: string,
  evidenceFactory: () => Promise<OcrEvalInput>,
  verifyRepository: () => Promise<void>,
): Promise<void> {
  let lock: Awaited<ReturnType<typeof reserve>> | undefined;
  let output: Awaited<ReturnType<typeof reserve>> | undefined;
  let published = false;
  try {
    lock = await reserve(lockPath);
    output = await reserve(outputPath);
    const evidence = await evidenceFactory();
    await verifyRepository();
    await assertReservedFile(lockPath, lock.handle, lock.identity);
    await assertReservedFile(outputPath, output.handle, output.identity);
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_EVIDENCE_BYTES)
      throw new Error("LIVE_CAPTURE_OUTPUT_INVALID");
    parseLiveEvidenceJson(serialized);
    await output.handle.writeFile(serialized, { encoding: "utf8" });
    await output.handle.sync();
    await verifyRepository();
    await assertReservedFile(lockPath, lock.handle, lock.identity);
    await assertReservedFile(outputPath, output.handle, output.identity);
    published = true;
  } finally {
    if (output) await output.handle.close().catch(() => undefined);
    if (lock) await lock.handle.close().catch(() => undefined);
    if (!published && output) await removeOwned(outputPath, output.identity);
    if (lock) await removeOwned(lockPath, lock.identity);
  }
}
