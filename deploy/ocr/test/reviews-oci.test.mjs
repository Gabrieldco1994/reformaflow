import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalize, sha256 } from "../../../scripts/ci/ocr-attestation.mjs";
import {
  bindAuthenticatedApprovals,
  verifyReviewDocuments,
  verifyReviewWorktree,
} from "../verify-reviews.mjs";
import { extractApprovalEvidence } from "../github-approval-evidence.mjs";
import { inspectOciLayout } from "../oci-layout.mjs";
import {
  createArtifactDigest,
  verifyArtifactDigest,
} from "../artifact-digest.mjs";
const ROOT = resolve(import.meta.dirname, "../../..");
const roles = [
  "DATA_OWNER_RISK_ACCEPTANCE",
  "SECURITY",
  "PRIVACY",
  "DATA_OWNER_FINAL",
];
const envs = [
  "ocr-review-data-owner-risk",
  "ocr-review-security",
  "ocr-review-privacy",
  "ocr-review-data-owner-final",
];
const files = [
  "approval-data-owner-risk.json",
  "approval-security.json",
  "approval-privacy.json",
  "approval-data-owner-final.json",
];
function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}
function documentedApprovalHistoryEntry(index = 0) {
  return {
    environments: [
      {
        id: 161887 + index,
        node_id: `EN_${index}`,
        name: envs[index],
        url: `https://api.github.com/repos/o/r/environments/${envs[index]}`,
        html_url: `https://github.com/o/r/settings/environments/${envs[index]}/edit`,
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-02T00:00:00Z",
        can_admins_bypass: true,
        protection_rules: [],
      },
    ],
    state: "approved",
    user: {
      login: `reviewer-${index}`,
      id: 100 + index,
      node_id: `U_${index}`,
      avatar_url: "https://avatars.githubusercontent.com/u/100",
      gravatar_id: "",
      url: "https://api.github.com/users/reviewer",
      html_url: "https://github.com/reviewer",
      followers_url: "https://api.github.com/users/reviewer/followers",
      following_url:
        "https://api.github.com/users/reviewer/following{/other_user}",
      gists_url: "https://api.github.com/users/reviewer/gists{/gist_id}",
      starred_url:
        "https://api.github.com/users/reviewer/starred{/owner}{/repo}",
      subscriptions_url: "https://api.github.com/users/reviewer/subscriptions",
      organizations_url: "https://api.github.com/users/reviewer/orgs",
      repos_url: "https://api.github.com/users/reviewer/repos",
      events_url: "https://api.github.com/users/reviewer/events{/privacy}",
      received_events_url:
        "https://api.github.com/users/reviewer/received_events",
      type: "User",
      user_view_type: "public",
      site_admin: false,
    },
    comment: "Approved for qualification",
  };
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "ocr-review-"));
  await mkdir(join(root, "deploy/ocr/reviews"), { recursive: true });
  await writeFile(
    join(root, "deploy/ocr/infra-policy.json"),
    JSON.stringify({ policy: { sha256: "a".repeat(64) } }),
  );
  await writeFile(
    join(root, "deploy/ocr/required-reviews.json"),
    JSON.stringify({
      schemaVersion: 1,
      reviews: roles.map((role, index) => ({
        role,
        path: `deploy/ocr/reviews/${index}.json`,
      })),
    }),
  );
  for (let index = 0; index < 4; index++)
    await writeFile(
      join(root, `deploy/ocr/reviews/${index}.json`),
      JSON.stringify({
        schemaVersion: 1,
        role: roles[index],
        policySha256: "a".repeat(64),
        scope: "OCR_QUALIFICATION_V1",
      }),
    );
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  return root;
}
test("committed reviewer claims are rejected and external approvals bind four actors", async () => {
  const root = await repository();
  const sha = git(root, ["rev-parse", "HEAD"]);
  const docs = verifyReviewDocuments(root, sha);
  assert.equal(docs.documents.length, 4);
  const forged = {
    schemaVersion: 1,
    role: roles[0],
    policySha256: "a".repeat(64),
    scope: "OCR_QUALIFICATION_V1",
    reviewerId: "1",
    decision: "APPROVED",
  };
  await writeFile(
    join(root, "deploy/ocr/reviews/0.json"),
    JSON.stringify(forged),
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "forged"]);
  assert.throws(
    () => verifyReviewDocuments(root, git(root, ["rev-parse", "HEAD"])),
    /REVIEW_SET_INVALID/,
  );
  const approvals = await mkdtemp(join(tmpdir(), "approvals-"));
  for (let index = 0; index < 4; index++) {
    const history = [documentedApprovalHistoryEntry(index)];
    const observedAt = "2026-10-14T05:01:00.000Z";
    const evidence = extractApprovalEvidence(history, {
      role: roles[index],
      environment: envs[index],
      workflowRunId: "1001",
      subjectSha: sha,
      observedAt,
    });
    assert.equal(evidence.observedAt, observedAt);
    assert.equal(Object.hasOwn(evidence, "approvedAt"), false);
    await writeFile(join(approvals, files[index]), JSON.stringify(evidence));
  }
  const bound = bindAuthenticatedApprovals(root, sha, approvals, "1001", 1);
  assert.equal(new Set(bound.reviews.map((value) => value.reviewerId)).size, 4);
  assert.equal(bound.reviewSetSha256, sha256(canonicalize(bound.reviews)));
});
test("pending approval history is accepted structurally but only approved record satisfies the gate", () => {
  const approved = documentedApprovalHistoryEntry(0);
  const pending = {
    ...documentedApprovalHistoryEntry(0),
    state: "pending",
    comment: null,
  };
  const input = {
    role: roles[0],
    environment: envs[0],
    workflowRunId: "1001",
    subjectSha: "a".repeat(40),
    observedAt: "2026-10-14T05:01:00.000Z",
  };
  assert.equal(
    extractApprovalEvidence([pending, approved], input).state,
    "APPROVED",
  );
  assert.throws(
    () => extractApprovalEvidence([pending], input),
    /GITHUB_APPROVAL_INVALID/,
  );
});

test("run attempts after one and reused stable actor IDs fail before qualification", async () => {
  const root = await repository();
  const sha = git(root, ["rev-parse", "HEAD"]);
  const approvals = await mkdtemp(join(tmpdir(), "approvals-red-"));
  for (let index = 0; index < 4; index++) {
    const evidence = extractApprovalEvidence(
      [documentedApprovalHistoryEntry(index)],
      {
        role: roles[index],
        environment: envs[index],
        workflowRunId: "1001",
        subjectSha: sha,
        observedAt: "2026-10-14T05:01:00.000Z",
      },
    );
    await writeFile(join(approvals, files[index]), JSON.stringify(evidence));
  }
  assert.throws(
    () => bindAuthenticatedApprovals(root, sha, approvals, "1001", 2),
    /REVIEW_ATTEMPT_UNSUPPORTED/,
  );
  const duplicate = JSON.parse(
    await readFile(join(approvals, files[1]), "utf8"),
  );
  duplicate.reviewerId = "100";
  duplicate.reviewerLogin = "different-login";
  await writeFile(join(approvals, files[1]), JSON.stringify(duplicate));
  assert.throws(
    () => bindAuthenticatedApprovals(root, sha, approvals, "1001", 1),
    /REVIEW_ACTORS_NOT_DISTINCT/,
  );
});

test("artifact digest survives transfer and rejects absolute-path legacy manifests", async () => {
  const one = await mkdtemp(join(tmpdir(), "artifact-a-"));
  const two = await mkdtemp(join(tmpdir(), "artifact-b-"));
  await writeFile(join(one, "qualification.oci.tar"), "oci-bytes");
  const manifest = await createArtifactDigest(one, "qualification.oci.tar");
  await cp(
    join(one, "qualification.oci.tar"),
    join(two, "qualification.oci.tar"),
  );
  await verifyArtifactDigest(two, manifest);
  assert.equal(manifest.filename, "qualification.oci.tar");
  await assert.rejects(
    () =>
      verifyArtifactDigest(two, {
        ...manifest,
        filename: join(one, "qualification.oci.tar"),
      }),
    /ARTIFACT_DIGEST_INVALID/,
  );
});

test("real OCI fixture has one image manifest and config and rejects provenance descriptors", async () => {
  const fixture = join(ROOT, "deploy/ocr/test/fixtures/oci-single");
  const identity = await inspectOciLayout(fixture);
  assert.match(identity.imageDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(identity.configDigest, /^sha256:[0-9a-f]{64}$/);
  const mutated = await mkdtemp(join(tmpdir(), "oci-provenance-"));
  await cp(fixture, mutated, { recursive: true });
  const index = JSON.parse(await readFile(join(mutated, "index.json"), "utf8"));
  index.manifests.push({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: "application/vnd.in-toto+json",
    digest: identity.imageDigest,
    size: 1,
  });
  await writeFile(join(mutated, "index.json"), JSON.stringify(index));
  await assert.rejects(() => inspectOciLayout(mutated), /OCI_LAYOUT_INVALID/);
});

test("actual repository review descriptors pass the worktree verifier", () => {
  const verified = verifyReviewWorktree(ROOT);
  assert.deepEqual(
    verified.documents.map((document) => document.role),
    roles,
  );
  assert.deepEqual(
    verified.documents.map((document) => document.path),
    [
      "deploy/ocr/reviews/data-owner-risk-acceptance.json",
      "deploy/ocr/reviews/security.json",
      "deploy/ocr/reviews/privacy.json",
      "deploy/ocr/reviews/data-owner-final.json",
    ],
  );
});

test("documented GitHub approval shape excludes approval time and rejects fabricated top-level fields", () => {
  const entry = documentedApprovalHistoryEntry(0);
  const input = {
    role: roles[0],
    environment: envs[0],
    workflowRunId: "1001",
    subjectSha: "a".repeat(40),
    observedAt: "2026-10-14T05:01:00.000Z",
  };
  const evidence = extractApprovalEvidence([entry], input);
  assert.equal(evidence.observedAt, input.observedAt);
  assert.notEqual(evidence.observedAt, entry.environments[0].created_at);
  assert.throws(
    () =>
      extractApprovalEvidence(
        [{ ...entry, created_at: "2026-10-14T05:00:00Z" }],
        input,
      ),
    /GITHUB_APPROVAL_INVALID/,
  );
});
