#!/usr/bin/env node
// Product-owned OCR scoring is intentionally absent from this repository-only SRE slice.
// The qualification DAG cannot emit a report or attestation until that executable is reviewed.
process.stderr.write("OCR_OFFLINE_REPORT_EXECUTABLE_NOT_AVAILABLE\n");
process.exitCode = 1;
