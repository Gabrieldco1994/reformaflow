import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OCR_SYNTH_DATASET } from "./corpus";
import {
  DIRECT_PDF_VERTEX_CONFIG,
  OCR_SYNTH_THRESHOLDS,
  buildOraclePredictions,
  buildOracleRoutingCases,
  buildOracleSafetyProbes,
  evaluateOcrSynth,
  type OcrEvalInput,
} from "./evaluator";
import { writeLiveEvidenceExclusive } from "./capture-live-file";
import { captureLiveEvidence } from "./capture-live-core";
import {
  CAPTURE_TEST_SHA,
  buildCaptureManifest,
  buildCaptureProvider,
} from "./quality-closure-capture.test-support";
import {
  parseJson,
  parseLiveEvidence,
  parseLiveEvidenceJson,
} from "./live-evidence-parser";
import policy from "./quality-closure-policy.json";
import { QUALIFICATION_TEST_NAMES } from "./quality-closure-test-contract";

jest.setTimeout(120_000);

const ROOT = resolve(__dirname, "../../../../..");
const POLICY_PATH =
  "apps/api/src/imports/ocr-synth-v1/quality-closure-policy.json";
const CORPUS_PATH = "apps/api/src/imports/ocr-synth-v1/ground-truth.json";
const QUALIFIER_PATH = resolve(__dirname, "qualify-live.ts");
const QUALIFIER_CONFIG = resolve(
  __dirname,
  "quality-closure.qualify.jest.config.cjs",
);
const QUALIFIER_SPEC = resolve(__dirname, "quality-closure.qualify.spec.ts");
const SERVICE_TEST =
  "apps/api/src/imports/import-session/ocr/pdf-ocr-analyze.integration.spec.ts";
const SAFETY_TEST =
  "apps/api/src/imports/ocr-synth-v1/direct-pdf-vertex-safety.spec.ts";
const CONTEXT_PROBES = new Set([
  "EXACT_CONSENT_CAPABILITY",
  "PRIOR_CONSENT_DECLARATION",
  "MISSING_CONSENT",
  "MISSING_ATTESTATION",
  "SELECTED_TRUE_DEFAULT",
  "VERIFIED_DEFAULT",
]);
const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const fileSha256 = async (path: string) =>
  sha256(await readFile(resolve(ROOT, path)));

type EvidenceWithClosure = OcrEvalInput & {
  qualityClosure: {
    gitSha: string;
    policySha256: string;
    corpusSha256: string;
    runtimeSha256: string;
    initialCandidateSha: string;
    rerunCandidateSha: string;
    tests: Array<{ name: string; status: "PASS" }>;
  };
};

async function runtimeSha256(): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [...policy.runtimeBindingFiles].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(resolve(ROOT, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function evidence(): Promise<EvidenceWithClosure> {
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const predictions = await buildOraclePredictions(true);
  for (const prediction of predictions) {
    prediction.modelVersion = "quality-binding-fixture";
    prediction.latencyMs = 1;
    prediction.peakRssBytes = 1;
    prediction.cost.amountMicros = 3;
    prediction.adapterTrace!.deadlineMs = 1;
    prediction.adapterTrace!.requestBodyBytes = 1;
  }
  const routingCases = await buildOracleRoutingCases();
  for (const route of routingCases) {
    route.source = "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED";
    route.testFile = SERVICE_TEST;
  }
  const safetyProbes = buildOracleSafetyProbes();
  for (const probe of safetyProbes) {
    probe.source = "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED";
    probe.testFile = CONTEXT_PROBES.has(probe.id) ? SERVICE_TEST : SAFETY_TEST;
  }
  const input: OcrEvalInput = {
    datasetVersion: OCR_SYNTH_DATASET.datasetVersion,
    run: {
      mode: "LIVE_CAPTURE",
      candidateSha,
      configurationSha256: "a".repeat(64),
      adapterSha256: "b".repeat(64),
      provider: DIRECT_PDF_VERTEX_CONFIG.provider,
      model: DIRECT_PDF_VERTEX_CONFIG.model,
      modelVersion: "quality-binding-fixture",
      region: DIRECT_PDF_VERTEX_CONFIG.region,
      endpoint: DIRECT_PDF_VERTEX_CONFIG.endpoint,
      promptSha256: "a".repeat(64),
      baseline: {
        sha: OCR_SYNTH_DATASET.baseSha,
        behavior: "OCR_REQUIRED",
        sampleCount: 18,
      },
      declaredLimits: {
        maxP95LatencyMs: policy.maxP95LatencyMs,
        maxTotalCostMicros: policy.maxTotalCostMicros,
        maxRequestBodyBytes: policy.maxRequestBodyBytes,
        maxProviderDeadlineMs: policy.maxProviderDeadlineMs,
      },
      durableBudgets: {
        policySha256: await fileSha256(POLICY_PATH),
        tenantLimitMicros: policy.maxTotalCostMicros,
        globalLimitMicros: policy.maxTotalCostMicros,
        storage: "DATABASE",
      },
      residualRiskAcceptance: {
        decision: "OPTION_1_COMPLETE_ORIGINAL_PDF",
        dataOwnerAcceptanceSha256: "e".repeat(64),
        noLocalDerivative: true,
      },
      finalReviews: {
        securityReviewSha256: "1".repeat(64),
        privacyReviewSha256: "2".repeat(64),
        dataOwnerReviewSha256: "3".repeat(64),
      },
      pricing: {
        source: policy.pricing.source,
        effectiveDate: policy.pricing.observedOn,
        inputMicrosPerMillionTokens: policy.pricing.inputMicrosPerMillionTokens,
        outputMicrosPerMillionTokens:
          policy.pricing.outputMicrosPerMillionTokens,
      },
    },
    predictions,
    routingCases,
    safetyProbes,
  };
  return {
    ...input,
    qualityClosure: {
      gitSha: candidateSha,
      policySha256: await fileSha256(POLICY_PATH),
      corpusSha256: await fileSha256(CORPUS_PATH),
      runtimeSha256: await runtimeSha256(),
      initialCandidateSha: candidateSha,
      rerunCandidateSha: candidateSha,
      tests: QUALIFICATION_TEST_NAMES.map((name) => ({
        name,
        status: "PASS" as const,
      })),
    },
  };
}

function closureFreeDirectEvidence(value: EvidenceWithClosure): OcrEvalInput {
  const direct = structuredClone(value) as unknown as Record<string, unknown>;
  delete direct.qualityClosure;
  for (const prediction of direct.predictions as Array<
    Record<string, unknown>
  >) {
    const outcome = prediction.outcome as
      | {
          kind: "SUCCESS";
          regions: Array<{
            rows: Array<{
              page: number;
              description: string;
              amountCents: string | null;
              sign: "NEGATIVE" | "ZERO" | "POSITIVE" | "UNKNOWN";
              amountMeaning: "LINE_AMOUNT" | "UNKNOWN";
              normalizedDate: string | null;
              installmentCurrent: number | null;
              installmentTotal: number | null;
              evidenceText: string;
            }>;
          }>;
        }
      | { kind: "ERROR"; errorCode: string; retryable: boolean };
    if (outcome.kind === "SUCCESS")
      prediction.outcome = {
        kind: "SUCCESS",
        candidates: outcome.regions.flatMap((region) =>
          region.rows.map((row) => ({
            pageNumber: row.page,
            description: row.description,
            amountCents: row.amountCents,
            sign: row.sign,
            amountMeaning: row.amountMeaning,
            date:
              row.normalizedDate &&
              /^\d{4}-\d{2}-\d{2}$/.test(row.normalizedDate)
                ? row.normalizedDate
                : null,
            installment:
              row.installmentCurrent !== null && row.installmentTotal !== null
                ? {
                    index: row.installmentCurrent,
                    total: row.installmentTotal,
                  }
                : null,
            evidenceText: row.evidenceText,
          })),
        ),
      };
    prediction.capturePath = "DIRECT_PROVIDER_CAPTURE";
    prediction.consentRecorded = false;
    prediction.consentCapability = null;
    prediction.attestationRequired = null;
  }
  return direct as unknown as OcrEvalInput;
}

function qualifierArgs(evidencePath: string): string[] {
  return [
    "-r",
    resolve(ROOT, "node_modules/ts-node/register"),
    "-e",
    "require(process.argv[1])",
    QUALIFIER_PATH,
    evidencePath,
  ];
}

function qualifierEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TS_NODE_PROJECT: resolve(ROOT, "apps/api/tsconfig.json"),
  };
}

describe("quality-closure mechanical binding RED", () => {
  let valid: EvidenceWithClosure;

  beforeAll(async () => {
    valid = await evidence();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("starts from evidence that passes the pre-closure evaluator controls", async () => {
    const report = await evaluateOcrSynth(valid);
    expect(report.releaseStatus).toBe("PASS");
    expect(report.liveEvidenceGaps).toEqual([]);
  });

  it("strictly rejects duplicate keys even when qualityClosure is absent", () => {
    const closureFree = structuredClone(valid) as unknown as Record<
      string,
      unknown
    >;
    delete closureFree.qualityClosure;
    const raw = JSON.stringify(closureFree).replace(
      `"datasetVersion":"${valid.datasetVersion}"`,
      `"datasetVersion":"shadowed","datasetVersion":"${valid.datasetVersion}"`,
    );
    expect(() => parseJson(raw)).toThrow("LIVE_EVIDENCE_INVALID");
  });

  it("requires qualityClosure for every LIVE_CAPTURE document", () => {
    const closureFree = closureFreeDirectEvidence(valid);
    expect(() => parseLiveEvidence(closureFree)).toThrow(
      "LIVE_EVIDENCE_INVALID",
    );
  });

  it("does not let a caller-fabricated PASS list qualify without an opaque verified rerun", async () => {
    const parsed = parseLiveEvidence(valid);
    const report = await evaluateOcrSynth(parsed);
    expect(report.releaseStatus).toBe("GAPS");
  });

  it("binds policy values to runtime by exact equality rather than permissive maxima", async () => {
    expect(policy).toStrictEqual({
      policyVersion: "ocr-quality-closure-v1",
      maxOutputTokens: 8192,
      maxP95LatencyMs: 30_000,
      maxProviderDeadlineMs: 60_000,
      maxRequestBodyBytes: 20_000_000,
      maxTotalCostMicros: 500_000,
      maxVmHwmBytes: 536_870_912,
      pricing: {
        currency: "USD",
        source: "https://cloud.google.com/vertex-ai/generative-ai/pricing",
        observedOn: "2026-10-14",
        recheckThroughUtc: "2026-10-21",
        inputMicrosPerMillionTokens: 300_000,
        outputMicrosPerMillionTokens: 2_500_000,
      },
      runtimeBindingFiles: [
        "apps/api/src/imports/import-session/ocr/pdf-ocr-parser.ts",
        "apps/api/src/imports/import-session/ocr/vertex-pdf-ocr.provider.ts",
        "apps/api/src/imports/import-session/import-session.extraction.service.ts",
        "apps/api/src/imports/ocr-synth-v1/capture-live-core.ts",
        "apps/api/src/imports/ocr-synth-v1/evaluator.ts",
        "apps/api/src/imports/ocr-synth-v1/live-evidence-parser.ts",
      ],
    });
    expect(DIRECT_PDF_VERTEX_CONFIG.maxOutputTokens).toBe(
      policy.maxOutputTokens,
    );
    expect(OCR_SYNTH_THRESHOLDS.maxPeakRssBytes).toBe(policy.maxVmHwmBytes);

    const mutations: Array<(input: EvidenceWithClosure) => void> = [
      (input) => {
        const limits = input.run.declaredLimits!;
        input.run.declaredLimits = {
          ...limits,
          maxP95LatencyMs: policy.maxP95LatencyMs + 1,
        };
      },
      (input) => {
        const limits = input.run.declaredLimits!;
        input.run.declaredLimits = {
          ...limits,
          maxProviderDeadlineMs: policy.maxProviderDeadlineMs + 1,
        };
      },
      (input) => {
        const limits = input.run.declaredLimits!;
        input.run.declaredLimits = {
          ...limits,
          maxRequestBodyBytes: policy.maxRequestBodyBytes + 1,
        };
      },
      (input) => {
        const limits = input.run.declaredLimits!;
        input.run.declaredLimits = {
          ...limits,
          maxTotalCostMicros: policy.maxTotalCostMicros + 1,
        };
      },
      (input) => {
        input.run.pricing = {
          ...input.run.pricing!,
          source: "https://example.invalid/pricing",
        };
      },
      (input) => {
        input.run.pricing = {
          ...input.run.pricing!,
          effectiveDate: "2026-10-15",
        };
      },
      (input) => {
        input.run.pricing = {
          ...input.run.pricing!,
          inputMicrosPerMillionTokens:
            input.run.pricing!.inputMicrosPerMillionTokens + 1,
        };
      },
      (input) => {
        input.run.pricing = {
          ...input.run.pricing!,
          outputMicrosPerMillionTokens:
            input.run.pricing!.outputMicrosPerMillionTokens + 1,
        };
      },
    ];
    const statuses = [];
    for (const mutate of mutations) {
      const changed = structuredClone(valid);
      mutate(changed);
      statuses.push((await evaluateOcrSynth(changed)).releaseStatus);
    }
    expect(statuses).toEqual(
      Array.from({ length: mutations.length }, () => "GAPS"),
    );
  });

  it("treats 2026-10-21 as inclusive and rejects stale pricing on 2026-10-22 UTC", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-21T23:59:59.999Z"));
    expect(parseLiveEvidence(valid)).toBeDefined();
    jest.setSystemTime(new Date("2026-10-22T00:00:00.000Z"));
    expect(() => parseLiveEvidence(valid)).toThrow("LIVE_EVIDENCE_INVALID");
  });

  it("serializes captures globally even when output paths differ", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ocr-global-lock-"));
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let secondStartedSignal!: () => void;
    let secondStarted = false;
    const started = new Promise<void>((resolveStarted) => {
      firstStarted = resolveStarted;
    });
    const gate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const secondEntered = new Promise<void>((resolveStarted) => {
      secondStartedSignal = resolveStarted;
    });
    const first = writeLiveEvidenceExclusive(
      join(directory, "first.json"),
      async () => {
        firstStarted();
        await gate;
        return valid;
      },
    );
    await started;
    const second = writeLiveEvidenceExclusive(
      join(directory, "second.json"),
      async () => {
        secondStarted = true;
        secondStartedSignal();
        return valid;
      },
    );
    await Promise.race([
      secondEntered,
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 100)),
    ]);
    const overlapped = secondStarted;
    releaseFirst();
    await Promise.all([first, second]);
    await rm(directory, { recursive: true, force: true });
    expect(overlapped).toBe(false);
  });

  it("rejects an output path inside the repository before invoking capture", async () => {
    const output = resolve(ROOT, ".quality-closure-inside-worktree.json");
    const capture = jest.fn(async () => valid);
    try {
      await expect(writeLiveEvidenceExclusive(output, capture)).rejects.toThrow(
        "LIVE_CAPTURE_OUTPUT_INVALID",
      );
      expect(capture).not.toHaveBeenCalled();
    } finally {
      await unlink(output).catch(() => undefined);
    }
  });

  it.each([
    ["first", 2, 1],
    ["eighteenth", 19, 18],
  ] as const)(
    "stops without retry or publication when repository drift follows the %s provider call",
    async (_label, driftCheckpoint, expectedCalls) => {
      const directory = await mkdtemp(join(tmpdir(), "ocr-capture-drift-"));
      const output = join(directory, "evidence.json");
      const adapter = buildCaptureProvider();
      const manifest = await buildCaptureManifest();
      let checkpoint = 0;
      const verifyRepositorySnapshot = jest.fn(async () => {
        checkpoint++;
        if (checkpoint === driftCheckpoint)
          throw new Error("LIVE_CAPTURE_REPOSITORY_DRIFT");
      });
      await expect(
        writeLiveEvidenceExclusive(output, () =>
          captureLiveEvidence({
            provider: adapter.provider,
            manifest,
            currentRepoSha: CAPTURE_TEST_SHA,
            readProcSelfStatus: async () => "Name:\tnode\nVmHWM:\t1024 kB\n",
            verifyRepositorySnapshot,
          } as Parameters<typeof captureLiveEvidence>[0]),
        ),
      ).rejects.toThrow("LIVE_CAPTURE_REPOSITORY_DRIFT");
      expect(adapter.fetcher).toHaveBeenCalledTimes(expectedCalls);
      await expect(stat(output)).rejects.toBeDefined();
      await rm(directory, { recursive: true, force: true });
    },
  );

  it("runs exactly the canonical 10 ROUTE and 35 PROBE tests from one fixed source", () => {
    const jestBin = require.resolve("jest/bin/jest");
    const stdout = execFileSync(
      process.execPath,
      [jestBin, "--config", QUALIFIER_CONFIG, "--runInBand", "--json"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout) as {
      success: boolean;
      numPassedTests: number;
      numFailedTests: number;
      numPendingTests: number;
      numTodoTests: number;
      testResults: Array<{
        name: string;
        status: string;
        message: string;
        assertionResults: Array<{
          fullName: string;
          status: string;
          failureMessages: string[];
        }>;
      }>;
    };
    expect(result).toMatchObject({
      success: true,
      numPassedTests: 45,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
    });
    expect(result.testResults).toHaveLength(1);
    expect(resolve(result.testResults[0]!.name)).toBe(QUALIFIER_SPEC);
    expect(result.testResults[0]).toMatchObject({
      status: "passed",
      message: "",
    });
    expect(
      result.testResults[0]!.assertionResults.map((item) => item.fullName),
    ).toEqual(QUALIFICATION_TEST_NAMES);
    expect(
      result.testResults[0]!.assertionResults.map((item) => ({
        status: item.status,
        failureMessages: item.failureMessages,
      })),
    ).toEqual(
      Array.from({ length: 45 }, () => ({
        status: "passed",
        failureMessages: [],
      })),
    );
  });

  it("qualifier refuses symlink evidence instead of following it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ocr-qualify-link-"));
    const target = join(directory, "target.json");
    const link = join(directory, "evidence.json");
    await writeFile(target, JSON.stringify(valid));
    await symlink(target, link);
    const result = spawnSync(process.execPath, qualifierArgs(link), {
      cwd: ROOT,
      encoding: "utf8",
      env: qualifierEnv(),
    });
    await rm(directory, { recursive: true, force: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("LIVE_EVIDENCE_INVALID");
  });

  it("opens evidence no-follow, verifies one bounded regular file, and reads that descriptor once", async () => {
    const evidencePath = resolve(ROOT, "secure-evidence.json");
    const descriptorRead = jest.fn(async () => "{}");
    const descriptorClose = jest.fn(async () => undefined);
    const isRegularFile = jest.fn(() => true);
    const descriptorStat = jest.fn(async () => ({
      isFile: isRegularFile,
      size: 1_048_576,
    }));
    const secureOpen = jest.fn(async () => ({
      readFile: descriptorRead,
      close: descriptorClose,
      stat: descriptorStat,
    }));
    const pathRead = jest.fn(async () => {
      throw new Error("PATH_READ_FORBIDDEN");
    });
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    process.argv = ["node", "qualify-live.ts", evidencePath];
    process.exitCode = undefined;
    jest.resetModules();
    jest.doMock("node:fs/promises", () => ({
      open: secureOpen,
      readFile: pathRead,
    }));
    jest.doMock("./live-evidence-parser", () => ({
      parseLiveEvidenceJson: jest.fn(() => ({ marker: "parsed" })),
    }));
    jest.doMock("./evaluator", () => ({
      evaluateOcrSynth: jest.fn(async () => ({ releaseStatus: "PASS" })),
      assertReleaseQualified: jest.fn(),
    }));
    const stdoutSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const stderrSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      jest.isolateModules(() => {
        require("./qualify-live");
      });
      for (let tick = 0; tick < 5; tick++)
        await new Promise((resolveTick) => setImmediate(resolveTick));
      expect(secureOpen).toHaveBeenCalledTimes(1);
      expect(secureOpen).toHaveBeenCalledWith(
        evidencePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      expect(descriptorStat).toHaveBeenCalledTimes(1);
      expect(isRegularFile).toHaveBeenCalledTimes(1);
      expect(descriptorRead).toHaveBeenCalledTimes(1);
      expect(descriptorRead).toHaveBeenCalledWith("utf8");
      expect(descriptorClose).toHaveBeenCalledTimes(1);
      expect(pathRead).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      jest.dontMock("node:fs/promises");
      jest.dontMock("./live-evidence-parser");
      jest.dontMock("./evaluator");
    }
  });

  it("asserts a GAPS report before writing any stdout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ocr-qualify-gaps-"));
    const evidencePath = join(directory, "evidence.json");
    const changed = structuredClone(valid);
    const outcome = changed.predictions[0]!.outcome;
    if (outcome.kind !== "SUCCESS" || !("regions" in outcome))
      throw new Error("TEST_FIXTURE_INVALID");
    outcome.regions[0]!.rows[0]!.amountCents = "999";
    await writeFile(evidencePath, JSON.stringify(changed));
    const result = spawnSync(process.execPath, qualifierArgs(evidencePath), {
      cwd: ROOT,
      encoding: "utf8",
      env: qualifierEnv(),
    });
    await rm(directory, { recursive: true, force: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("orders the release assertion before the first stdout write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ocr-qualify-order-"));
    const evidencePath = join(directory, "evidence.json");
    await writeFile(evidencePath, "{}");
    const events: string[] = [];
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    process.argv = ["node", "qualify-live.ts", evidencePath];
    process.exitCode = undefined;
    let assertionReached!: () => void;
    const asserted = new Promise<void>((resolveAssertion) => {
      assertionReached = resolveAssertion;
    });
    jest.resetModules();
    jest.unmock("node:fs/promises");
    jest.doMock("./live-evidence-parser", () => ({
      parseLiveEvidenceJson: jest.fn(() => ({ marker: "parsed" })),
    }));
    jest.doMock("./evaluator", () => ({
      evaluateOcrSynth: jest.fn(async () => ({ releaseStatus: "GAPS" })),
      assertReleaseQualified: jest.fn(() => {
        events.push("assert");
        assertionReached();
        throw new Error("NOT_QUALIFIED");
      }),
    }));
    const stdoutSpy = jest
      .spyOn(console, "log")
      .mockImplementation((..._args: unknown[]) => {
        events.push("stdout");
      });
    const stderrSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      jest.isolateModules(() => {
        require("./qualify-live");
      });
      await Promise.race([
        asserted,
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
      ]);
      expect(events).toEqual(["assert"]);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      jest.dontMock("./live-evidence-parser");
      jest.dontMock("./evaluator");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects oversized evidence before parsing or emitting stdout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ocr-qualify-size-"));
    const evidencePath = join(directory, "evidence.json");
    const serialized = JSON.stringify(valid);
    await writeFile(
      evidencePath,
      `${serialized}${" ".repeat(1_048_577 - Buffer.byteLength(serialized))}`,
    );
    const result = spawnSync(process.execPath, qualifierArgs(evidencePath), {
      cwd: ROOT,
      encoding: "utf8",
      env: qualifierEnv(),
    });
    await rm(directory, { recursive: true, force: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("LIVE_EVIDENCE_INVALID");
  });

  it("rejects a different clean repository HEAD before stdout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ocr-qualify-head-"));
    const evidencePath = join(directory, "evidence.json");
    await writeFile(join(directory, "tracked.txt"), "fixture\n");
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "qa@example.invalid"], {
      cwd: directory,
    });
    execFileSync("git", ["config", "user.name", "QA Fixture"], {
      cwd: directory,
    });
    execFileSync("git", ["add", "tracked.txt"], { cwd: directory });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: directory });
    await writeFile(evidencePath, JSON.stringify(valid));
    const result = spawnSync(process.execPath, qualifierArgs(evidencePath), {
      cwd: directory,
      encoding: "utf8",
      env: qualifierEnv(),
    });
    await rm(directory, { recursive: true, force: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("LIVE_CAPTURE_REPOSITORY_DRIFT");
  });
});
