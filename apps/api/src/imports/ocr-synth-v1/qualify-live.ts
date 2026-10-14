import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { assertReleaseQualified, evaluateOcrSynth } from "./evaluator";
import { parseLiveEvidenceJson } from "./live-evidence-parser";
import {
  assertQualityRepositorySnapshot,
  attestQualityClosure,
  withQualityCaptureLock,
} from "./quality-closure-attestation";

const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const EVIDENCE_MODE = 0o600;

async function readEvidenceOnce(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_EVIDENCE_BYTES ||
      (metadata.mode & 0o777) !== EVIDENCE_MODE
    )
      throw new Error("LIVE_EVIDENCE_FILE_INVALID");
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.size)
      throw new Error("LIVE_EVIDENCE_FILE_INVALID");
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1 || !arguments_[0])
    throw new Error("LIVE_EVIDENCE_PATH_MISSING");
  const evidencePath = resolve(process.cwd(), arguments_[0]);
  await withQualityCaptureLock(async () => {
    const input = parseLiveEvidenceJson(await readEvidenceOnce(evidencePath));
    if (!input.qualityClosure) throw new Error("QUALITY_ATTESTATION_MISSING");

    const rerun = await attestQualityClosure();
    const report = await evaluateOcrSynth(input);
    assertReleaseQualified(report);
    await assertQualityRepositorySnapshot(rerun.closure.snapshot, rerun.policy);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  });
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown qualification failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
