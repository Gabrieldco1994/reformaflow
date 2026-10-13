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
      "Usage: npx ts-node src/imports/ocr-synth-v1/qualify-live.ts <live-evidence.json>; evidence must come from the real production adapter seam",
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
