#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  parseStrictJson,
  sha256,
} from "../../scripts/ci/ocr-attestation.mjs";

function fail(code) {
  throw new Error(code);
}

export async function inspectOciLayout(root) {
  const layout = parseStrictJson(
    await readFile(resolve(root, "oci-layout"), "utf8"),
  );
  if (layout.imageLayoutVersion !== "1.0.0") fail("OCI_LAYOUT_INVALID");
  const indexBytes = await readFile(resolve(root, "index.json"));
  const index = parseStrictJson(indexBytes.toString("utf8"));
  if (
    index.schemaVersion !== 2 ||
    !Array.isArray(index.manifests) ||
    index.manifests.length !== 1
  )
    fail("OCI_LAYOUT_INVALID");
  const manifest = index.manifests[0];
  if (
    manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
    Object.hasOwn(manifest, "artifactType") ||
    !manifest.digest?.match(/^sha256:[0-9a-f]{64}$/) ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size <= 0
  )
    fail("OCI_LAYOUT_INVALID");
  const manifestPath = resolve(
    root,
    "blobs",
    "sha256",
    manifest.digest.slice(7),
  );
  const manifestBytes = await readFile(manifestPath);
  if (
    manifestBytes.length !== manifest.size ||
    `sha256:${sha256(manifestBytes)}` !== manifest.digest
  )
    fail("OCI_LAYOUT_INVALID");
  const parsedManifest = parseStrictJson(manifestBytes.toString("utf8"));
  if (
    parsedManifest.schemaVersion !== 2 ||
    parsedManifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
    Object.hasOwn(parsedManifest, "subject") ||
    !Array.isArray(parsedManifest.layers) ||
    !parsedManifest.config?.digest?.match(/^sha256:[0-9a-f]{64}$/)
  )
    fail("OCI_LAYOUT_INVALID");
  const configPath = resolve(
    root,
    "blobs",
    "sha256",
    parsedManifest.config.digest.slice(7),
  );
  const configBytes = await readFile(configPath);
  if (
    `sha256:${sha256(configBytes)}` !== parsedManifest.config.digest ||
    (await stat(configPath)).size !== configBytes.length
  )
    fail("OCI_LAYOUT_INVALID");
  return {
    imageDigest: manifest.digest,
    configDigest: parsedManifest.config.digest,
    indexSha256: sha256(indexBytes),
  };
}

const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [root] = process.argv.slice(2);
  inspectOciLayout(resolve(root ?? "."))
    .then((result) => process.stdout.write(`${canonicalize(result)}\n`))
    .catch((error) => {
      const code =
        error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "OCI_LAYOUT_INVALID";
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    });
}
