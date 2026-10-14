import assert from "node:assert/strict";
import test from "node:test";

import { runWifCaptureAdapter } from "../wif-adapter.mjs";
import { runOfflineReportAdapter } from "../offline-report-adapter.mjs";
import { materializeSnapshotAuthority } from "../snapshot-authority-adapter.mjs";

const TOKEN = "deterministic-wif-access-token";

test("WIF adapter emits captured evidence instead of an unavailable stub", async () => {
  const evidence = Object.freeze({
    datasetVersion: "ocr-synth-v1-direct-pdf-vertex-v3",
    historicalComparison: "NOT_PERFORMED_P1_DEFERRED",
  });
  let output = "";
  const result = await runWifCaptureAdapter(
    {
      OCR_CAPTURE_AUTH_MODE: "GITHUB_OIDC_WIF",
      OCR_GCP_PROJECT_ID: "pilot-project",
    },
    {
      authenticateRequest: async () =>
        Object.freeze({
          request: { request: true },
          authority: { snapshot: { headSha: "a".repeat(40) } },
          finalReviewHashes: {
            residualRiskAcceptance: "1".repeat(64),
            securityReview: "2".repeat(64),
            privacyReview: "3".repeat(64),
            dataOwnerReview: "4".repeat(64),
          },
        }),
      reserve: async () => ({
        handle: { close: async () => undefined },
      }),
      assertReservation: async () => undefined,
      readToken: async () => TOKEN,
      capture: async (input) => {
        assert.equal(input.authMode, "GITHUB_OIDC_WIF");
        assert.equal(input.projectId, "pilot-project");
        assert.equal(input.accessToken, TOKEN);
        assert.equal(input.snapshot.headSha, "a".repeat(40));
        assert.equal(input.finalReviewHashes.securityReview, "2".repeat(64));
        return evidence;
      },
      write: (value) => {
        output += value;
      },
    },
  );

  assert.equal(result, evidence);
  assert.deepEqual(JSON.parse(output), evidence);
});

test("offline adapter parses evidence and emits the application-owned V4 report", async () => {
  const raw = '{"candidate":"deterministic"}';
  const report = Object.freeze({
    reportSchemaVersion: 4,
    historicalComparison: "NOT_PERFORMED_P1_DEFERRED",
    releaseStatus: "PASS",
  });
  let output = "";
  const result = await runOfflineReportAdapter(raw, {
    evaluate: async (value) => {
      assert.equal(value, raw);
      return report;
    },
    write: (value) => {
      output += value;
    },
  });

  assert.equal(result, report);
  assert.deepEqual(JSON.parse(output), report);
});

test("WIF adapter remains fail closed without protected auth configuration", async () => {
  await assert.rejects(
    () =>
      runWifCaptureAdapter(
        {
          OCR_CAPTURE_AUTH_MODE: "GITHUB_OIDC_WIF",
        },
        {
          authenticateRequest: async () => Object.freeze({ request: true }),
          reserve: async () => ({
            handle: { close: async () => undefined },
          }),
          assertReservation: async () => undefined,
          readToken: async () => TOKEN,
          capture: async () => {
            throw new Error("MUST_NOT_CAPTURE");
          },
          write: () => undefined,
        },
      ),
    /OCR_CAPTURE_WIF_CONFIG_INVALID/,
  );
});

test("snapshot authority binds workflow identity to image and executable without Git", async () => {
  const snapshot = Object.freeze({
    headSha: "a".repeat(40),
    treeSha: "b".repeat(40),
    policySha256: "c".repeat(64),
    corpusSha256: "d".repeat(64),
  });
  let receivedIdentity;
  const authority = await materializeSnapshotAuthority(
    {
      OCR_SUBJECT_SHA: snapshot.headSha,
      OCR_SUBJECT_TREE: snapshot.treeSha,
      OCR_QUALIFICATION_IMAGE_DIGEST: `sha256:${"e".repeat(64)}`,
      OCR_EXECUTABLE_DIGEST: `sha256:${"f".repeat(64)}`,
    },
    {
      load: async () => ({
        loadQualityClosurePolicy: async () => ({ version: "test-policy" }),
        snapshotQualityFiles: async (_policy, identity) => {
          receivedIdentity = identity;
          return snapshot;
        },
      }),
    },
  );

  assert.deepEqual(receivedIdentity, {
    headSha: snapshot.headSha,
    treeSha: snapshot.treeSha,
  });
  assert.equal(authority.policySha256, snapshot.policySha256);
  assert.equal(authority.corpusSha256, snapshot.corpusSha256);
  assert.equal(authority.qualificationImageDigest, `sha256:${"e".repeat(64)}`);
  assert.equal(authority.executableDigest, `sha256:${"f".repeat(64)}`);
});

test("snapshot authority rejects malformed transferred identity before loading product code", async () => {
  let loaded = false;
  await assert.rejects(
    () =>
      materializeSnapshotAuthority(
        {
          OCR_SUBJECT_SHA: "not-a-sha",
          OCR_SUBJECT_TREE: "b".repeat(40),
          OCR_QUALIFICATION_IMAGE_DIGEST: `sha256:${"e".repeat(64)}`,
          OCR_EXECUTABLE_DIGEST: `sha256:${"f".repeat(64)}`,
        },
        {
          load: async () => {
            loaded = true;
            return {};
          },
        },
      ),
    /SNAPSHOT_AUTHORITY_INVALID/,
  );
  assert.equal(loaded, false);
});
