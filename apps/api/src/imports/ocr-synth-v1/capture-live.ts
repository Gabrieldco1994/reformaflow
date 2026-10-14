import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  captureLiveEvidence,
  parseCaptureLiveManifestJson,
} from "./capture-live-core";
import { writeLiveEvidenceExclusive } from "./capture-live-file";
import { createConfiguredVertexPdfOcrProvider } from "../import-session/ocr/vertex-provider.factory";
import { VertexPdfOcrProvider } from "../import-session/ocr/vertex-pdf-ocr.provider";

const execFileAsync = promisify(execFile);
const gitHead = async (): Promise<string> => {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return stdout.trim();
};

async function main(): Promise<void> {
  const [outputArgument, manifestArgument] = process.argv.slice(2);
  if (!outputArgument || !manifestArgument)
    throw new Error("LIVE_CAPTURE_CONFIG_MISSING");
  const outputPath = resolve(process.cwd(), outputArgument);
  const manifestPath = resolve(process.cwd(), manifestArgument);
  if (outputPath === manifestPath)
    throw new Error("LIVE_CAPTURE_CONFIG_INVALID");
  const manifest = parseCaptureLiveManifestJson(
    await readFile(manifestPath, "utf8"),
  );
  let capturedHead: string | undefined;
  await writeLiveEvidenceExclusive(
    outputPath,
    async () => {
      capturedHead = await gitHead();
      const provider = await createConfiguredVertexPdfOcrProvider(process.env);
      if (!(provider instanceof VertexPdfOcrProvider) || !provider.ready())
        throw new Error("LIVE_CAPTURE_CONFIG_MISSING");
      return await captureLiveEvidence({
        provider,
        manifest,
        currentRepoSha: capturedHead,
      });
    },
    async () => {
      if (!capturedHead || (await gitHead()) !== capturedHead)
        throw new Error("LIVE_CAPTURE_REPOSITORY_DRIFT");
    },
  );
}

void main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^LIVE_CAPTURE_[A-Z_]+$/.test(error.message)
      ? error.message
      : "LIVE_CAPTURE_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
