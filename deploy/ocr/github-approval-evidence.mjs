#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  parseStrictJson,
} from "../../scripts/ci/ocr-attestation.mjs";

const ROLES = new Set([
  "DATA_OWNER_RISK_ACCEPTANCE",
  "SECURITY",
  "PRIVACY",
  "DATA_OWNER_FINAL",
]);
const ENVIRONMENTS = new Map([
  ["DATA_OWNER_RISK_ACCEPTANCE", "ocr-review-data-owner-risk"],
  ["SECURITY", "ocr-review-security"],
  ["PRIVACY", "ocr-review-privacy"],
  ["DATA_OWNER_FINAL", "ocr-review-data-owner-final"],
]);
const ID = /^[1-9][0-9]*$/;
const SHA = /^[0-9a-f]{40}$/;
function fail(code) {
  throw new Error(code);
}
function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    fail("GITHUB_APPROVAL_INVALID");
}
function timestamp(value) {
  if (
    typeof value !== "string" ||
    Number.isNaN(new Date(value).valueOf()) ||
    new Date(value).toISOString() !== value
  )
    fail("GITHUB_APPROVAL_INVALID");
  return value;
}

export function extractApprovalEvidence(history, input) {
  exact(input, [
    "role",
    "environment",
    "workflowRunId",
    "subjectSha",
    "observedAt",
  ]);
  if (
    !Array.isArray(history) ||
    !ROLES.has(input.role) ||
    ENVIRONMENTS.get(input.role) !== input.environment ||
    !ID.test(String(input.workflowRunId)) ||
    !SHA.test(input.subjectSha)
  )
    fail("GITHUB_APPROVAL_INVALID");
  timestamp(input.observedAt);
  for (const entry of history) {
    exact(entry, ["environments", "state", "user", "comment"]);
    if (
      !Array.isArray(entry.environments) ||
      !["approved", "rejected", "pending"].includes(entry.state) ||
      (entry.comment !== null && typeof entry.comment !== "string") ||
      !entry.user ||
      typeof entry.user !== "object" ||
      Array.isArray(entry.user)
    )
      fail("GITHUB_APPROVAL_INVALID");
    for (const environment of entry.environments)
      if (
        !environment ||
        typeof environment !== "object" ||
        Array.isArray(environment) ||
        typeof environment.name !== "string"
      )
        fail("GITHUB_APPROVAL_INVALID");
  }
  const matches = history.filter(
    (entry) =>
      entry.state === "approved" &&
      entry.environments.some(
        (environment) => environment.name === input.environment,
      ),
  );
  if (matches.length !== 1) fail("GITHUB_APPROVAL_INVALID");
  const id = String(matches[0].user.id ?? "");
  const login = matches[0].user.login;
  if (
    !ID.test(id) ||
    typeof login !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)
  )
    fail("GITHUB_APPROVAL_INVALID");
  return {
    schemaVersion: 1,
    source: "GITHUB_PROTECTED_ENVIRONMENT",
    role: input.role,
    environment: input.environment,
    state: "APPROVED",
    reviewerId: id,
    reviewerLogin: login,
    observedAt: input.observedAt,
    workflowRunId: String(input.workflowRunId),
    subjectSha: input.subjectSha,
  };
}

const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [
    historyPath,
    role,
    environment,
    workflowRunId,
    subjectSha,
    observedAt,
  ] = process.argv.slice(2);
  try {
    if (!historyPath) fail("USAGE_INVALID");
    const history = parseStrictJson(await readFile(historyPath, "utf8"));
    process.stdout.write(
      canonicalize(
        extractApprovalEvidence(history, {
          role,
          environment,
          workflowRunId,
          subjectSha,
          observedAt,
        }),
      ),
    );
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "GITHUB_APPROVAL_INVALID";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
