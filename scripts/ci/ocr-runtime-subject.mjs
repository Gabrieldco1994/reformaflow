#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, parseStrictJson, sha256 } from "./ocr-attestation.mjs";

const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[1-9][0-9]*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;
const ENTRYPOINT = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const WORKFLOW_PATH = ".github/workflows/ocr-runtime-subject.yml";
const ARTIFACT_NAME = "ocr-runtime-subject-v1";
function fail(code) {
  throw new Error(code);
}
function object(value, code = "RUNTIME_SUBJECT_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}
function exact(value, keys, code = "RUNTIME_SUBJECT_INVALID") {
  object(value, code);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    fail(code);
}
function match(value, pattern, code = "RUNTIME_SUBJECT_INVALID") {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}
function timestamp(value, code = "RUNTIME_SUBJECT_INVALID") {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail(code);
  return value;
}
function inspectObject(value) {
  if (!Array.isArray(value) || value.length !== 1)
    fail("RUNTIME_SUBJECT_IMAGE_INVALID");
  return object(value[0], "RUNTIME_SUBJECT_IMAGE_INVALID");
}

export function resolveApplicationEntrypoint(inspectJson) {
  const image = inspectObject(inspectJson);
  const config = object(image.Config, "RUNTIME_SUBJECT_EXECUTABLE_UNRESOLVED");
  const candidates =
    Array.isArray(config.Entrypoint) && config.Entrypoint.length > 0
      ? config.Entrypoint
      : config.Cmd;
  if (
    !Array.isArray(candidates) ||
    candidates.length !== 1 ||
    !ENTRYPOINT.test(candidates[0])
  )
    fail("RUNTIME_SUBJECT_EXECUTABLE_UNRESOLVED");
  return candidates[0];
}

function validateContext(context) {
  exact(context, [
    "repository",
    "repositoryId",
    "repositoryOwnerId",
    "commitSha",
    "treeSha",
    "workflowSha",
    "runId",
    "runAttempt",
    "imageReference",
    "observedAt",
  ]);
  match(context.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  match(String(context.repositoryId), ID);
  match(String(context.repositoryOwnerId), ID);
  match(context.commitSha, SHA);
  match(context.treeSha, SHA);
  match(context.workflowSha, SHA);
  match(String(context.runId), ID);
  if (context.runAttempt !== 1) fail("RUNTIME_SUBJECT_RUN_ATTEMPT_UNSUPPORTED");
  match(context.imageReference, IMAGE);
  timestamp(context.observedAt);
  return context;
}

export function validateRuntimeSubject(receipt) {
  exact(receipt, [
    "schemaVersion",
    "kind",
    "repository",
    "git",
    "workflow",
    "image",
    "observedAt",
  ]);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "REFORMAFLOW_OCR_RUNTIME_SUBJECT"
  )
    fail("RUNTIME_SUBJECT_INVALID");
  exact(receipt.repository, ["name", "id", "ownerId"]);
  match(receipt.repository.name, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  match(receipt.repository.id, ID);
  match(receipt.repository.ownerId, ID);
  exact(receipt.git, ["commitSha", "treeSha"]);
  match(receipt.git.commitSha, SHA);
  match(receipt.git.treeSha, SHA);
  exact(receipt.workflow, ["path", "sha", "runId", "runAttempt"]);
  if (
    receipt.workflow.path !== WORKFLOW_PATH ||
    receipt.workflow.runAttempt !== 1
  )
    fail("RUNTIME_SUBJECT_INVALID");
  match(receipt.workflow.sha, SHA);
  match(receipt.workflow.runId, ID);
  exact(receipt.image, [
    "reference",
    "digest",
    "ociConfigDigest",
    "applicationEntrypointPath",
    "applicationEntrypointSize",
    "executableSha256",
  ]);
  match(receipt.image.reference, IMAGE);
  match(receipt.image.digest, DIGEST);
  match(receipt.image.ociConfigDigest, DIGEST);
  match(receipt.image.applicationEntrypointPath, ENTRYPOINT);
  match(receipt.image.executableSha256, HASH);
  if (
    !receipt.image.reference.endsWith("@" + receipt.image.digest) ||
    !Number.isSafeInteger(receipt.image.applicationEntrypointSize) ||
    receipt.image.applicationEntrypointSize <= 0
  )
    fail("RUNTIME_SUBJECT_INVALID");
  timestamp(receipt.observedAt);
  return receipt;
}

export function createRuntimeSubject(inspectJson, targetBytes, context) {
  validateContext(context);
  if (!Buffer.isBuffer(targetBytes) || targetBytes.length === 0)
    fail("RUNTIME_SUBJECT_EXECUTABLE_UNRESOLVED");
  const image = inspectObject(inspectJson);
  const entrypoint = resolveApplicationEntrypoint(inspectJson);
  match(image.Id, DIGEST, "RUNTIME_SUBJECT_IMAGE_INVALID");
  if (
    !Array.isArray(image.RepoDigests) ||
    !image.RepoDigests.includes(context.imageReference)
  )
    fail("RUNTIME_SUBJECT_IMAGE_INVALID");
  const labels = object(image.Config?.Labels, "RUNTIME_SUBJECT_IMAGE_INVALID");
  if (
    labels.GH_SHA !== context.commitSha ||
    labels["org.opencontainers.image.revision"] !== context.commitSha ||
    labels["com.reformaflow.git.tree"] !== context.treeSha
  )
    fail("RUNTIME_SUBJECT_IMAGE_INVALID");
  return validateRuntimeSubject({
    schemaVersion: 1,
    kind: "REFORMAFLOW_OCR_RUNTIME_SUBJECT",
    repository: {
      name: context.repository,
      id: String(context.repositoryId),
      ownerId: String(context.repositoryOwnerId),
    },
    git: { commitSha: context.commitSha, treeSha: context.treeSha },
    workflow: {
      path: WORKFLOW_PATH,
      sha: context.workflowSha,
      runId: String(context.runId),
      runAttempt: context.runAttempt,
    },
    image: {
      reference: context.imageReference,
      digest: context.imageReference.split("@")[1],
      ociConfigDigest: image.Id,
      applicationEntrypointPath: entrypoint,
      applicationEntrypointSize: targetBytes.length,
      executableSha256: sha256(targetBytes),
    },
    observedAt: context.observedAt,
  });
}

export function verifyRuntimeSubject(
  receipt,
  inspectJson,
  targetBytes,
  expected,
) {
  validateRuntimeSubject(receipt);
  validateContext(expected);
  const recreated = createRuntimeSubject(inspectJson, targetBytes, expected);
  if (canonicalize(recreated) !== canonicalize(receipt))
    fail("RUNTIME_SUBJECT_MISMATCH");
  return receipt;
}

export function verifyRuntimeSubjectArtifact(
  metadata,
  archiveBytes,
  receiptBytes,
  expected,
) {
  object(metadata, "RUNTIME_SUBJECT_ARTIFACT_INVALID");
  exact(expected, [
    "artifactId",
    "repositoryId",
    "runId",
    "runAttempt",
    "commitSha",
    "treeSha",
    "workflowSha",
  ]);
  if (
    String(metadata.id) !== String(expected.artifactId) ||
    metadata.name !== ARTIFACT_NAME ||
    metadata.expired !== false ||
    metadata.digest !== "sha256:" + sha256(archiveBytes) ||
    String(metadata.workflow_run?.id) !== String(expected.runId) ||
    String(metadata.workflow_run?.head_repository_id) !==
      String(expected.repositoryId) ||
    metadata.workflow_run?.head_sha !== expected.commitSha ||
    Number(expected.runAttempt) !== 1
  )
    fail("RUNTIME_SUBJECT_ARTIFACT_INVALID");
  const receipt = validateRuntimeSubject(
    parseStrictJson(receiptBytes.toString("utf8")),
  );
  if (
    receipt.repository.id !== String(expected.repositoryId) ||
    receipt.git.commitSha !== expected.commitSha ||
    receipt.git.treeSha !== expected.treeSha ||
    receipt.workflow.sha !== expected.workflowSha ||
    receipt.workflow.runId !== String(expected.runId) ||
    receipt.workflow.runAttempt !== 1
  )
    fail("RUNTIME_SUBJECT_ARTIFACT_INVALID");
  return {
    schemaVersion: 1,
    artifactId: String(metadata.id),
    githubArtifactDigest: metadata.digest,
    runtimeSubjectArtifactSha256: sha256(receiptBytes),
    receipt,
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "resolve-path") {
    const inspect = parseStrictJson(await readFile(resolve(args[0]), "utf8"));
    process.stdout.write(resolveApplicationEntrypoint(inspect) + "\n");
    return;
  }
  if (command === "create") {
    const inspect = parseStrictJson(await readFile(resolve(args[0]), "utf8"));
    const target = await readFile(resolve(args[1]));
    const context = parseStrictJson(await readFile(resolve(args[2]), "utf8"));
    process.stdout.write(
      canonicalize(createRuntimeSubject(inspect, target, context)),
    );
    return;
  }
  if (command === "verify") {
    const receipt = parseStrictJson(await readFile(resolve(args[0]), "utf8"));
    const inspect = parseStrictJson(await readFile(resolve(args[1]), "utf8"));
    const target = await readFile(resolve(args[2]));
    const expected = parseStrictJson(await readFile(resolve(args[3]), "utf8"));
    process.stdout.write(
      canonicalize(verifyRuntimeSubject(receipt, inspect, target, expected)),
    );
    return;
  }
  if (command === "verify-artifact") {
    const metadata = parseStrictJson(await readFile(resolve(args[0]), "utf8"));
    const archive = await readFile(resolve(args[1]));
    const receipt = await readFile(resolve(args[2]));
    const expected = parseStrictJson(await readFile(resolve(args[3]), "utf8"));
    process.stdout.write(
      canonicalize(
        verifyRuntimeSubjectArtifact(metadata, archive, receipt, expected),
      ),
    );
    return;
  }
  fail("RUNTIME_SUBJECT_USAGE_INVALID");
}
const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked)
  main().catch((error) => {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "RUNTIME_SUBJECT_INVALID";
    process.stderr.write(code + "\n");
    process.exitCode = 1;
  });
