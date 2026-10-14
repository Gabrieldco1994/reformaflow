#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  parseStrictJson,
  projectReviewSet,
  sha256,
} from "../../scripts/ci/ocr-attestation.mjs";

const ROLES = [
  "DATA_OWNER_RISK_ACCEPTANCE",
  "SECURITY",
  "PRIVACY",
  "DATA_OWNER_FINAL",
];
const APPROVAL_FILES = [
  "approval-data-owner-risk.json",
  "approval-security.json",
  "approval-privacy.json",
  "approval-data-owner-final.json",
];
const COMMIT = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
function fail(code) {
  throw new Error(code);
}
function git(root, args, encoding = "utf8", input) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding,
    input,
    maxBuffer: 4 * 1024 * 1024,
  });
}
function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    fail("REVIEW_SET_INVALID");
}

function verifyLoadedReviewDocuments(
  subjectSha,
  subjectTree,
  required,
  policy,
  loadDocument,
) {
  if (!COMMIT.test(subjectSha) || !COMMIT.test(subjectTree))
    fail("SUBJECT_SHA_INVALID");
  exact(required, ["schemaVersion", "reviews"]);
  if (
    required.schemaVersion !== 1 ||
    !Array.isArray(required.reviews) ||
    required.reviews.length !== 4
  )
    fail("REVIEW_SET_INVALID");
  if (!policy?.policy || !HASH.test(policy.policy.sha256))
    fail("REVIEW_SET_INVALID");
  const documents = [];
  for (let index = 0; index < ROLES.length; index += 1) {
    const requiredReview = required.reviews[index];
    exact(requiredReview, ["role", "path"]);
    if (
      requiredReview.role !== ROLES[index] ||
      !/^deploy\/ocr\/reviews\/[a-z0-9-]+\.json$/.test(requiredReview.path)
    )
      fail("REVIEW_SET_INVALID");
    const loaded = loadDocument(requiredReview.path);
    const review = parseStrictJson(loaded.bytes.toString("utf8"));
    exact(review, ["schemaVersion", "role", "policySha256", "scope"]);
    if (
      review.schemaVersion !== 1 ||
      review.role !== ROLES[index] ||
      review.policySha256 !== policy.policy.sha256 ||
      review.scope !== "OCR_QUALIFICATION_V1" ||
      !HASH.test(review.policySha256) ||
      !COMMIT.test(loaded.blobSha)
    )
      fail("REVIEW_SET_INVALID");
    documents.push({
      role: review.role,
      path: requiredReview.path,
      blobSha: loaded.blobSha,
      sha256: sha256(loaded.bytes),
      policySha256: review.policySha256,
    });
  }
  return Object.freeze({
    subjectSha,
    subjectTree,
    policySha256: policy.policy.sha256,
    documents,
    documentSetSha256: sha256(canonicalize(documents)),
  });
}

export function verifyReviewDocuments(root, sha) {
  if (!COMMIT.test(sha)) fail("SUBJECT_SHA_INVALID");
  const tree = git(root, ["rev-parse", `${sha}^{tree}`]).trim();
  const required = parseStrictJson(
    git(root, ["show", `${sha}:deploy/ocr/required-reviews.json`]),
  );
  const policy = parseStrictJson(
    git(root, ["show", `${sha}:deploy/ocr/infra-policy.json`]),
  );
  return verifyLoadedReviewDocuments(sha, tree, required, policy, (path) => ({
    bytes: git(root, ["show", `${sha}:${path}`], null),
    blobSha: git(root, ["rev-parse", `${sha}:${path}`]).trim(),
  }));
}

export function verifyReviewWorktree(root) {
  const subjectSha = git(root, ["rev-parse", "HEAD"]).trim();
  const subjectTree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const required = parseStrictJson(
    readFileSync(resolve(root, "deploy/ocr/required-reviews.json"), "utf8"),
  );
  const policy = parseStrictJson(
    readFileSync(resolve(root, "deploy/ocr/infra-policy.json"), "utf8"),
  );
  return verifyLoadedReviewDocuments(
    subjectSha,
    subjectTree,
    required,
    policy,
    (path) => {
      const bytes = readFileSync(resolve(root, path));
      return {
        bytes,
        blobSha: git(root, ["hash-object", "--stdin"], "utf8", bytes).trim(),
      };
    },
  );
}

export function bindAuthenticatedApprovals(
  root,
  sha,
  approvalsDirectory,
  runId,
  runAttempt,
) {
  if (Number(runAttempt) !== 1) fail("REVIEW_ATTEMPT_UNSUPPORTED");
  const verified = verifyReviewDocuments(root, sha);
  const approvals = APPROVAL_FILES.map((name) =>
    parseStrictJson(readFileSync(resolve(approvalsDirectory, name), "utf8")),
  );
  const binding = {
    subjectSha: verified.subjectSha,
    subjectTree: verified.subjectTree,
    policySha256: verified.policySha256,
    runId: String(runId),
    runAttempt: Number(runAttempt),
  };
  const reviews = projectReviewSet(verified.documents, approvals, binding);
  return Object.freeze({
    ...verified,
    reviews,
    reviewSetSha256: sha256(canonicalize(reviews)),
  });
}

const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [rootArg, sha, approvalsDirectory, runId, runAttempt] =
    process.argv.slice(2);
  try {
    if (!rootArg || !sha) fail("USAGE_INVALID");
    const result = approvalsDirectory
      ? bindAuthenticatedApprovals(
          resolve(rootArg),
          sha,
          resolve(approvalsDirectory),
          runId,
          runAttempt,
        )
      : verifyReviewDocuments(resolve(rootArg), sha);
    process.stdout.write(canonicalize(result));
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "REVIEW_VERIFICATION_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
