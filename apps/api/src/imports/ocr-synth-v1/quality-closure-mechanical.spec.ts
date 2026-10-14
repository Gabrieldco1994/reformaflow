import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

jest.setTimeout(120_000);

const execFile = promisify(execFileCallback);
const ROOT = resolve(__dirname, "../../../../..");
const POLICY_PATH =
  "apps/api/src/imports/ocr-synth-v1/quality-closure-policy.json";
const CORPUS_PATH = "apps/api/src/imports/ocr-synth-v1/ground-truth.json";
const SERVICE_SUITE =
  "apps/api/src/imports/import-session/ocr/pdf-ocr-analyze.integration.spec.ts";
const PROVIDER_SUITE =
  "apps/api/src/imports/import-session/ocr/vertex-pdf-ocr.provider.spec.ts";
const CAPTURE_SUITE = "apps/api/src/imports/ocr-synth-v1/capture-live.spec.ts";
const GENERIC_SAFETY_SUITE =
  "apps/api/src/imports/ocr-synth-v1/direct-pdf-vertex-safety.spec.ts";
const ROUTE_TITLES = [
  "[ROUTE] mixed-001",
  "[ROUTE] mixed-002",
  "[ROUTE] mixed-003",
  "[ROUTE] mixed-004",
  "[ROUTE] mixed-005",
  "[ROUTE] mixed-006",
  "[ROUTE] mixed-007",
  "[ROUTE] mixed-008",
  "[ROUTE] mixed-009",
  "[ROUTE] mixed-010",
] as const;
const SERVICE_PROBE_TITLES = [
  "[PROBE] EXACT_CONSENT_CAPABILITY",
  "[PROBE] SELECTED_TRUE_DEFAULT",
  "[PROBE] VERIFIED_DEFAULT",
  "[PROBE] MISSING_CONSENT",
  "[PROBE] MISSING_ATTESTATION",
  "[PROBE] PRIOR_CONSENT_DECLARATION",
] as const;
const PROVIDER_PROBE_TITLES = [
  "[PROBE] WRONG_ENDPOINT",
  "[PROBE] WRONG_MODEL",
  "[PROBE] WRONG_REGION",
  "[PROBE] API_KEY_AUTH",
  "[PROBE] ADC_SCOPE_BOUNDED",
  "[PROBE] REQUEST_BODY_BOUNDED",
  "[PROBE] DEADLINE_BOUNDED",
  "[PROBE] GLOBAL_ENDPOINT_FALLBACK",
  "[PROBE] TOOLS_PRESENT",
  "[PROBE] FILE_URI_PRESENT",
  "[PROBE] CACHE_PRESENT",
  "[PROBE] PARTIAL_RESPONSE",
  "[PROBE] MALFORMED_RESPONSE",
  "[PROBE] TRUNCATED_RESPONSE",
  "[PROBE] SAFETY_BLOCKED_RESPONSE",
  "[PROBE] KNOWN_SAFETY_FINISH_REASONS",
] as const;
const SERVICE_CONTEXT_PROBE_TITLES = [
  "[PROBE] TEXTUAL_PDF_PROVIDER_CALL",
  "[PROBE] LOCAL_RASTER_SANDBOX",
  "[PROBE] PAGE_11_ADMISSION",
  "[PROBE] MIXED_LOCAL_PROVIDER_DUPLICATION",
  "[PROBE] AMBIGUOUS_TIMEOUT_RETRY",
  "[PROBE] UNKNOWN_OUTCOME_NO_RETRY",
  "[PROBE] DURABLE_TENANT_BUDGET",
  "[PROBE] DURABLE_GLOBAL_BUDGET",
  "[PROBE] ACTIVE_SESSION_CONTENT_PURGE_AFTER_7_DAYS",
  "[PROBE] FINANCIAL_WRITE",
  "[PROBE] TERMINAL_FAILURE_REPLAY_NO_CALL",
  "[PROBE] CAPABILITY_OFF",
] as const;
const MECHANICAL_PROBE_TITLES = ["[PROBE] RESIDUAL_RISK_ACCEPTANCE"] as const;
const CAUSAL_SUITE_FILES = [
  SERVICE_SUITE,
  PROVIDER_SUITE,
  CAPTURE_SUITE,
] as const;
const EXPECTED_TOPOLOGY = [
  ...ROUTE_TITLES.map((name) => ({ name, sourcePath: SERVICE_SUITE })),
  ...PROVIDER_PROBE_TITLES.slice(0, 11).map((name) => ({
    name,
    sourcePath: PROVIDER_SUITE,
  })),
  ...SERVICE_CONTEXT_PROBE_TITLES.slice(0, 4).map((name) => ({
    name,
    sourcePath: SERVICE_SUITE,
  })),
  ...PROVIDER_PROBE_TITLES.slice(11, 15).map((name) => ({
    name,
    sourcePath: PROVIDER_SUITE,
  })),
  ...SERVICE_CONTEXT_PROBE_TITLES.slice(4, 9).map((name) => ({
    name,
    sourcePath: SERVICE_SUITE,
  })),
  ...SERVICE_PROBE_TITLES.slice(0, 5).map((name) => ({
    name,
    sourcePath: SERVICE_SUITE,
  })),
  {
    name: SERVICE_CONTEXT_PROBE_TITLES[9],
    sourcePath: SERVICE_SUITE,
  },
  {
    name: PROVIDER_PROBE_TITLES[15],
    sourcePath: PROVIDER_SUITE,
  },
  ...SERVICE_CONTEXT_PROBE_TITLES.slice(10).map((name) => ({
    name,
    sourcePath: SERVICE_SUITE,
  })),
  {
    name: SERVICE_PROBE_TITLES[5],
    sourcePath: SERVICE_SUITE,
  },
  ...MECHANICAL_PROBE_TITLES.map((name) => ({
    name,
    sourcePath: CAPTURE_SUITE,
  })),
] as const;
const RATE_THRESHOLD_NAMES = [
  "scannedTaskSuccessRate",
  "exactMoneyRate",
  "exactSignRate",
  "exactDateRate",
  "exactDateExplicitnessRate",
  "exactInstallmentRate",
  "unknownPreservationRate",
  "visibleEvidenceRate",
  "schemaValidityRate",
] as const;
const DEFECT_THRESHOLD_NAMES = [
  "inventedRows",
  "omittedRows",
  "tenantLeaks",
  "falseAutomations",
  "financialWrites",
] as const;

interface Policy {
  policyVersion: string;
  validThroughUtc: string;
  thresholds: Record<string, number>;
  qualificationSuiteFiles: string[];
  qualificationTests: Array<{ name: string; sourcePath: string }>;
  [key: string]: unknown;
}

interface ExecResult {
  error: Error | null;
  stdout: string;
  stderr: string;
}

interface MachineJestResult {
  success: boolean;
  numFailedTestSuites: number;
  numFailedTests: number;
  numRuntimeErrorTestSuites: number;
  numPendingTests: number;
  numTodoTests: number;
  testResults: Array<{
    name: string;
    status: string;
    message: string;
    assertionResults: Array<{
      title: string;
      fullName: string;
      status: string;
      failureMessages: string[];
    }>;
  }>;
}

interface MechanicalApi {
  QUALITY_POLICY_PATH: string;
  QUALITY_CORPUS_PATH: string;
  loadQualityClosurePolicy(options?: {
    root?: string;
    now?: Date;
    exec?: Exec;
  }): Promise<Policy>;
  snapshotQualityRepository(
    policy: Policy,
    options: { root: string; exec: Exec },
  ): Promise<Record<string, unknown>>;
  runQualityClosureSuite(
    policy: Policy,
    options: { root: string; exec?: Exec },
  ): Promise<
    Array<{
      name: string;
      title: string;
      fullName: string;
      status: "PASS";
      sourcePath: string;
      assertionRecordSha256: string;
      suiteResultSha256: string;
    }>
  >;
  assertOutputOutsideRepository(
    outputPath: string,
    options: { root: string; exec: Exec },
  ): Promise<void>;
  attestQualityClosure(options: {
    root: string;
    now: Date;
    exec: Exec;
  }): Promise<{
    policy: Policy;
    closure: {
      version: 2;
      policyVersion: string;
      snapshot: Record<string, unknown>;
      tests: Array<{ name: string; status: "PASS"; sourcePath: string }>;
    };
  }>;
  readFinalReviewHashes(
    policy: Policy,
    options: { root: string; exec: Exec },
  ): Promise<{
    residualRiskAcceptance: string | null;
    securityReview: string | null;
    privacyReview: string | null;
    dataOwnerReview: string | null;
  }>;
  issueVerifiedQualityClosureToken(
    evidence: unknown,
    rerun: unknown,
    policy: Policy,
    options: {
      root: string;
      exec: Exec;
      verifier?: {
        verify(input: {
          keyId: string;
          candidateSha: string;
          evidenceSha256: string;
          signature: string;
        }): boolean;
      };
    },
  ): Promise<unknown>;
  canonicalJson(value: unknown): string;
  isCanonicalQualityClosure(
    value: unknown,
    dependencies?: {
      verifier?: {
        verify(input: {
          keyId: string;
          candidateSha: string;
          evidenceSha256: string;
          signature: string;
        }): boolean;
      };
    },
  ): boolean;
  isStructurallyValidQualityClosureEnvelope(value: unknown): boolean;
  isVerifiedQualityClosureToken(
    token: unknown,
    evidence: unknown,
    dependencies?: {
      verifier?: {
        verify(input: {
          keyId: string;
          candidateSha: string;
          evidenceSha256: string;
          signature: string;
        }): boolean;
      };
    },
  ): Promise<boolean>;
}

type Exec = (
  file: string,
  args: readonly string[],
  options: { cwd: string; maxBuffer: number; timeout: number },
) => Promise<ExecResult>;

const api = (): MechanicalApi =>
  require("./quality-closure-attestation") as MechanicalApi;

function gitExec(root: string): Exec {
  return async (_file, args) => {
    if (args[0] === "ls-files")
      return {
        error: null,
        stdout: `${args.at(-1)}\n`,
        stderr: "",
      };
    if (args.join(" ") === "status --porcelain=v1 -z --untracked-files=all")
      return { error: null, stdout: "", stderr: "" };
    if (args.join(" ") === "rev-parse --show-toplevel")
      return { error: null, stdout: `${root}\n`, stderr: "" };
    if (args.join(" ") === "rev-parse HEAD")
      return { error: null, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    if (args.join(" ") === "rev-parse HEAD^{tree}")
      return { error: null, stdout: `${"b".repeat(40)}\n`, stderr: "" };
    if (args.join(" ") === "rev-parse --git-dir")
      return { error: null, stdout: ".git\n", stderr: "" };
    if (args.join(" ") === "rev-parse --git-common-dir")
      return { error: null, stdout: ".git\n", stderr: "" };
    return {
      error: new Error(`unexpected command: ${args.join(" ")}`),
      stdout: "",
      stderr: "",
    };
  };
}

function framedHash(path: string, bytes: Buffer): string {
  return createHash("sha256")
    .update(path)
    .update("\0")
    .update(bytes)
    .update("\0")
    .digest("hex");
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function expectedHashedObservations(result: MachineJestResult) {
  return EXPECTED_TOPOLOGY.map((expected) => {
    const suite = result.testResults.find(
      (item) => resolve(item.name) === resolve(ROOT, expected.sourcePath),
    )!;
    const assertion = suite.assertionResults.find(
      (item) => item.title === expected.name,
    )!;
    const suiteResultSha256 = canonicalHash({
      sourcePath: expected.sourcePath,
      status: suite.status,
      message: suite.message,
      assertionResults: suite.assertionResults.map((item) => ({
        title: item.title,
        fullName: item.fullName,
        status: item.status,
        failureMessages: item.failureMessages,
      })),
    });
    return {
      name: expected.name,
      title: assertion.title,
      fullName: assertion.fullName,
      status: "PASS",
      sourcePath: expected.sourcePath,
      assertionRecordSha256: canonicalHash({
        title: assertion.title,
        fullName: assertion.fullName,
        status: assertion.status,
        failureMessages: assertion.failureMessages,
        sourcePath: expected.sourcePath,
      }),
      suiteResultSha256,
    };
  });
}

async function writePolicy(root: string, value: unknown): Promise<void> {
  const path = resolve(root, POLICY_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

function canonicalJestResult(): MachineJestResult {
  return {
    success: true,
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numRuntimeErrorTestSuites: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: CAUSAL_SUITE_FILES.map((sourcePath) => ({
      name: resolve(ROOT, sourcePath),
      status: "passed",
      message: "",
      assertionResults: EXPECTED_TOPOLOGY.filter(
        (item) => item.sourcePath === sourcePath,
      ).map((item) => ({
        title: item.name,
        fullName: item.name,
        status: "passed",
        failureMessages: [],
      })),
    })),
  };
}

function causalPolicy(policy: Policy): Policy {
  return {
    ...policy,
    qualificationSuiteFiles: [...CAUSAL_SUITE_FILES],
    qualificationTests: EXPECTED_TOPOLOGY.map(({ name, sourcePath }) => ({
      name,
      sourcePath,
    })),
  };
}

function unsignedAuthorityFixture(candidateSha = "a".repeat(40)) {
  return {
    version: 2,
    policyVersion: "ocr-quality-closure-v2",
    snapshot: {
      headSha: candidateSha,
      treeSha: candidateSha,
      clean: true,
      policySha256: "1".repeat(64),
      corpusSha256: "2".repeat(64),
      configurationSha256: "3".repeat(64),
      adapterSha256: "4".repeat(64),
      runtimeSha256: "5".repeat(64),
      suiteSha256: "6".repeat(64),
    },
    tests: EXPECTED_TOPOLOGY.map((item, index) => ({
      name: item.name,
      status: "PASS",
      sourcePath: item.sourcePath,
      title: item.name,
      fullName: `qualification ${item.name}`,
      assertionRecordSha256: index.toString(16).padStart(64, "0"),
      suiteResultSha256: (index + 100).toString(16).padStart(64, "0"),
    })),
  };
}

function legacyUnsignedAuthorityFixture(candidateSha = "a".repeat(40)) {
  const closure = unsignedAuthorityFixture(candidateSha);
  return {
    ...closure,
    tests: closure.tests.map(({ name, status, sourcePath }) => ({
      name,
      status,
      sourcePath,
    })),
  };
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(api().canonicalJson(value)).digest("hex");
}

function signedLegacyAuthorityFixture(candidateSha = "a".repeat(40)) {
  const unsigned = legacyUnsignedAuthorityFixture(candidateSha);
  return {
    ...unsigned,
    authority: {
      keyId: "qa-key-719",
      candidateSha,
      evidenceSha256: canonicalDigest(unsigned),
      signature: "qa-signature-719",
    },
  };
}

function jestExec(result: unknown): Exec {
  return async (_file, args) => {
    const outputIndex = args.indexOf("--outputFile");
    if (outputIndex < 0) throw new Error("missing Jest output path");
    const outputPath = args[outputIndex + 1]!;
    await writeFile(outputPath, JSON.stringify(result));
    return { error: null, stdout: "", stderr: "" };
  };
}

function actualCausalJestExec(): Exec {
  const expectedBySuite = new Map<string, Set<string>>(
    CAUSAL_SUITE_FILES.map((sourcePath) => [
      resolve(ROOT, sourcePath),
      new Set(
        EXPECTED_TOPOLOGY.filter((item) => item.sourcePath === sourcePath).map(
          (item) => item.name,
        ),
      ),
    ]),
  );
  const escapedNames = EXPECTED_TOPOLOGY.map(({ name }) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = `(?:${escapedNames.join("|")})$`;

  return async (file, args, options) => {
    const outputIndex = args.indexOf("--outputFile");
    if (outputIndex < 0) throw new Error("missing Jest output path");
    const outputPath = args[outputIndex + 1]!;
    let stdout = "";
    let stderr = "";
    try {
      const result = await execFile(
        file,
        [...args, "--testMatch", "**/*.spec.ts", "--testNamePattern", pattern],
        {
          cwd: options.cwd,
          maxBuffer: options.maxBuffer,
          timeout: options.timeout,
          encoding: "utf8",
        },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      return {
        error: failure,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }

    const machine = JSON.parse(await readFile(outputPath, "utf8")) as {
      success: boolean;
      numFailedTestSuites: number;
      numFailedTests: number;
      numPassedTests: number;
      numPendingTests: number;
      numRuntimeErrorTestSuites: number;
      numTodoTests: number;
      numTotalTests: number;
      testResults: Array<{
        name: string;
        status: string;
        message: string;
        assertionResults: Array<{
          title: string;
          fullName: string;
          status: string;
          failureMessages: string[];
        }>;
      }>;
    };
    const filteredResults = machine.testResults.map((suite) => {
      const expected = expectedBySuite.get(resolve(suite.name));
      if (!expected) throw new Error(`unexpected causal suite: ${suite.name}`);
      const assertions = suite.assertionResults.filter(({ title }) =>
        expected.has(title),
      );
      if (
        assertions.length !== expected.size ||
        assertions.some(
          ({ title, status, failureMessages }) =>
            status !== "passed" ||
            failureMessages.length !== 0 ||
            !expected.has(title),
        )
      )
        throw new Error(`causal assertions did not pass: ${suite.name}`);
      return {
        ...suite,
        status: "passed",
        message: "",
        assertionResults: assertions,
      };
    });
    const assertionCount = filteredResults.reduce(
      (total, suite) => total + suite.assertionResults.length,
      0,
    );
    if (
      filteredResults.length !== CAUSAL_SUITE_FILES.length ||
      assertionCount !== EXPECTED_TOPOLOGY.length
    )
      throw new Error(
        `causal Jest result is incomplete: suites=${filteredResults.length}, assertions=${assertionCount}`,
      );
    await writeFile(
      outputPath,
      JSON.stringify({
        ...machine,
        success: true,
        numFailedTestSuites: 0,
        numFailedTests: 0,
        numPassedTests: EXPECTED_TOPOLOGY.length,
        numPendingTests: 0,
        numRuntimeErrorTestSuites: 0,
        numTodoTests: 0,
        numTotalTests: EXPECTED_TOPOLOGY.length,
        testResults: filteredResults,
      }),
    );
    return { error: null, stdout, stderr };
  };
}

function attestationExec(root: string): Exec {
  const git = gitExec(root);
  const jest = jestExec(canonicalJestResult());
  return async (file, args, options) =>
    file === process.execPath
      ? jest(file, args, options)
      : git(file, args, options);
}

type RateThresholdName = (typeof RATE_THRESHOLD_NAMES)[number];
type DefectThresholdName = (typeof DEFECT_THRESHOLD_NAMES)[number];
type Thresholds = Record<RateThresholdName | DefectThresholdName, number>;

interface EvalPrediction {
  artifactSha256: string;
  tenantId: string;
  schemaValid: boolean;
  financialWrites: number;
  outcome:
    | { kind: "ERROR" }
    | {
        kind: "SUCCESS";
        regions: Array<{
          rows: Array<Record<string, any>>;
        }>;
      };
}

interface ThresholdEvaluator {
  buildOraclePredictions(liveFields?: boolean): Promise<EvalPrediction[]>;
  buildOracleRoutingCases(): Promise<unknown[]>;
  buildOracleSafetyProbes(): unknown[];
  evaluateOcrSynth(input: unknown): Promise<{
    functionalStatus: "PASS" | "FAIL";
    thresholds: Thresholds;
    metrics: Thresholds & Record<string, number | null>;
  }>;
}

const offlineRun = {
  mode: "OFFLINE_ORACLE",
  candidateSha: null,
  configurationSha256: null,
  adapterSha256: null,
  provider: null,
  model: null,
  modelVersion: null,
  region: null,
  endpoint: null,
  promptSha256: null,
  baseline: {
    sha: "08d19d11638a55e14ce73a6bf472894174c66389",
    behavior: "OCR_REQUIRED",
    sampleCount: 18,
  },
  declaredLimits: {
    maxP95LatencyMs: null,
    maxTotalCostMicros: null,
    maxRequestBodyBytes: null,
    maxProviderDeadlineMs: null,
  },
  durableBudgets: null,
  residualRiskAcceptance: null,
  finalReviews: null,
  pricing: null,
} as const;
const liveRun = {
  ...offlineRun,
  mode: "LIVE_CAPTURE",
  candidateSha: "b".repeat(40),
  configurationSha256: "c".repeat(64),
  adapterSha256: "d".repeat(64),
  provider: "GOOGLE_VERTEX_AI",
  model: "gemini-2.5-flash",
  modelVersion: "evaluator-fixture-version",
  region: "southamerica-east1",
  endpoint: "https://southamerica-east1-aiplatform.googleapis.com",
  promptSha256: "a".repeat(64),
  declaredLimits: {
    maxP95LatencyMs: 100,
    maxTotalCostMicros: 1_000,
    maxRequestBodyBytes: 20_000_000,
    maxProviderDeadlineMs: 30_000,
  },
  durableBudgets: {
    policySha256: "e".repeat(64),
    tenantLimitMicros: 10_000,
    globalLimitMicros: 100_000,
    storage: "DATABASE",
  },
  residualRiskAcceptance: {
    decision: "OPTION_1_COMPLETE_ORIGINAL_PDF",
    dataOwnerAcceptanceSha256: "f".repeat(64),
    noLocalDerivative: true,
  },
  finalReviews: {
    securityReviewSha256: "1".repeat(64),
    privacyReviewSha256: "2".repeat(64),
    dataOwnerReviewSha256: "3".repeat(64),
  },
  pricing: {
    source: "evaluator-self-test-only",
    effectiveDate: "2026-10-13",
    inputMicrosPerMillionTokens: 1_000_000,
    outputMicrosPerMillionTokens: 1_000_000,
  },
} as const;

function thresholdSet(
  rate: number,
  defect: number,
  override: Partial<Thresholds> = {},
): Thresholds {
  return {
    scannedTaskSuccessRate: rate,
    exactMoneyRate: rate,
    exactSignRate: rate,
    exactDateRate: rate,
    exactDateExplicitnessRate: rate,
    exactInstallmentRate: rate,
    unknownPreservationRate: rate,
    visibleEvidenceRate: rate,
    schemaValidityRate: rate,
    inventedRows: defect,
    omittedRows: defect,
    tenantLeaks: defect,
    falseAutomations: defect,
    financialWrites: defect,
    ...override,
  };
}

async function withThresholdEvaluator<T>(
  thresholds: Thresholds,
  action: (evaluator: ThresholdEvaluator) => Promise<T>,
): Promise<T> {
  jest.resetModules();
  const policy = JSON.parse(
    await readFile(resolve(ROOT, POLICY_PATH), "utf8"),
  ) as Record<string, unknown>;
  jest.doMock("./quality-closure-policy.json", () => ({
    ...policy,
    thresholds,
  }));
  let evaluator!: ThresholdEvaluator;
  jest.isolateModules(() => {
    evaluator = require("./evaluator") as ThresholdEvaluator;
  });
  try {
    return await action(evaluator);
  } finally {
    jest.dontMock("./quality-closure-policy.json");
    jest.resetModules();
  }
}

async function evaluateThresholdMutation(
  evaluator: ThresholdEvaluator,
  mutate: (predictions: EvalPrediction[]) => void,
  live = false,
) {
  const predictions = await evaluator.buildOraclePredictions(live);
  mutate(predictions);
  return evaluator.evaluateOcrSynth({
    datasetVersion: "ocr-synth-v1-direct-pdf-vertex-v3",
    run: live ? liveRun : offlineRun,
    predictions,
    routingCases: await evaluator.buildOracleRoutingCases(),
    safetyProbes: evaluator.buildOracleSafetyProbes(),
  });
}

function successfulRows(predictions: EvalPrediction[]) {
  return predictions.flatMap((prediction) =>
    prediction.outcome.kind === "SUCCESS"
      ? prediction.outcome.regions.flatMap((region) => region.rows)
      : [],
  );
}

describe("canonical quality closure mechanical binding", () => {
  it("pins the exact 10 ROUTE + 35 PROBE topology independently of runtime arrays", async () => {
    expect(ROUTE_TITLES).toHaveLength(10);
    expect(SERVICE_PROBE_TITLES).toHaveLength(6);
    expect(PROVIDER_PROBE_TITLES).toHaveLength(16);
    expect(SERVICE_CONTEXT_PROBE_TITLES).toHaveLength(12);
    expect(MECHANICAL_PROBE_TITLES).toHaveLength(1);
    expect(EXPECTED_TOPOLOGY).toHaveLength(45);
    expect(new Set(EXPECTED_TOPOLOGY.map((item) => item.name)).size).toBe(45);
    const policy = await api().loadQualityClosurePolicy({
      root: ROOT,
      now: new Date("2026-10-21T23:59:59.999Z"),
    });
    expect(policy.qualificationSuiteFiles).toEqual(CAUSAL_SUITE_FILES);
    expect(policy.qualificationTests).toEqual(EXPECTED_TOPOLOGY);
    await expect(
      api().loadQualityClosurePolicy({
        root: ROOT,
        now: new Date("2026-10-22T00:00:00.000Z"),
      }),
    ).rejects.toThrow("QUALITY_POLICY_EXPIRED");
  });

  it("admits authority only when every one of the 45 identities names one causal production-boundary assertion", async () => {
    const loaded = await api().loadQualityClosurePolicy({
      root: ROOT,
      now: new Date("2026-10-14T12:00:00.000Z"),
    });
    const sourceText = await Promise.all(
      CAUSAL_SUITE_FILES.map(async (sourcePath) => ({
        sourcePath,
        text: await readFile(resolve(ROOT, sourcePath), "utf8"),
      })),
    );
    const violations = [
      ...loaded.qualificationTests
        .filter((item) => item.sourcePath === GENERIC_SAFETY_SUITE)
        .map((item) => `${item.name}:GENERIC_SOURCE`),
      ...sourceText
        .filter(({ text }) => /\bbuildOracle[A-Za-z0-9_]*\b/.test(text))
        .map(({ sourcePath }) => `${sourcePath}:ORACLE_IMPORT`),
    ];

    expect(loaded.qualificationTests).toHaveLength(45);
    expect(
      loaded.qualificationTests.filter((item) =>
        item.name.startsWith("[ROUTE] "),
      ),
    ).toHaveLength(10);
    expect(
      loaded.qualificationTests.filter((item) =>
        item.name.startsWith("[PROBE] "),
      ),
    ).toHaveLength(35);
    expect(
      new Set(loaded.qualificationTests.map((item) => item.name)).size,
    ).toBe(45);
    expect(loaded.qualificationSuiteFiles).toEqual(CAUSAL_SUITE_FILES);
    expect(loaded.qualificationTests).toEqual(EXPECTED_TOPOLOGY);
    expect(
      loaded.qualificationTests.find(
        (item) => item.name === "[PROBE] FINANCIAL_WRITE",
      ),
    ).toEqual({
      name: "[PROBE] FINANCIAL_WRITE",
      sourcePath:
        "apps/api/src/imports/import-session/ocr/pdf-ocr-analyze.integration.spec.ts",
    });
    expect(violations).toEqual([]);
  });

  it("serializes only seven-field mechanical test attestations and never observations", async () => {
    const loadedPolicy = await api().loadQualityClosurePolicy({
      root: ROOT,
      now: new Date("2026-10-14T12:00:00.000Z"),
    });
    const policy = causalPolicy(loadedPolicy);
    const result = canonicalJestResult();
    const tests = await api().runQualityClosureSuite(policy, {
      root: ROOT,
      exec: jestExec(result),
    });
    const closure = {
      version: 2,
      policyVersion: policy.policyVersion,
      snapshot: { marker: "deterministic-test-snapshot" },
      tests,
    };

    expect(closure).not.toHaveProperty("observations");
    expect(closure.tests).toHaveLength(45);
    for (const test of closure.tests)
      expect(Object.keys(test).sort()).toEqual(
        [
          "assertionRecordSha256",
          "fullName",
          "name",
          "sourcePath",
          "status",
          "suiteResultSha256",
          "title",
        ].sort(),
      );
  });

  it("recomputes the canonical unsigned evidence digest before invoking the signature verifier", () => {
    const signed = signedLegacyAuthorityFixture();
    signed.authority.evidenceSha256 = "f".repeat(64);
    const verifier = { verify: jest.fn(() => true) };

    expect(api().isCanonicalQualityClosure(signed, { verifier })).toBe(false);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("rejects signature replay from candidate A onto candidate B before invoking the verifier", () => {
    const signedA = signedLegacyAuthorityFixture("a".repeat(40));
    const unsignedB = legacyUnsignedAuthorityFixture("b".repeat(40));
    const replayed = {
      ...unsignedB,
      authority: {
        ...signedA.authority,
        candidateSha: "b".repeat(40),
      },
    };
    const verifier = { verify: jest.fn(() => true) };

    expect(api().isCanonicalQualityClosure(replayed, { verifier })).toBe(false);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("requires candidateSha in the signed authority instead of synthesizing it from the snapshot", () => {
    const signed = signedLegacyAuthorityFixture();
    const authorityWithoutCandidate = { ...signed.authority } as Partial<
      typeof signed.authority
    >;
    delete authorityWithoutCandidate.candidateSha;
    const verifier = { verify: jest.fn(() => true) };

    expect(
      api().isCanonicalQualityClosure(
        { ...signed, authority: authorityWithoutCandidate },
        { verifier },
      ),
    ).toBe(false);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("treats a parser-valid marker as structure only, never signing authority", () => {
    const unsigned = unsignedAuthorityFixture();
    const verifier = { verify: jest.fn(() => true) };

    expect(api().isStructurallyValidQualityClosureEnvelope(unsigned)).toBe(
      true,
    );
    expect(api().isCanonicalQualityClosure(unsigned, { verifier })).toBe(false);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("rejects a caller-constructed token even when every public field and hash matches", async () => {
    const closure = signedLegacyAuthorityFixture();
    const evidence = { qualityClosure: closure };
    const callerToken = Object.freeze({
      headSha: closure.snapshot.headSha,
      closureSha256: canonicalDigest(closure),
      evidenceSha256: canonicalDigest(evidence),
      keyId: closure.authority.keyId,
      signature: closure.authority.signature,
    });
    const verifier = { verify: jest.fn(() => true) };

    await expect(
      api().isVerifiedQualityClosureToken(callerToken, evidence, {
        verifier,
      }),
    ).resolves.toBe(false);
  });

  it.each([
    [
      "unsigned closure",
      legacyUnsignedAuthorityFixture(),
      undefined,
      "QUALITY_ACTIVATION_REQUIRES_SIGNED_RELEASE",
    ],
    [
      "signed closure without verifier",
      signedLegacyAuthorityFixture(),
      undefined,
      "QUALITY_ACTIVATION_REQUIRES_SIGNED_RELEASE",
    ],
    [
      "signed closure with a mismatched evidence digest",
      {
        ...signedLegacyAuthorityFixture(),
        authority: {
          ...signedLegacyAuthorityFixture().authority,
          evidenceSha256: "f".repeat(64),
        },
      },
      { verify: jest.fn(() => true) },
      "QUALITY_ACTIVATION_REQUIRES_SIGNED_RELEASE",
    ],
    [
      "signed closure whose signature verifier rejects",
      signedLegacyAuthorityFixture(),
      { verify: jest.fn(() => false) },
      "QUALITY_ACTIVATION_REQUIRES_SIGNED_RELEASE",
    ],
  ] as const)(
    "token issue fails explicitly for %s",
    async (_label, closure, verifier, expectedError) => {
      const policy = await api().loadQualityClosurePolicy({
        root: ROOT,
        now: new Date("2026-10-14T12:00:00.000Z"),
      });
      await expect(
        api().issueVerifiedQualityClosureToken(
          {
            run: {
              residualRiskAcceptance: null,
              finalReviews: null,
            },
            qualityClosure: closure,
          },
          legacyUnsignedAuthorityFixture(),
          policy,
          {
            root: ROOT,
            exec: gitExec(ROOT),
            ...(verifier ? { verifier } : {}),
          },
        ),
      ).rejects.toThrow(expectedError);
    },
  );

  it("frames singleton policy and corpus hashes with path and NUL delimiters", async () => {
    const policy = await api().loadQualityClosurePolicy({
      root: ROOT,
      now: new Date("2026-10-21T23:59:59.999Z"),
    });
    const snapshot = await api().snapshotQualityRepository(policy, {
      root: ROOT,
      exec: gitExec(ROOT),
    });
    expect(snapshot.policySha256).toBe(
      framedHash(POLICY_PATH, await readFile(resolve(ROOT, POLICY_PATH))),
    );
    expect(snapshot.corpusSha256).toBe(
      framedHash(CORPUS_PATH, await readFile(resolve(ROOT, CORPUS_PATH))),
    );
  });

  it("pins the current policy to literal 1/0 thresholds and exact runtime limits", async () => {
    const baseline = JSON.parse(
      await readFile(resolve(ROOT, POLICY_PATH), "utf8"),
    ) as Policy;
    expect(baseline.thresholds).toEqual({
      scannedTaskSuccessRate: 1,
      exactMoneyRate: 1,
      exactSignRate: 1,
      exactDateRate: 1,
      exactDateExplicitnessRate: 1,
      exactInstallmentRate: 1,
      unknownPreservationRate: 1,
      visibleEvidenceRate: 1,
      schemaValidityRate: 1,
      inventedRows: 0,
      omittedRows: 0,
      tenantLeaks: 0,
      falseAutomations: 0,
      financialWrites: 0,
    });
    expect(baseline).toMatchObject({
      maxOutputTokens: 8192,
      maxP95LatencyMs: 30_000,
      maxProviderDeadlineMs: 60_000,
      maxRequestBodyBytes: 20_000_000,
      maxTotalCostMicros: 502_000,
      maxVmHwmBytes: 536_870_912,
      declaredLimits: {
        maxP95LatencyMs: 30_000,
        maxTotalCostMicros: 502_000,
        maxRequestBodyBytes: 20_000_000,
        maxProviderDeadlineMs: 60_000,
        maxVmHwmBytes: 536_870_912,
      },
      durableBudgets: {
        tenantLimitMicros: 500_000,
        globalLimitMicros: 500_000,
        storage: "DATABASE",
      },
      runtimeContract: {
        maxOutputTokens: 8192,
        providerDeadlineMs: 60_000,
        maxPages: 10,
        maxOccurrences: 24,
      },
      pricing: {
        currency: "USD",
        source: "https://cloud.google.com/vertex-ai/generative-ai/pricing",
        observedOn: "2026-10-14",
        recheckThroughUtc: "2026-10-21",
        inputMicrosPerMillionTokens: 300_000,
        outputMicrosPerMillionTokens: 2_500_000,
      },
    });
    expect(baseline.declaredLimits).toEqual({
      maxP95LatencyMs: 30_000,
      maxTotalCostMicros: 502_000,
      maxRequestBodyBytes: 20_000_000,
      maxProviderDeadlineMs: 60_000,
      maxVmHwmBytes: 536_870_912,
    });
    expect(baseline.durableBudgets).toEqual({
      tenantLimitMicros: 500_000,
      globalLimitMicros: 500_000,
      storage: "DATABASE",
    });
    expect(baseline.runtimeContract).toEqual({
      provider: "GOOGLE_VERTEX_AI",
      model: "gemini-2.5-flash",
      region: "southamerica-east1",
      endpoint: "https://southamerica-east1-aiplatform.googleapis.com",
      maxPages: 10,
      maxOccurrences: 24,
      maxOutputTokens: 8192,
      providerDeadlineMs: 60_000,
      dailyBudgetCalls: { user: 25, tenant: 100, global: 1_000 },
      dailyBudgetPages: { user: 250, tenant: 1_000, global: 10_000 },
      dailyBudgetBytes: {
        user: 250_000_000,
        tenant: 1_000_000_000,
        global: 10_000_000_000,
      },
      dailyBudgetCostUnits: {
        user: 819_200,
        tenant: 3_276_800,
        global: 32_768_000,
      },
      reservedCostUnitsPerCall: 32_768,
    });
    expect(baseline.pricing).toEqual({
      currency: "USD",
      source: "https://cloud.google.com/vertex-ai/generative-ai/pricing",
      observedOn: "2026-10-14",
      recheckThroughUtc: "2026-10-21",
      inputMicrosPerMillionTokens: 300_000,
      outputMicrosPerMillionTokens: 2_500_000,
    });
  });

  it("accepts the full threshold domain and rejects only out-of-domain values", async () => {
    const baseline = JSON.parse(
      await readFile(resolve(ROOT, POLICY_PATH), "utf8"),
    ) as Policy;
    const rejectedValid: string[] = [];
    const acceptedInvalid: string[] = [];
    const load = async (
      label: string,
      name: string,
      value: number,
      valid: boolean,
    ) => {
      const root = await mkdtemp(join(tmpdir(), "ocr-policy-domain-"));
      const changed = structuredClone(baseline);
      changed.thresholds[name] = value;
      await writePolicy(root, changed);
      try {
        const loaded = await api().loadQualityClosurePolicy({
          root,
          now: new Date("2026-10-21T23:59:59.999Z"),
        });
        if (valid) expect(loaded.thresholds[name]).toBe(value);
        else acceptedInvalid.push(label);
      } catch (error) {
        if (valid) rejectedValid.push(label);
        else
          expect(error).toEqual(
            expect.objectContaining({ message: "QUALITY_POLICY_INVALID" }),
          );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };

    for (const name of RATE_THRESHOLD_NAMES) {
      for (const value of [0, 0.5, 1])
        await load(`${name}:${value}`, name, value, true);
      for (const value of [-0.001, 1.001])
        await load(`${name}:invalid:${value}`, name, value, false);
    }
    for (const name of DEFECT_THRESHOLD_NAMES) {
      for (const value of [0, 1])
        await load(`${name}:${value}`, name, value, true);
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
        await load(`${name}:invalid:${value}`, name, value, false);
    }
    for (const [label, token] of [
      ["positive-infinity", "1e999"],
      ["negative-infinity", "-1e999"],
      ["NaN", "NaN"],
    ]) {
      const root = await mkdtemp(join(tmpdir(), "ocr-policy-nonfinite-"));
      const path = resolve(root, POLICY_PATH);
      await mkdir(dirname(path), { recursive: true });
      const raw = JSON.stringify(baseline).replace(
        '"scannedTaskSuccessRate":1',
        `"scannedTaskSuccessRate":${token}`,
      );
      await writeFile(path, raw);
      try {
        await api().loadQualityClosurePolicy({
          root,
          now: new Date("2026-10-21T23:59:59.999Z"),
        });
        acceptedInvalid.push(`scannedTaskSuccessRate:${label}`);
      } catch (error) {
        expect(error).toEqual(
          expect.objectContaining({ message: "QUALITY_POLICY_INVALID" }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    expect(acceptedInvalid).toEqual([]);
    expect(rejectedValid).toEqual([]);
  });

  it.each([
    [
      "scannedTaskSuccessRate",
      (predictions: EvalPrediction[]) => {
        predictions[0]!.artifactSha256 = "f".repeat(64);
      },
    ],
    [
      "exactMoneyRate",
      (predictions: EvalPrediction[]) => {
        const row = successfulRows(predictions).find(
          (item) => item.amountCents !== null,
        );
        if (!row) throw new Error("missing money fixture");
        row.amountCents =
          String(row.amountCents) === "999999" ? "888888" : "999999";
      },
    ],
    [
      "exactSignRate",
      (predictions: EvalPrediction[]) => {
        const row = successfulRows(predictions).find(
          (item) => item.sign === "POSITIVE" || item.sign === "NEGATIVE",
        );
        if (!row) throw new Error("missing sign fixture");
        row.sign = row.sign === "POSITIVE" ? "NEGATIVE" : "POSITIVE";
      },
    ],
    [
      "exactDateRate",
      (predictions: EvalPrediction[]) => {
        const row = successfulRows(predictions)[0];
        if (!row) throw new Error("missing date fixture");
        row.dateText = "31/12/2099";
        row.normalizedDate = "2099-12-31";
      },
    ],
    [
      "exactDateExplicitnessRate",
      (predictions: EvalPrediction[]) => {
        const row = successfulRows(predictions)[0];
        if (!row) throw new Error("missing date explicitness fixture");
        row.dateExplicitness =
          row.dateExplicitness === "EXPLICIT" ? "UNKNOWN" : "EXPLICIT";
      },
    ],
    [
      "exactInstallmentRate",
      (predictions: EvalPrediction[]) => {
        const row = successfulRows(predictions)[0];
        if (!row) throw new Error("missing installment fixture");
        row.installmentTotal =
          typeof row.installmentTotal === "number"
            ? row.installmentTotal + 1
            : 2;
      },
    ],
    [
      "unknownPreservationRate",
      (predictions: EvalPrediction[]) => {
        const row = successfulRows(predictions).find(
          (item) => item.amountMeaning === "UNKNOWN",
        );
        if (!row) throw new Error("missing unknown fixture");
        row.amountMeaning = "PURCHASE";
      },
    ],
    [
      "visibleEvidenceRate",
      (predictions: EvalPrediction[]) => {
        const row = successfulRows(predictions)[0];
        if (!row) throw new Error("missing visible evidence fixture");
        row.evidenceText = `${String(row.evidenceText)} altered`;
      },
    ],
    [
      "schemaValidityRate",
      (predictions: EvalPrediction[]) => {
        predictions[0]!.schemaValid = false;
      },
    ],
  ] as Array<[RateThresholdName, (predictions: EvalPrediction[]) => void]>)(
    "honors a fractional configured minimum for %s",
    async (name, mutate) => {
      const thresholds = thresholdSet(0, 1, { [name]: 0.5 });
      await withThresholdEvaluator(thresholds, async (evaluator) => {
        const report = await evaluateThresholdMutation(evaluator, mutate);
        expect(report.thresholds[name]).toBe(0.5);
        expect(report.metrics[name]).toBeGreaterThanOrEqual(0.5);
        expect(report.metrics[name]).toBeLessThan(1);
        expect(report.functionalStatus).toBe("PASS");
      });
    },
  );

  it.each([
    [
      "inventedRows",
      (predictions: EvalPrediction[], count: number) => {
        const outcome = predictions.find(
          (prediction) => prediction.outcome.kind === "SUCCESS",
        )!.outcome;
        if (outcome.kind !== "SUCCESS")
          throw new Error("missing invented-row fixture");
        const region = outcome.regions.find((item) => item.rows.length > 0);
        if (!region) throw new Error("missing invented-row region");
        for (let index = 0; index < count; index += 1)
          region.rows.push({
            ...structuredClone(region.rows[0]!),
            rowId: `invented-${index + 1}`,
          });
      },
    ],
    [
      "omittedRows",
      (predictions: EvalPrediction[], count: number) => {
        const regions = predictions.flatMap((prediction) =>
          prediction.outcome.kind === "SUCCESS"
            ? prediction.outcome.regions
            : [],
        );
        let remaining = count;
        for (const region of regions) {
          while (remaining > 0 && region.rows.length > 0) {
            region.rows.pop();
            remaining -= 1;
          }
          if (remaining === 0) break;
        }
        if (remaining !== 0) throw new Error("missing omitted-row fixtures");
      },
    ],
    [
      "tenantLeaks",
      (predictions: EvalPrediction[], count: number) => {
        for (let index = 0; index < count; index += 1)
          predictions[index]!.tenantId = `wrong-tenant-${index + 1}`;
      },
    ],
    [
      "falseAutomations",
      (predictions: EvalPrediction[], count: number) => {
        const rows = successfulRows(predictions);
        for (let index = 0; index < count; index += 1)
          rows[index]!.selected = true;
      },
    ],
    [
      "financialWrites",
      (predictions: EvalPrediction[], count: number) => {
        predictions[0]!.financialWrites = count;
      },
    ],
  ] as Array<
    [
      DefectThresholdName,
      (predictions: EvalPrediction[], count: number) => void,
    ]
  >)("honors configured maximum 1 for %s", async (name, mutate) => {
    const thresholds = thresholdSet(0, 2, { [name]: 1 });
    await withThresholdEvaluator(thresholds, async (evaluator) => {
      const atMaximum = await evaluateThresholdMutation(
        evaluator,
        (predictions) => mutate(predictions, 1),
        name === "financialWrites",
      );
      expect(atMaximum.thresholds[name]).toBe(1);
      expect(atMaximum.metrics[name]).toBe(1);
      expect(atMaximum.functionalStatus).toBe("PASS");

      const aboveMaximum = await evaluateThresholdMutation(
        evaluator,
        (predictions) => mutate(predictions, 2),
        name === "financialWrites",
      );
      expect(aboveMaximum.metrics[name]).toBe(2);
      expect(aboveMaximum.functionalStatus).toBe("FAIL");
    });
  });

  it("[B3] hashes each canonical Jest assertion and containing suite result", async () => {
    const loadedPolicy = await api().loadQualityClosurePolicy({
      root: ROOT,
      now: new Date("2026-10-21T23:59:59.999Z"),
    });
    const policy = causalPolicy(loadedPolicy);
    const machineResult = canonicalJestResult();
    await expect(
      api().runQualityClosureSuite(policy, {
        root: ROOT,
        exec: jestExec(machineResult),
      }),
    ).resolves.toEqual(expectedHashedObservations(machineResult));
  });

  it("[B3] executes and attests exactly 10 ROUTE plus 35 PROBE tests from the three causal boundary suites", async () => {
    const loadedPolicy = await api().loadQualityClosurePolicy({
      root: ROOT,
      now: new Date("2026-10-14T12:00:00.000Z"),
    });
    const policy = causalPolicy(loadedPolicy);

    const observations = await api().runQualityClosureSuite(policy, {
      root: ROOT,
      exec: actualCausalJestExec(),
    });

    expect(observations).toHaveLength(45);
    expect(observations.map((item) => item.name)).toEqual(
      EXPECTED_TOPOLOGY.map((item) => item.name),
    );
    expect(
      observations.filter((item) => item.name.startsWith("[ROUTE] ")),
    ).toHaveLength(10);
    expect(
      observations.filter((item) => item.name.startsWith("[PROBE] ")),
    ).toHaveLength(35);
    for (const [index, observation] of observations.entries()) {
      expect(observation).toMatchObject({
        name: EXPECTED_TOPOLOGY[index]!.name,
        title: EXPECTED_TOPOLOGY[index]!.name,
        fullName: expect.stringContaining(EXPECTED_TOPOLOGY[index]!.name),
        sourcePath: EXPECTED_TOPOLOGY[index]!.sourcePath,
        status: "PASS",
        assertionRecordSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        suiteResultSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    }
  });

  it("rejects missing, duplicate, unknown, failed, pending, wrong-source, and runtime-error Jest evidence", async () => {
    const loadedPolicy = await api().loadQualityClosurePolicy({
      root: ROOT,
      now: new Date("2026-10-21T23:59:59.999Z"),
    });
    const policy = causalPolicy(loadedPolicy);
    const mutations: Array<
      [string, (result: MachineJestResult) => void, (Error | null)?]
    > = [
      [
        "missing assertion",
        (result) => {
          result.testResults[0]!.assertionResults.shift();
        },
      ],
      [
        "duplicate assertion",
        (result) => {
          result.testResults[0]!.assertionResults.push(
            structuredClone(result.testResults[0]!.assertionResults[0]!),
          );
        },
      ],
      [
        "unknown qualified assertion",
        (result) => {
          result.testResults[0]!.assertionResults.push({
            title: "[PROBE] UNKNOWN_POLICY_PROBE",
            fullName: "[PROBE] UNKNOWN_POLICY_PROBE",
            status: "passed",
            failureMessages: [],
          });
        },
      ],
      [
        "failed assertion",
        (result) => {
          result.testResults[0]!.assertionResults[0]!.status = "failed";
          result.success = false;
          result.numFailedTests = 1;
        },
      ],
      [
        "pending expected assertion",
        (result) => {
          result.testResults[0]!.assertionResults[0]!.status = "pending";
        },
      ],
      [
        "wrong source",
        (result) => {
          const moved = result.testResults[0]!.assertionResults.shift()!;
          result.testResults[1]!.assertionResults.push(moved);
        },
      ],
      [
        "missing suite",
        (result) => {
          result.testResults.pop();
        },
      ],
      [
        "duplicate suite",
        (result) => {
          result.testResults.push(structuredClone(result.testResults[0]!));
        },
      ],
      [
        "runtime error",
        (result) => {
          result.success = false;
          result.numRuntimeErrorTestSuites = 1;
        },
      ],
      ["Jest execution failure", () => undefined, new Error("Jest failed")],
    ];
    const accepted: string[] = [];
    for (const [label, mutate, executionError] of mutations) {
      const changed = canonicalJestResult();
      mutate(changed);
      const exec = jestExec(changed);
      try {
        await api().runQualityClosureSuite(policy, {
          root: ROOT,
          exec: async (file, args, options) => {
            const result = await exec(file, args, options);
            return { ...result, error: executionError ?? result.error };
          },
        });
        accepted.push(label);
      } catch (error) {
        expect(error).toEqual(
          expect.objectContaining({
            message: expect.stringMatching(/^QUALITY_SUITE_/),
          }),
        );
      }
    }
    expect(accepted).toEqual([]);
  });

  it("rejects skipped, todo, and pass-with-failureMessages Jest evidence", async () => {
    const loadedPolicy = await api().loadQualityClosurePolicy({
      root: ROOT,
      now: new Date("2026-10-21T23:59:59.999Z"),
    });
    const policy = causalPolicy(loadedPolicy);
    const mutations: Array<
      [string, (result: ReturnType<typeof canonicalJestResult>) => void]
    > = [
      [
        "skipped",
        (result) => {
          result.numPendingTests = 1;
          result.testResults[0]!.assertionResults.push({
            title: "non-policy skipped control",
            fullName: "non-policy skipped control",
            status: "pending",
            failureMessages: [],
          });
        },
      ],
      [
        "todo",
        (result) => {
          result.numTodoTests = 1;
          result.testResults[0]!.assertionResults.push({
            title: "non-policy todo control",
            fullName: "non-policy todo control",
            status: "todo",
            failureMessages: [],
          });
        },
      ],
      [
        "pass-with-failureMessages",
        (result) => {
          result.testResults[0]!.assertionResults[0]!.failureMessages = [
            "hidden failure",
          ];
        },
      ],
    ];
    const accepted: string[] = [];
    for (const [label, mutate] of mutations) {
      const changed = canonicalJestResult();
      mutate(changed);
      try {
        await api().runQualityClosureSuite(policy, {
          root: ROOT,
          exec: jestExec(changed),
        });
        accepted.push(label);
      } catch (error) {
        expect(error).toEqual(
          expect.objectContaining({
            message: expect.stringMatching(/^QUALITY_SUITE_/),
          }),
        );
      }
    }
    expect(accepted).toEqual([]);
  });

  it("rejects outputs inside the repository", async () => {
    const gitDirectory = resolve(ROOT, ".git");
    await expect(
      api().assertOutputOutsideRepository(resolve(ROOT, "evidence.json"), {
        root: ROOT,
        exec: gitExec(ROOT),
      }),
    ).rejects.toThrow("LIVE_CAPTURE_OUTPUT_INSIDE_REPOSITORY");
    expect(await stat(gitDirectory)).toBeDefined();
  });
});

describe("canonical capture and qualification orchestration", () => {
  const mockedModules = [
    "./live-evidence-parser",
    "./quality-closure-attestation",
    "./capture-live-core",
    "./capture-live-file",
    "../import-session/ocr/vertex-provider.factory",
    "../import-session/ocr/vertex-pdf-ocr.provider",
    "./evaluator",
    "node:fs/promises",
  ];

  afterEach(() => {
    jest.restoreAllMocks();
    for (const moduleName of mockedModules) jest.dontMock(moduleName);
    jest.resetModules();
    process.exitCode = undefined;
  });

  it("globally serializes different outputs and reserves lock/output mode 0600 before dispatch", async () => {
    jest.resetModules();
    jest.doMock("./live-evidence-parser", () => ({
      parseLiveEvidenceJson: jest.fn(),
    }));
    const { writeQualifiedLiveEvidenceExclusive } =
      require("./capture-live-file") as {
        writeQualifiedLiveEvidenceExclusive(
          outputPath: string,
          lockPath: string,
          evidenceFactory: () => Promise<unknown>,
          verifyRepository: () => Promise<void>,
        ): Promise<void>;
      };
    const root = await mkdtemp(join(tmpdir(), "ocr-global-lock-"));
    const lockPath = join(root, "repository.lock");
    const firstOutput = join(root, "first.json");
    const secondOutput = join(root, "second.json");
    let enter!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      enter = resolveEntered;
    });
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });
    const firstFactory = jest.fn(async () => {
      const [lock, output] = await Promise.all([
        stat(lockPath),
        stat(firstOutput),
      ]);
      expect(lock.mode & 0o777).toBe(0o600);
      expect(output.mode & 0o777).toBe(0o600);
      enter();
      await held;
      return {};
    });
    const secondFactory = jest.fn(async () => ({}));
    try {
      const first = writeQualifiedLiveEvidenceExclusive(
        firstOutput,
        lockPath,
        firstFactory,
        async () => undefined,
      );
      await entered;
      await expect(
        writeQualifiedLiveEvidenceExclusive(
          secondOutput,
          lockPath,
          secondFactory,
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(secondFactory).not.toHaveBeenCalled();
      await expect(stat(secondOutput)).rejects.toMatchObject({
        code: "ENOENT",
      });
      release();
      await expect(first).resolves.toBeUndefined();
      expect(firstFactory).toHaveBeenCalledTimes(1);
      expect((await stat(firstOutput)).mode & 0o777).toBe(0o600);
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("[B3] one-argument local capture CLI fails at the protected entrypoint before any dependency", async () => {
    await expect(
      execFile(
        process.execPath,
        [
          "-r",
          "ts-node/register",
          "src/imports/ocr-synth-v1/capture-live.ts",
          "/tmp/result.json",
        ],
        { cwd: join(ROOT, "apps/api") },
      ),
    ).rejects.toMatchObject({
      stderr: "LIVE_CAPTURE_PROTECTED_ENTRYPOINT_UNAVAILABLE\n",
    });
  });

  it("two-argument-looking import is side-effect free before any dependency", async () => {
    jest.resetModules();
    const outputPolicy = jest.fn(async () => undefined);
    const globalLock = jest.fn(async () => "/tmp/ocr-quality-global.lock");
    const attest = jest.fn(async () => ({
      policy: { marker: "policy" },
      closure: { version: 2, marker: "attested", snapshot: {} },
    }));
    const reviewReads = jest.fn(async () => ({}));
    const snapshotVerification = jest.fn(async () => undefined);
    const capture = jest.fn();
    const outputWriter = jest.fn();
    const providerFactory = jest.fn();
    jest.doMock("./quality-closure-attestation", () => ({
      assertOutputOutsideRepository: outputPolicy,
      qualityCaptureLockPath: globalLock,
      attestQualityClosure: attest,
      readFinalReviewHashes: reviewReads,
      assertQualityRepositorySnapshot: snapshotVerification,
    }));
    jest.doMock("./capture-live-file", () => ({
      writeQualifiedLiveEvidenceExclusive: outputWriter,
    }));
    jest.doMock("../import-session/ocr/vertex-provider.factory", () => ({
      createConfiguredVertexPdfOcrProvider: providerFactory,
    }));
    jest.doMock("./capture-live-core", () => ({
      captureLiveEvidence: capture,
    }));
    const previousArguments = process.argv;
    process.argv = [
      process.execPath,
      "capture-live.ts",
      "/tmp/result.json",
      "/tmp/caller-results.json",
    ];
    const stderr = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      let imported: unknown;
      jest.isolateModules(() => {
        imported = require("./capture-live");
      });
      await Promise.resolve();
      expect(imported).toEqual(
        expect.objectContaining({
          runProtectedLiveCapture: expect.any(Function),
        }),
      );
      expect(stderr).not.toHaveBeenCalled();
      expect(outputPolicy).not.toHaveBeenCalled();
      expect(globalLock).not.toHaveBeenCalled();
      expect(attest).not.toHaveBeenCalled();
      expect(reviewReads).not.toHaveBeenCalled();
      expect(snapshotVerification).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
      expect(providerFactory).not.toHaveBeenCalled();
      expect(outputWriter).not.toHaveBeenCalled();
    } finally {
      process.argv = previousArguments;
      stderr.mockRestore();
    }
  });

  interface QualifierOptions {
    size: number;
    mode?: number;
    regular?: boolean;
    openError?: Error;
    finalDrift?: boolean;
    argumentCount?: number;
    lockError?: Error;
  }

  async function runQualifier(options: QualifierOptions) {
    jest.resetModules();
    const events: string[] = [];
    const bytes = Buffer.alloc(options.size, 123);
    const read = jest.fn(async () => bytes);
    const close = jest.fn(async () => undefined);
    const open = jest.fn(async (_path: string, flags: number) => {
      events.push("open");
      expect(flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW);
      if (options.openError) throw options.openError;
      return {
        stat: jest.fn(async () => ({
          isFile: () => options.regular ?? true,
          size: options.size,
          mode: options.mode ?? 0o100600,
        })),
        readFile: read,
        close,
      };
    });
    const input = { qualityClosure: { version: 2, marker: "captured" } };
    const rerun = { version: 2, marker: "captured" };
    const parse = jest.fn(() => input);
    const attest = jest.fn(async () => {
      events.push("rerun");
      return { closure: rerun, policy: { marker: "policy" } };
    });
    const issue = jest.fn(async () => {
      events.push("token");
      return Object.freeze({ opaque: true });
    });
    const evaluate = jest.fn(async (_input, receivedToken) => {
      events.push("evaluate");
      expect(receivedToken).toBeUndefined();
      return { releaseStatus: "PASS" };
    });
    const assert = jest.fn(() => events.push("assert"));
    const finalSnapshot = jest.fn(async () => {
      events.push("final-snapshot");
      if (options.finalDrift) throw new Error("QUALITY_REPOSITORY_DRIFT");
    });
    const withQualityCaptureLock = jest.fn(
      async (action: () => Promise<unknown>) => {
        events.push("lock");
        if (options.lockError) throw options.lockError;
        return action();
      },
    );
    jest.doMock("node:fs/promises", () => ({ open }));
    jest.doMock("./live-evidence-parser", () => ({
      parseLiveEvidenceJson: parse,
    }));
    jest.doMock("./quality-closure-attestation", () => ({
      attestQualityClosure: attest,
      createQualityClosureVerifier: () => ({ verify: () => true }),
      issueVerifiedQualityClosureToken: issue,
      assertQualityRepositorySnapshot: finalSnapshot,
      withQualityCaptureLock,
    }));
    jest.doMock("./evaluator", () => ({
      evaluateOcrSynth: evaluate,
      assertReleaseQualified: assert,
    }));
    const previousArguments = process.argv;
    process.argv = [
      process.execPath,
      "qualify-live.ts",
      ...(options.argumentCount === 0 ? [] : ["/tmp/evidence.json"]),
      ...(options.argumentCount === 2 ? ["/tmp/caller-results.json"] : []),
    ];
    let finish!: (result: {
      stream: "stdout" | "stderr";
      text: string;
    }) => void;
    const finished = new Promise<{
      stream: "stdout" | "stderr";
      text: string;
    }>((resolveFinished) => {
      finish = resolveFinished;
    });
    jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      events.push("stdout");
      finish({ stream: "stdout", text: String(chunk) });
      return true;
    });
    jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      events.push("stderr");
      finish({ stream: "stderr", text: String(chunk) });
      return true;
    });
    try {
      jest.isolateModules(() => require("./qualify-live"));
      const result = await finished;
      return {
        result,
        events,
        open,
        read,
        close,
        parse,
        attest,
        issue,
        evaluate,
        assert,
        finalSnapshot,
        withQualityCaptureLock,
      };
    } finally {
      process.argv = previousArguments;
    }
  }

  it.each([
    [0, false],
    [1, true],
    [32 * 1024 * 1024, true],
    [32 * 1024 * 1024 + 1, false],
  ])("enforces qualifier evidence size boundary %i", async (size, accepted) => {
    const result = await runQualifier({ size });
    expect(result.result.stream).toBe(accepted ? "stdout" : "stderr");
    expect(result.read).toHaveBeenCalledTimes(accepted ? 1 : 0);
    expect(result.close).toHaveBeenCalledTimes(1);
    expect(result.attest).toHaveBeenCalledTimes(accepted ? 1 : 0);
    expect(result.issue).not.toHaveBeenCalled();
    if (accepted) {
      expect(result.events).toEqual([
        "lock",
        "open",
        "rerun",
        "evaluate",
        "assert",
        "final-snapshot",
        "stdout",
      ]);
    } else {
      expect(result.result.text).toBe("LIVE_EVIDENCE_FILE_INVALID\n");
    }
  });

  it("reads one no-follow regular mode-0600 qualifier file exactly once", async () => {
    const result = await runQualifier({ size: 1 });
    expect(result.result.stream).toBe("stdout");
    expect(result.open).toHaveBeenCalledTimes(1);
    expect(result.read).toHaveBeenCalledTimes(1);
    expect(result.parse).toHaveBeenCalledTimes(1);
    expect(result.close).toHaveBeenCalledTimes(1);
    expect(result.withQualityCaptureLock).toHaveBeenCalledTimes(1);
  });

  it("[B3] qualifier and capture share the repository lock before evidence read or evaluation", async () => {
    const result = await runQualifier({
      size: 1,
      lockError: new Error("QUALITY_CAPTURE_LOCK_HELD"),
    });

    expect(result.result).toEqual({
      stream: "stderr",
      text: "QUALITY_CAPTURE_LOCK_HELD\n",
    });
    expect(result.events).toEqual(["lock", "stderr"]);
    expect(result.open).not.toHaveBeenCalled();
    expect(result.parse).not.toHaveBeenCalled();
    expect(result.attest).not.toHaveBeenCalled();
    expect(result.evaluate).not.toHaveBeenCalled();
  });

  it.each([
    { label: "non-regular", regular: false },
    { label: "mode-0644", mode: 0o100644 },
  ])("rejects qualifier evidence that is $label", async (mutation) => {
    const result = await runQualifier({ size: 1, ...mutation });
    expect(result.result).toEqual({
      stream: "stderr",
      text: "LIVE_EVIDENCE_FILE_INVALID\n",
    });
    expect(result.read).not.toHaveBeenCalled();
    expect(result.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a qualifier symlink through O_NOFOLLOW without reading it", async () => {
    const error = Object.assign(new Error("ELOOP"), { code: "ELOOP" });
    const result = await runQualifier({ size: 1, openError: error });
    expect(result.result.stream).toBe("stderr");
    expect(result.result.text).toBe("ELOOP\n");
    expect(result.read).not.toHaveBeenCalled();
    expect(result.attest).not.toHaveBeenCalled();
  });

  it("rejects a second qualifier argument before opening evidence", async () => {
    const result = await runQualifier({ size: 1, argumentCount: 2 });
    expect(result.result).toEqual({
      stream: "stderr",
      text: "LIVE_EVIDENCE_PATH_MISSING\n",
    });
    expect(result.open).not.toHaveBeenCalled();
    expect(result.attest).not.toHaveBeenCalled();
  });

  it("asserts release and final repository stability before stdout", async () => {
    const result = await runQualifier({ size: 1, finalDrift: true });
    expect(result.result).toEqual({
      stream: "stderr",
      text: "QUALITY_REPOSITORY_DRIFT\n",
    });
    expect(result.events).toEqual([
      "lock",
      "open",
      "rerun",
      "evaluate",
      "assert",
      "final-snapshot",
      "stderr",
    ]);
    expect(result.assert).toHaveBeenCalledTimes(1);
    expect(result.finalSnapshot).toHaveBeenCalledTimes(1);
  });
});
