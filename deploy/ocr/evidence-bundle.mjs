#!/usr/bin/env node
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalize,
  parseStrictJson,
} from "../../scripts/ci/ocr-attestation.mjs";
async function bytes(path) {
  const handle = await open(
    resolve(path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > 64 * 1024 * 1024
    )
      throw new Error("EVIDENCE_BUNDLE_INVALID");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
try {
  const [
    payloadTemplatePath,
    rawPath,
    reportPath,
    spendRequestPath,
    assessmentPath,
  ] = process.argv.slice(2);
  if (
    !payloadTemplatePath ||
    !rawPath ||
    !reportPath ||
    !spendRequestPath ||
    !assessmentPath
  )
    throw new Error("EVIDENCE_BUNDLE_INVALID");
  const payload = parseStrictJson(
    await readFile(resolve(payloadTemplatePath), "utf8"),
  );
  process.stdout.write(
    canonicalize({
      schemaVersion: 1,
      mode: "BUNDLE",
      payload,
      rawEvidenceBase64: (await bytes(rawPath)).toString("base64"),
      reportBase64: (await bytes(reportPath)).toString("base64"),
      spendRequestBase64: (await bytes(spendRequestPath)).toString("base64"),
      assessmentBase64: (await bytes(assessmentPath)).toString("base64"),
    }),
  );
} catch {
  process.stderr.write("EVIDENCE_BUNDLE_INVALID\n");
  process.exitCode = 1;
}
