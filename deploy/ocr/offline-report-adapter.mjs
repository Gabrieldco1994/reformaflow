#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../../scripts/ci/ocr-attestation.mjs";

const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;

async function readInput(stream = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_EVIDENCE_BYTES)
      throw new Error("LIVE_EVIDENCE_FILE_INVALID");
    chunks.push(chunk);
  }
  if (size === 0) throw new Error("LIVE_EVIDENCE_FILE_INVALID");
  return Buffer.concat(chunks).toString("utf8");
}

const defaultDependencies = Object.freeze({
  evaluate: async (raw) => {
    const module =
      await import("../../apps/api/dist/imports/ocr-synth-v1/offline-report.js");
    if (typeof module.evaluateOfflineReport !== "function")
      throw new Error("OCR_OFFLINE_REPORT_EXECUTABLE_NOT_AVAILABLE");
    return await module.evaluateOfflineReport(raw);
  },
  write: (value) => process.stdout.write(value),
});

export async function runOfflineReportAdapter(raw, dependencies = {}) {
  const runtime = { ...defaultDependencies, ...dependencies };
  const report = await runtime.evaluate(raw);
  runtime.write(`${canonicalize(report)}\n`);
  return report;
}

const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked)
  void readInput()
    .then((raw) => runOfflineReportAdapter(raw))
    .catch((error) => {
      const code =
        error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "OCR_OFFLINE_REPORT_FAILED";
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    });
