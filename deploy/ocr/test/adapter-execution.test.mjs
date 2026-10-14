import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runWifCaptureAdapter } from "../wif-adapter.mjs";
import { runOfflineReportAdapter } from "../offline-report-adapter.mjs";
import { materializeSnapshotAuthority } from "../snapshot-authority-adapter.mjs";
import { canonicalize } from "../../../scripts/ci/ocr-attestation.mjs";

const TOKEN = "deterministic-wif-access-token";
const ROOT = resolve(import.meta.dirname, "../../..");
const execFileAsync = promisify(execFile);

async function ensureCompiledProduct() {
  try {
    await stat(
      resolve(
        ROOT,
        "apps/api/dist/imports/ocr-synth-v1/quality-closure-attestation.js",
      ),
    );
    await stat(
      resolve(ROOT, "apps/api/dist/imports/ocr-synth-v1/offline-report.js"),
    );
    await stat(
      resolve(ROOT, "apps/api/dist/imports/ocr-synth-v1/capture-live.js"),
    );
    return;
  } catch {
    await execFileAsync(
      "npm",
      ["--workspace", "@reformaflow/domain", "run", "build"],
      {
        cwd: ROOT,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    await execFileAsync(
      "npm",
      ["--workspace", "@reformaflow/api", "run", "build"],
      {
        cwd: ROOT,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  }
}

function spawnEntrypoint(entrypoint, command, environment, stdin = "") {
  return new Promise((resolveResult, reject) => {
    const child = execFile(
      process.execPath,
      [entrypoint, command],
      {
        cwd: ROOT,
        env: environment,
        maxBuffer: 128 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolveResult({
          code: error && typeof error.code === "number" ? error.code : 0,
          stdout,
          stderr,
        }),
    );
    child.once("error", reject);
    child.stdin.end(stdin);
  });
}

function reviewSet(binding) {
  const roles = [
    ["DATA_OWNER_RISK_ACCEPTANCE", "ocr-review-data-owner-risk"],
    ["SECURITY", "ocr-review-security"],
    ["PRIVACY", "ocr-review-privacy"],
    ["DATA_OWNER_FINAL", "ocr-review-data-owner-final"],
  ];
  return roles.map(([role, approvalEnvironment], index) => ({
    role,
    path: `deploy/ocr/reviews/review-${index}.json`,
    blobSha: String(index + 1).repeat(40),
    sha256: String(index + 1).repeat(64),
    policySha256: binding.policySha256,
    subjectSha: binding.subjectSha,
    subjectTree: binding.subjectTree,
    decision: "APPROVED",
    approvalSource: "GITHUB_PROTECTED_ENVIRONMENT",
    approvalEnvironment,
    reviewerId: String(9000 + index),
    reviewerLogin: `reviewer-${index}`,
    approvalRunId: binding.runId,
    qualificationRunAttempt: 1,
    approvalEvidenceObservedAt: "2026-10-14T20:00:00.000Z",
  }));
}

function processEnvironment(authority, parentEnvironment = process.env) {
  const infra = JSON.parse(
    readFileSync(resolve(ROOT, "deploy/ocr/infra-policy.json"), "utf8"),
  );
  const reviews = reviewSet({
    policySha256: authority.policySha256,
    subjectSha: authority.subjectSha,
    subjectTree: authority.subjectTree,
    runId: "1001",
  });
  const canonicalReviews = canonicalize(reviews);
  const reviewSetSha256 = createHash("sha256")
    .update(canonicalReviews)
    .digest("hex");
  const request = {
    schemaVersion: 1,
    subjectSha: authority.subjectSha,
    subjectTree: authority.subjectTree,
    productionImage: `registry.fly.io/reformaflow-api@sha256:${"9".repeat(64)}`,
    qualificationImageDigest: authority.qualificationImageDigest,
    executableDigest: authority.executableDigest,
    workflowSha: "c".repeat(40),
    policySha256: authority.policySha256,
    corpusSha256: authority.corpusSha256,
    reviewSetSha256,
    runId: "1001",
    runAttempt: 1,
    currency: "USD",
    hardLimitMicros: infra.pricing.maxTotalCostMicros,
    reservedMicros: infra.pricing.maxTotalCostMicros,
    provider: "GOOGLE_VERTEX_AI",
    requestedModelAlias: infra.provider.requestedModelAlias,
    region: "southamerica-east1",
    endpoint: "https://southamerica-east1-aiplatform.googleapis.com",
    promptSha256: infra.provider.promptSha256,
    inputMicrosPerMillionTokens: infra.pricing.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens: infra.pricing.outputMicrosPerMillionTokens,
    expectedCaseCount: infra.qualification.candidateCaseCount,
    admittedAt: "2026-10-14T20:05:00.000Z",
  };
  return {
    ...parentEnvironment,
    OCR_CAPTURE_AUTH_MODE: "GITHUB_OIDC_WIF",
    OCR_GCP_PROJECT_ID: "deterministic-project",
    OCR_SUBJECT_SHA: authority.subjectSha,
    OCR_SUBJECT_TREE: authority.subjectTree,
    OCR_PRODUCTION_IMAGE: request.productionImage,
    OCR_QUALIFICATION_IMAGE_DIGEST: authority.qualificationImageDigest,
    OCR_EXECUTABLE_DIGEST: authority.executableDigest,
    OCR_WORKFLOW_SHA: request.workflowSha,
    OCR_WORKFLOW_RUN_ID: request.runId,
    OCR_WORKFLOW_RUN_ATTEMPT: String(request.runAttempt),
    OCR_POLICY_SHA256: authority.policySha256,
    OCR_CORPUS_SHA256: authority.corpusSha256,
    OCR_MAX_TOTAL_COST_MICROS: String(request.hardLimitMicros),
    OCR_REQUESTED_MODEL_ALIAS: request.requestedModelAlias,
    OCR_PROMPT_SHA256: request.promptSha256,
    OCR_INPUT_MICROS_PER_MILLION_TOKENS: String(
      request.inputMicrosPerMillionTokens,
    ),
    OCR_OUTPUT_MICROS_PER_MILLION_TOKENS: String(
      request.outputMicrosPerMillionTokens,
    ),
    OCR_EXPECTED_CASE_COUNT: String(request.expectedCaseCount),
    OCR_REVIEW_SET_B64: Buffer.from(canonicalReviews).toString("base64"),
    OCR_SPEND_REQUEST_B64: Buffer.from(JSON.stringify(request)).toString(
      "base64",
    ),
    OCR_CAPTURE_AUTHORITY_B64: Buffer.from(JSON.stringify(authority)).toString(
      "base64",
    ),
  };
}

async function localProcessLayout(directory) {
  const source = await readFile(
    resolve(ROOT, "deploy/ocr/qualification-entrypoint.mjs"),
    "utf8",
  );
  const entrypoint = join(directory, "qualification-entrypoint.mjs");
  await writeFile(
    entrypoint,
    source.replace(
      'const ROOT = "/opt/qualification";',
      `const ROOT = ${JSON.stringify(ROOT)};`,
    ),
  );
  const preload = join(directory, "qualification-boundaries.cjs");
  const reservation = join(directory, "spend-reservation.json");
  await writeFile(
    preload,
    `"use strict";
const childProcess = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { registerHooks } = require("node:module");
const corpus = require(${JSON.stringify(
      resolve(ROOT, "apps/api/src/imports/ocr-synth-v1/ground-truth.json"),
    )});
const reservation = ${JSON.stringify(reservation)};
const originalOpen = fsp.open.bind(fsp);
const originalLstat = fsp.lstat.bind(fsp);
const originalReadFile = fsp.readFile.bind(fsp);
const originalUnlink = fsp.unlink.bind(fsp);
const originalExecFile = childProcess.execFile.bind(childProcess);
const remappedRuntimeFiles = new Map([
  ["/run/ocr/spend-reservation.json", reservation],
  ["/run/ocr/raw-evidence.json", ${JSON.stringify(
    join(directory, "raw-evidence.json"),
  )}],
  ["/run/ocr/live-capture.lock", ${JSON.stringify(
    join(directory, "live-capture.lock"),
  )}],
]);
const remap = (value) => remappedRuntimeFiles.get(String(value)) || value;
fsp.open = (path, ...args) => originalOpen(remap(path), ...args);
fsp.lstat = (path, ...args) => originalLstat(remap(path), ...args);
fsp.unlink = (path, ...args) => originalUnlink(remap(path), ...args);
fsp.readFile = (path, ...args) =>
  String(path) === "/proc/self/status"
    ? Promise.resolve("Name:\\tnode\\nVmHWM:\\t102400 kB\\n")
    : originalReadFile(path, ...args);
childProcess.execFile = (file, args, options, callback) => {
  if (!String(args?.[0]).endsWith("/jest/bin/jest.js"))
    return originalExecFile(file, args, options, callback);
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  return originalExecFile(
    file,
    args,
    { ...options, env: environment },
    callback,
  );
};
globalThis.__qualificationFsPromises = fsp;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "node:fs/promises" &&
      String(context.parentURL).endsWith("/scripts/ci/ocr-attestation.mjs")
    )
      return { shortCircuit: true, url: "qualification:fs-promises" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "qualification:fs-promises")
      return {
        shortCircuit: true,
        format: "module",
        source:
          "const fsp = globalThis.__qualificationFsPromises;" +
          "export const open = (...args) => fsp.open(...args);" +
          "export const lstat = (...args) => fsp.lstat(...args);" +
          "export const readFile = (...args) => fsp.readFile(...args);",
      };
    return nextLoad(url, context);
  },
});
const hostPlatform = process.platform;
Object.defineProperty(process, "platform", {
  configurable: true,
  get() {
    return String(new Error().stack).includes("/capture-live-core.")
      ? "linux"
      : hostPlatform;
  },
});
const scanned = corpus.cases.filter((item) => item.partition === "SCANNED_PDF");
let generationIndex = 0;
const response = (value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        if (name === "content-type") return "application/json";
        if (name === "content-length") return String(bytes.length);
        return null;
      },
    },
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
};
global.fetch = async (url, options = {}) => {
  const requestBody = JSON.parse(String(options.body));
  if (String(url).endsWith(":countTokens")) {
    const transferredPdfs = requestBody.contents.flatMap((content) =>
      content.parts.filter((part) => part.inlineData),
    );
    if (transferredPdfs.length !== 0)
      throw new Error("COUNT_TOKENS_PDF_TRANSMISSION");
    return response({ totalTokens: 100 });
  }
  const testCase = scanned[generationIndex++];
  if (!testCase) throw new Error("UNEXPECTED_GENERATION_CALL");
  const transferredPdfs = requestBody.contents.flatMap((content) =>
    content.parts.filter((part) => part.inlineData),
  );
  if (
    transferredPdfs.length !== 1 ||
    transferredPdfs[0].inlineData.mimeType !== "application/pdf" ||
    !Buffer.from(transferredPdfs[0].inlineData.data, "base64")
      .subarray(0, 5)
      .equals(Buffer.from("%PDF-"))
  )
    throw new Error("ORIGINAL_PDF_TRANSMISSION_INVALID");
  const pageCounts = new Map();
  const rows =
    testCase.expected.kind === "SUCCESS"
      ? testCase.expected.regions.flatMap((region) => region.rows)
      : [];
  const candidates = rows.map((row) => {
    const pageOccurrenceIndex = (pageCounts.get(row.page) || 0) + 1;
    pageCounts.set(row.page, pageOccurrenceIndex);
    return {
      pageNumber: row.page,
      pageOccurrenceIndex,
      description: row.description,
      amountCents: row.amountCents,
      sign: row.sign,
      amountMeaning: row.amountMeaning,
      dateText: row.dateText,
      normalizedDate:
        row.dateExplicitness === "FULL" ? row.normalizedDate : null,
      dateExplicitness: row.dateExplicitness,
      installment:
        row.installmentCurrent !== null && row.installmentTotal !== null
          ? { index: row.installmentCurrent, total: row.installmentTotal }
          : null,
      evidenceText: row.evidenceText,
    };
  });
  let payload;
  if (testCase.expected.kind === "ERROR") {
    const overflow = testCase.expected.errorCode === "LIMIT_EXCEEDED";
    payload = {
      completionStatus: overflow ? "OCCURRENCE_LIMIT_EXCEEDED" : "INCOMPLETE",
      reportedPageCount: testCase.artifact.pageCount,
      pageAccounting: Array.from(
        { length: testCase.artifact.pageCount },
        (_, pageIndex) => ({
          pageNumber: pageIndex + 1,
          status: overflow && pageIndex === 0
            ? "READABLE"
            : !overflow && pageIndex === 1
              ? "UNREADABLE"
              : "EMPTY",
          visibleOccurrenceCount: overflow && pageIndex === 0 ? 25 : 0,
        }),
      ),
      candidates: [],
    };
  } else {
    payload = {
      completionStatus: "COMPLETE",
      reportedPageCount: testCase.artifact.pageCount,
      pageAccounting: Array.from(
        { length: testCase.artifact.pageCount },
        (_, pageIndex) => {
          const visibleOccurrenceCount = pageCounts.get(pageIndex + 1) || 0;
          return {
            pageNumber: pageIndex + 1,
            status: visibleOccurrenceCount === 0 ? "EMPTY" : "READABLE",
            visibleOccurrenceCount,
          };
        },
      ),
      candidates,
    };
  }
  return response({
    responseId: "response-" + testCase.id,
    modelVersion: "gemini-2.5-flash-001",
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ text: JSON.stringify(payload) }] },
    }],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      totalTokenCount: 120,
    },
  });
};
`,
  );
  return { entrypoint, preload };
}

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

test(
  "qualification entrypoint dispatches real default snapshot, capture, and offline report adapters",
  { timeout: 300_000 },
  async () => {
    await ensureCompiledProduct();
    const directory = await mkdtemp(join(tmpdir(), "ocr-entrypoint-process-"));
    try {
      const { entrypoint, preload } = await localProcessLayout(directory);
      const subjectSha = "a".repeat(40);
      const subjectTree = "b".repeat(40);
      const qualificationImageDigest = `sha256:${"c".repeat(64)}`;
      const executableDigest = `sha256:${"d".repeat(64)}`;
      const baseEnvironment = {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`]
          .filter(Boolean)
          .join(" "),
      };
      const snapshotResult = await spawnEntrypoint(
        entrypoint,
        "snapshot-authority",
        {
          ...baseEnvironment,
          OCR_SUBJECT_SHA: subjectSha,
          OCR_SUBJECT_TREE: subjectTree,
          OCR_QUALIFICATION_IMAGE_DIGEST: qualificationImageDigest,
          OCR_EXECUTABLE_DIGEST: executableDigest,
        },
      );
      assert.deepEqual(
        {
          code: snapshotResult.code,
          stderr: snapshotResult.stderr,
        },
        { code: 0, stderr: "" },
      );
      const authority = JSON.parse(snapshotResult.stdout);
      assert.equal(authority.subjectSha, subjectSha);
      assert.equal(authority.subjectTree, subjectTree);
      assert.equal(
        authority.qualificationImageDigest,
        qualificationImageDigest,
      );
      assert.equal(authority.executableDigest, executableDigest);

      const captureResult = await spawnEntrypoint(
        entrypoint,
        "capture",
        processEnvironment(authority, baseEnvironment),
        TOKEN,
      );
      assert.deepEqual(
        {
          code: captureResult.code,
          stderr: captureResult.stderr,
        },
        { code: 0, stderr: "" },
      );
      const evidence = JSON.parse(captureResult.stdout);
      assert.equal(evidence.predictions.length, 18);
      assert.equal(evidence.attemptLedger.length, 18);
      assert.equal(evidence.qualityClosure.tests.length, 45);

      const offlineResult = await spawnEntrypoint(
        entrypoint,
        "offline-report",
        baseEnvironment,
        captureResult.stdout,
      );
      assert.deepEqual(
        {
          code: offlineResult.code,
          stderr: offlineResult.stderr,
        },
        { code: 0, stderr: "" },
      );
      const report = JSON.parse(offlineResult.stdout);
      assert.equal(report.reportSchemaVersion, 4);
      assert.equal(report.historicalComparison, "NOT_PERFORMED_P1_DEFERRED");
      assert.deepEqual(report.liveEvidenceGaps, []);
      assert.equal(report.releaseStatus, "PASS");

      for (const [mutate, expectedGap] of [
        [
          (value) => {
            value.run.declaredLimits.maxP95LatencyMs += 1;
          },
          "DECLARED_LIMIT_POLICY_MISMATCH",
        ],
        [
          (value) => {
            value.run.pricing.effectiveDate = "2026-10-13";
          },
          "PRICING_POLICY_MISMATCH",
        ],
        [
          (value) => {
            value.run.durableBudgets.globalLimitMicros += 1;
          },
          "DURABLE_BUDGET_POLICY_MISMATCH",
        ],
      ]) {
        const mutatedEvidence = structuredClone(evidence);
        mutate(mutatedEvidence);
        const mismatchResult = await spawnEntrypoint(
          entrypoint,
          "offline-report",
          baseEnvironment,
          JSON.stringify(mutatedEvidence),
        );
        assert.deepEqual(
          {
            code: mismatchResult.code,
            stderr: mismatchResult.stderr,
          },
          { code: 0, stderr: "" },
        );
        const mismatchReport = JSON.parse(mismatchResult.stdout);
        assert.deepEqual(mismatchReport.liveEvidenceGaps, [expectedGap]);
        assert.equal(mismatchReport.releaseStatus, "GAPS");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
