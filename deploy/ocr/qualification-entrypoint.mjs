#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ROOT = "/opt/qualification";
const ATTESTATION = resolve(ROOT, "scripts/ci/ocr-attestation.mjs");
const CAPTURE = resolve(ROOT, "deploy/ocr/wif-adapter.mjs");
const BUILD_UNSIGNED = resolve(
  ROOT,
  "deploy/ocr/build-unsigned-attestation.mjs",
);
const OFFLINE_REPORT = resolve(ROOT, "deploy/ocr/offline-report-adapter.mjs");

function run(file, args) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  child.on("error", () => process.exit(70));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 70);
  });
}

const [command, ...args] = process.argv.slice(2);
if (command === "capture") run(CAPTURE, args);
else if (command === "assess-report")
  run(BUILD_UNSIGNED, [args[0] ?? "-", "--assessment"]);
else if (command === "build-unsigned") run(BUILD_UNSIGNED, args);
else if (command === "offline-report") run(OFFLINE_REPORT, args);
else if (
  [
    "canonicalize",
    "prepare-payload",
    "make-envelope",
    "verify",
    "verify-repository",
    "reserve-spend",
  ].includes(command)
)
  run(ATTESTATION, [command, ...args]);
else {
  process.stderr.write("QUALIFICATION_COMMAND_INVALID\n");
  process.exit(64);
}
