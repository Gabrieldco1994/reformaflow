import assert from "node:assert/strict";
import test from "node:test";

import { runWifCaptureAdapter } from "../wif-adapter.mjs";
import { runOfflineReportAdapter } from "../offline-report-adapter.mjs";

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
      authenticateRequest: async () => Object.freeze({ request: true }),
      reserve: async () => ({
        handle: { close: async () => undefined },
      }),
      assertReservation: async () => undefined,
      readToken: async () => TOKEN,
      capture: async (input) => {
        assert.equal(input.authMode, "GITHUB_OIDC_WIF");
        assert.equal(input.projectId, "pilot-project");
        assert.equal(input.accessToken, TOKEN);
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
