import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertReleaseQualified,
  evaluateOcrSynth,
  type OcrEvalInput,
} from "./evaluator";

async function main(): Promise<void> {
  const evidencePath = process.argv[2];
  if (!evidencePath) {
    throw new Error(
      "Usage: npm run ocr-synth:release -- <live-evidence.json>; no provider is called by this harness",
    );
  }
  const raw = await readFile(resolve(process.cwd(), evidencePath), "utf8");
  const input = JSON.parse(raw) as OcrEvalInput;
  const report = await evaluateOcrSynth(input);
  console.log(JSON.stringify(report, null, 2));
  assertReleaseQualified(report);
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown qualification failure";
  console.error(message);
  process.exitCode = 1;
});
