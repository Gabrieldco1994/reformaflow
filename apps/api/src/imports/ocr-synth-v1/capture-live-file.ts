import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import type { OcrEvalInput } from "./evaluator";
import { parseLiveEvidenceJson } from "./live-evidence-parser";

const OUTPUT_MODE = 0o600;

/** Exclusive, no-follow evidence write. A failed write leaves no partial file. */
export async function writeLiveEvidenceExclusive(
  outputPath: string,
  evidence: OcrEvalInput,
  afterOpen: () => Promise<void> = async () => undefined,
): Promise<void> {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  parseLiveEvidenceJson(serialized);
  let created = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
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
    await afterOpen();
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    handle = undefined;
    if (created) await unlink(outputPath).catch(() => undefined);
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}
