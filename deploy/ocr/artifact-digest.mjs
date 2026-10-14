#!/usr/bin/env node
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  parseStrictJson,
  sha256,
} from "../../scripts/ci/ocr-attestation.mjs";

function fail(code) {
  throw new Error(code);
}
function filename(value) {
  if (
    typeof value !== "string" ||
    basename(value) !== value ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  )
    fail("ARTIFACT_DIGEST_INVALID");
  return value;
}
async function bytes(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0)
      fail("ARTIFACT_DIGEST_INVALID");
    const value = await handle.readFile();
    if (value.length !== metadata.size) fail("ARTIFACT_DIGEST_INVALID");
    return value;
  } finally {
    await handle.close();
  }
}

export async function createArtifactDigest(directory, name) {
  filename(name);
  const value = await bytes(resolve(directory, name));
  return {
    schemaVersion: 1,
    filename: name,
    sha256: sha256(value),
    size: value.length,
  };
}

export async function verifyArtifactDigest(directory, manifest) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Reflect.ownKeys(manifest).length !== 4 ||
    manifest.schemaVersion !== 1 ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size <= 0
  )
    fail("ARTIFACT_DIGEST_INVALID");
  filename(manifest.filename);
  const actual = await createArtifactDigest(directory, manifest.filename);
  if (canonicalize(actual) !== canonicalize(manifest))
    fail("ARTIFACT_DIGEST_MISMATCH");
  return actual;
}

const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [command, directory, value] = process.argv.slice(2);
  try {
    if (command === "create")
      process.stdout.write(
        canonicalize(await createArtifactDigest(resolve(directory), value)),
      );
    else if (command === "verify") {
      const manifest = parseStrictJson(
        await readFile(resolve(directory, value), "utf8"),
      );
      await verifyArtifactDigest(resolve(directory), manifest);
      process.stdout.write("ARTIFACT_DIGEST_OK");
    } else fail("USAGE_INVALID");
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "ARTIFACT_DIGEST_INVALID";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
