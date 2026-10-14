import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import type { OcrEvalInput } from "./evaluator";
import { parseLiveEvidenceJson } from "./live-evidence-parser";

const OUTPUT_MODE = 0o600;

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
