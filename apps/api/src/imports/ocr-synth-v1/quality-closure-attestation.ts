import { execFile as nodeExecFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import {
  PDF_OCR_LIMITS,
  PDF_OCR_MAX_OUTPUT_TOKENS,
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
  PDF_OCR_VERTEX_ENDPOINT,
} from "@reformaflow/domain";
import {
  PDF_OCR_DAILY_BUDGET_LIMITS,
  PDF_OCR_RESERVED_COST_UNITS_PER_CALL,
} from "../import-session/ocr/pdf-ocr-budget";
import {
  VERTEX_OCR_ENDPOINT,
  VERTEX_OCR_MAX_OUTPUT_TOKENS,
} from "../import-session/ocr/vertex-pdf-ocr.provider";
import { parseStrictJson } from "../import-session/ocr/strict-json";
import type {
  OcrQualityClosure,
  OcrQualityClosureTestEvidence,
  OcrRepositorySnapshot,
} from "./types";
import type { OcrEvalInput } from "./evaluator";

const REPOSITORY_ROOT = resolve(__dirname, "../../../../..");
export const QUALITY_POLICY_PATH =
  "apps/api/src/imports/ocr-synth-v1/quality-closure-policy.json";
export const QUALITY_CORPUS_PATH =
  "apps/api/src/imports/ocr-synth-v1/ground-truth.json";
const LOCAL_JEST_PATH = "node_modules/jest/bin/jest.js";
const GIT_OUTPUT_BYTES = 1024 * 1024;
const JEST_OUTPUT_BYTES = 8 * 1024 * 1024;
const FILE_BYTES = 32 * 1024 * 1024;
const JEST_TIMEOUT_MS = 10 * 60 * 1000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const QUALIFICATION_NAME = /^\[(?:ROUTE|PROBE)\] [A-Za-z0-9_-]+$/;
const RATE_THRESHOLD_KEYS = [
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
const DEFECT_THRESHOLD_KEYS = [
  "inventedRows",
  "omittedRows",
  "tenantLeaks",
  "falseAutomations",
  "financialWrites",
] as const;

type ExecResult = Readonly<{
  error: Error | null;
  stdout: string;
  stderr: string;
}>;

export interface QualityClosurePolicy {
  readonly policyVersion: string;
  readonly validThroughUtc: string;
  readonly maxOutputTokens: number;
  readonly maxP95LatencyMs: number;
  readonly maxProviderDeadlineMs: number;
  readonly maxRequestBodyBytes: number;
  readonly maxTotalCostMicros: number;
  readonly maxVmHwmBytes: number;
  readonly declaredLimits: {
    readonly maxP95LatencyMs: number;
    readonly maxTotalCostMicros: number;
    readonly maxRequestBodyBytes: number;
    readonly maxProviderDeadlineMs: number;
    readonly maxVmHwmBytes: number;
  };
  readonly thresholds: Readonly<Record<string, number>>;
  readonly pricing: {
    readonly currency: "USD";
    readonly source: string;
    readonly observedOn: string;
    readonly recheckThroughUtc: string;
    readonly inputMicrosPerMillionTokens: number;
    readonly outputMicrosPerMillionTokens: number;
  };
  readonly durableBudgets: {
    readonly tenantLimitMicros: number;
    readonly globalLimitMicros: number;
    readonly storage: "DATABASE";
  };
  readonly runtimeContract: {
    readonly provider: string;
    readonly model: string;
    readonly region: string;
    readonly endpoint: string;
    readonly maxPages: number;
    readonly maxOccurrences: number;
    readonly maxOutputTokens: number;
    readonly providerDeadlineMs: number;
    readonly dailyBudgetCalls: Record<"user" | "tenant" | "global", number>;
    readonly dailyBudgetPages: Record<"user" | "tenant" | "global", number>;
    readonly dailyBudgetBytes: Record<"user" | "tenant" | "global", number>;
    readonly dailyBudgetCostUnits: Record<"user" | "tenant" | "global", number>;
    readonly reservedCostUnitsPerCall: number;
  };
  readonly reviewArtifacts: {
    readonly residualRiskAcceptance: string;
    readonly securityReview: string;
    readonly privacyReview: string;
    readonly dataOwnerReview: string;
  };
  readonly jestConfigPath: string;
  readonly qualificationSuiteFiles: readonly string[];
  readonly qualificationTests: readonly {
    readonly name: string;
    readonly sourcePath: string;
  }[];
  readonly configurationBindingFiles: readonly string[];
  readonly adapterBindingFiles: readonly string[];
  readonly runtimeBindingFiles: readonly string[];
}

export interface FinalReviewHashes {
  readonly residualRiskAcceptance: string | null;
  readonly securityReview: string | null;
  readonly privacyReview: string | null;
  readonly dataOwnerReview: string | null;
}

export interface QualityAttestationDependencies {
  readonly root?: string;
  readonly now?: Date;
  readonly exec?: (
    file: string,
    args: readonly string[],
    options: Readonly<{
      cwd: string;
      maxBuffer: number;
      timeout: number;
    }>,
  ) => Promise<ExecResult>;
}

const verifiedTokens = new WeakSet<object>();
const locallyAttestedClosures = new WeakSet<object>();
export interface VerifiedQualityClosureToken {
  readonly headSha: string;
  readonly closureSha256: string;
  readonly evidenceSha256: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  object(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const nonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const finiteRate = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;
const string = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(string);
const unique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

async function defaultExec(
  file: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; maxBuffer: number; timeout: number }>,
): Promise<ExecResult> {
  return await new Promise((resolveResult) => {
    nodeExecFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: options.maxBuffer,
        timeout: options.timeout,
        windowsHide: true,
      },
      (error, stdout, stderr) =>
        resolveResult({
          error,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        }),
    );
  });
}

async function execute(
  dependencies: QualityAttestationDependencies,
  file: string,
  args: readonly string[],
  maxBuffer = GIT_OUTPUT_BYTES,
  timeout = 30_000,
): Promise<ExecResult> {
  return await (dependencies.exec ?? defaultExec)(file, args, {
    cwd: dependencies.root ?? REPOSITORY_ROOT,
    maxBuffer,
    timeout,
  });
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

async function readBoundedFile(root: string, path: string): Promise<Buffer> {
  if (!safeRelativePath(path)) throw new Error("QUALITY_POLICY_INVALID");
  const handle = await open(
    resolve(root, path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > FILE_BYTES)
      throw new Error("QUALITY_BINDING_FILE_INVALID");
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.size)
      throw new Error("QUALITY_BINDING_FILE_INVALID");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function sha256(bytes: Buffer | string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

async function aggregateSha256(
  root: string,
  paths: readonly string[],
): Promise<string> {
  if (!unique(paths) || paths.length === 0)
    throw new Error("QUALITY_POLICY_INVALID");
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    const bytes = await readBoundedFile(root, path);
    hash.update(path);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

const budgetShape = (value: unknown): boolean =>
  exact(value, ["user", "tenant", "global"]) &&
  Object.values(value).every(positiveInteger);
const thresholdShape = (value: unknown): boolean =>
  exact(value, [...RATE_THRESHOLD_KEYS, ...DEFECT_THRESHOLD_KEYS]) &&
  RATE_THRESHOLD_KEYS.every(
    (key) => finiteRate(value[key]) && value[key] === 1,
  ) &&
  DEFECT_THRESHOLD_KEYS.every(
    (key) => nonNegativeInteger(value[key]) && value[key] === 0,
  );

function assertPolicyShape(
  value: unknown,
): asserts value is QualityClosurePolicy {
  const rootKeys = [
    "policyVersion",
    "validThroughUtc",
    "maxOutputTokens",
    "maxP95LatencyMs",
    "maxProviderDeadlineMs",
    "maxRequestBodyBytes",
    "maxTotalCostMicros",
    "maxVmHwmBytes",
    "declaredLimits",
    "thresholds",
    "pricing",
    "durableBudgets",
    "runtimeContract",
    "reviewArtifacts",
    "jestConfigPath",
    "qualificationSuiteFiles",
    "qualificationTests",
    "configurationBindingFiles",
    "adapterBindingFiles",
    "runtimeBindingFiles",
  ];
  if (
    !exact(value, rootKeys) ||
    value.policyVersion !== "ocr-quality-closure-v2" ||
    !validDate(value.validThroughUtc) ||
    !positiveInteger(value.maxOutputTokens) ||
    !positiveInteger(value.maxP95LatencyMs) ||
    !positiveInteger(value.maxProviderDeadlineMs) ||
    !positiveInteger(value.maxRequestBodyBytes) ||
    !positiveInteger(value.maxTotalCostMicros) ||
    !positiveInteger(value.maxVmHwmBytes) ||
    !exact(value.declaredLimits, [
      "maxP95LatencyMs",
      "maxTotalCostMicros",
      "maxRequestBodyBytes",
      "maxProviderDeadlineMs",
      "maxVmHwmBytes",
    ]) ||
    !Object.values(value.declaredLimits).every(positiveInteger) ||
    !thresholdShape(value.thresholds) ||
    !exact(value.pricing, [
      "currency",
      "source",
      "observedOn",
      "recheckThroughUtc",
      "inputMicrosPerMillionTokens",
      "outputMicrosPerMillionTokens",
    ]) ||
    value.pricing.currency !== "USD" ||
    !string(value.pricing.source) ||
    !validDate(value.pricing.observedOn) ||
    !validDate(value.pricing.recheckThroughUtc) ||
    value.pricing.observedOn > value.pricing.recheckThroughUtc ||
    value.validThroughUtc !== value.pricing.recheckThroughUtc ||
    !positiveInteger(value.pricing.inputMicrosPerMillionTokens) ||
    !positiveInteger(value.pricing.outputMicrosPerMillionTokens) ||
    !exact(value.durableBudgets, [
      "tenantLimitMicros",
      "globalLimitMicros",
      "storage",
    ]) ||
    !positiveInteger(value.durableBudgets.tenantLimitMicros) ||
    !positiveInteger(value.durableBudgets.globalLimitMicros) ||
    value.durableBudgets.tenantLimitMicros >
      value.durableBudgets.globalLimitMicros ||
    value.durableBudgets.storage !== "DATABASE" ||
    !exact(value.runtimeContract, [
      "provider",
      "model",
      "region",
      "endpoint",
      "maxPages",
      "maxOccurrences",
      "maxOutputTokens",
      "providerDeadlineMs",
      "dailyBudgetCalls",
      "dailyBudgetPages",
      "dailyBudgetBytes",
      "dailyBudgetCostUnits",
      "reservedCostUnitsPerCall",
    ]) ||
    !string(value.runtimeContract.provider) ||
    !string(value.runtimeContract.model) ||
    !string(value.runtimeContract.region) ||
    !string(value.runtimeContract.endpoint) ||
    !positiveInteger(value.runtimeContract.maxPages) ||
    !positiveInteger(value.runtimeContract.maxOccurrences) ||
    !positiveInteger(value.runtimeContract.maxOutputTokens) ||
    !positiveInteger(value.runtimeContract.providerDeadlineMs) ||
    !budgetShape(value.runtimeContract.dailyBudgetCalls) ||
    !budgetShape(value.runtimeContract.dailyBudgetPages) ||
    !budgetShape(value.runtimeContract.dailyBudgetBytes) ||
    !budgetShape(value.runtimeContract.dailyBudgetCostUnits) ||
    !positiveInteger(value.runtimeContract.reservedCostUnitsPerCall) ||
    !exact(value.reviewArtifacts, [
      "residualRiskAcceptance",
      "securityReview",
      "privacyReview",
      "dataOwnerReview",
    ]) ||
    !Object.values(value.reviewArtifacts).every(
      (path) => string(path) && safeRelativePath(path),
    ) ||
    !string(value.jestConfigPath) ||
    !safeRelativePath(value.jestConfigPath) ||
    !stringArray(value.qualificationSuiteFiles) ||
    !value.qualificationSuiteFiles.every(safeRelativePath) ||
    !unique(value.qualificationSuiteFiles) ||
    !Array.isArray(value.qualificationTests) ||
    value.qualificationTests.length !== 45 ||
    !value.qualificationTests.every(
      (item) =>
        exact(item, ["name", "sourcePath"]) &&
        string(item.name) &&
        QUALIFICATION_NAME.test(item.name) &&
        string(item.sourcePath) &&
        (value.qualificationSuiteFiles as string[]).includes(item.sourcePath),
    ) ||
    !unique(value.qualificationTests.map((item) => item.name)) ||
    value.qualificationTests.filter((item) => item.name.startsWith("[ROUTE] "))
      .length !== 10 ||
    value.qualificationTests.filter((item) => item.name.startsWith("[PROBE] "))
      .length !== 35 ||
    !stringArray(value.configurationBindingFiles) ||
    !stringArray(value.adapterBindingFiles) ||
    !stringArray(value.runtimeBindingFiles) ||
    ![
      ...value.configurationBindingFiles,
      ...value.adapterBindingFiles,
      ...value.runtimeBindingFiles,
    ].every(safeRelativePath)
  )
    throw new Error("QUALITY_POLICY_INVALID");
}

function assertRuntimeContract(policy: QualityClosurePolicy): void {
  const runtime = policy.runtimeContract;
  const same = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left) === JSON.stringify(right);
  if (
    runtime.provider !== PDF_OCR_PROVIDER_ID ||
    runtime.model !== PDF_OCR_MODEL_ID ||
    runtime.region !== PDF_OCR_REGION ||
    runtime.endpoint !== PDF_OCR_VERTEX_ENDPOINT ||
    runtime.endpoint !== VERTEX_OCR_ENDPOINT ||
    runtime.maxPages !== PDF_OCR_LIMITS.pagesPerFile ||
    runtime.maxOccurrences !== PDF_OCR_LIMITS.candidatesPerFile ||
    runtime.maxOutputTokens !== PDF_OCR_MAX_OUTPUT_TOKENS ||
    runtime.maxOutputTokens !== VERTEX_OCR_MAX_OUTPUT_TOKENS ||
    runtime.providerDeadlineMs !== PDF_OCR_LIMITS.providerLatencyMs ||
    policy.declaredLimits.maxProviderDeadlineMs !==
      PDF_OCR_LIMITS.providerLatencyMs ||
    policy.declaredLimits.maxVmHwmBytes <= 0 ||
    !same(runtime.dailyBudgetCalls, PDF_OCR_DAILY_BUDGET_LIMITS.calls) ||
    !same(runtime.dailyBudgetPages, PDF_OCR_DAILY_BUDGET_LIMITS.pages) ||
    !same(runtime.dailyBudgetBytes, PDF_OCR_DAILY_BUDGET_LIMITS.bytes) ||
    !same(
      runtime.dailyBudgetCostUnits,
      PDF_OCR_DAILY_BUDGET_LIMITS.costUnits,
    ) ||
    runtime.reservedCostUnitsPerCall !== PDF_OCR_RESERVED_COST_UNITS_PER_CALL ||
    policy.maxOutputTokens !== runtime.maxOutputTokens ||
    policy.maxP95LatencyMs !== policy.declaredLimits.maxP95LatencyMs ||
    policy.maxProviderDeadlineMs !==
      policy.declaredLimits.maxProviderDeadlineMs ||
    policy.maxRequestBodyBytes !== policy.declaredLimits.maxRequestBodyBytes ||
    policy.maxTotalCostMicros !== policy.declaredLimits.maxTotalCostMicros ||
    policy.maxVmHwmBytes !== policy.declaredLimits.maxVmHwmBytes
  )
    throw new Error("QUALITY_POLICY_RUNTIME_MISMATCH");
}

function assertPolicyCurrent(policy: QualityClosurePolicy, now: Date): void {
  const today = now.toISOString().slice(0, 10);
  if (
    today > policy.validThroughUtc ||
    today > policy.pricing.recheckThroughUtc
  )
    throw new Error("QUALITY_POLICY_EXPIRED");
}

export async function loadQualityClosurePolicy(
  dependencies: QualityAttestationDependencies = {},
): Promise<QualityClosurePolicy> {
  const root = dependencies.root ?? REPOSITORY_ROOT;
  const raw = await readBoundedFile(root, QUALITY_POLICY_PATH);
  let value: unknown;
  try {
    value = parseStrictJson(raw.toString("utf8"));
  } catch {
    throw new Error("QUALITY_POLICY_INVALID");
  }
  assertPolicyShape(value);
  assertPolicyCurrent(value, dependencies.now ?? new Date());
  assertRuntimeContract(value);
  return value;
}

async function git(
  dependencies: QualityAttestationDependencies,
  args: readonly string[],
): Promise<string> {
  const result = await execute(dependencies, "git", args);
  if (result.error || result.stderr.length > GIT_OUTPUT_BYTES)
    throw new Error("QUALITY_REPOSITORY_INVALID");
  return result.stdout;
}

async function assertBindingFilesTracked(
  policy: QualityClosurePolicy,
  dependencies: QualityAttestationDependencies,
): Promise<void> {
  const paths = [
    QUALITY_POLICY_PATH,
    QUALITY_CORPUS_PATH,
    policy.jestConfigPath,
    ...policy.qualificationSuiteFiles,
    ...policy.configurationBindingFiles,
    ...policy.adapterBindingFiles,
    ...policy.runtimeBindingFiles,
  ];
  if (!unique(paths)) {
    // A file may intentionally participate in one aggregate only.
    const aggregatePaths = [
      ...policy.configurationBindingFiles,
      ...policy.adapterBindingFiles,
      ...policy.runtimeBindingFiles,
    ];
    if (!unique(aggregatePaths)) throw new Error("QUALITY_POLICY_INVALID");
  }
  for (const path of new Set(paths)) {
    const result = await execute(dependencies, "git", [
      "ls-files",
      "--error-unmatch",
      "--",
      path,
    ]);
    if (result.error || result.stdout.trim() !== path)
      throw new Error("QUALITY_BINDING_FILE_UNTRACKED");
  }
}

export async function snapshotQualityRepository(
  policy: QualityClosurePolicy,
  dependencies: QualityAttestationDependencies = {},
): Promise<OcrRepositorySnapshot> {
  const root = dependencies.root ?? REPOSITORY_ROOT;
  const actualRoot = await realpath(root);
  const gitRoot = (
    await git(dependencies, ["rev-parse", "--show-toplevel"])
  ).trim();
  if ((await realpath(gitRoot)) !== actualRoot)
    throw new Error("QUALITY_REPOSITORY_INVALID");
  await assertBindingFilesTracked(policy, dependencies);
  const status = await git(dependencies, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.length !== 0) throw new Error("QUALITY_REPOSITORY_DIRTY");
  const headSha = (await git(dependencies, ["rev-parse", "HEAD"])).trim();
  const treeSha = (
    await git(dependencies, ["rev-parse", "HEAD^{tree}"])
  ).trim();
  if (!SHA_PATTERN.test(headSha) || !SHA_PATTERN.test(treeSha))
    throw new Error("QUALITY_REPOSITORY_INVALID");
  return {
    headSha,
    treeSha,
    clean: true,
    policySha256: await aggregateSha256(root, [QUALITY_POLICY_PATH]),
    corpusSha256: await aggregateSha256(root, [QUALITY_CORPUS_PATH]),
    configurationSha256: await aggregateSha256(
      root,
      policy.configurationBindingFiles,
    ),
    adapterSha256: await aggregateSha256(root, policy.adapterBindingFiles),
    runtimeSha256: await aggregateSha256(root, policy.runtimeBindingFiles),
    suiteSha256: await aggregateSha256(root, policy.qualificationSuiteFiles),
  };
}

export async function assertQualityRepositorySnapshot(
  expected: OcrRepositorySnapshot,
  policy: QualityClosurePolicy,
  dependencies: QualityAttestationDependencies = {},
): Promise<void> {
  const current = await snapshotQualityRepository(policy, dependencies);
  if (canonicalJson(current) !== canonicalJson(expected))
    throw new Error("QUALITY_REPOSITORY_DRIFT");
}

interface JestAssertion {
  readonly title?: unknown;
  readonly fullName?: unknown;
  readonly status?: unknown;
  readonly failureMessages?: unknown;
}
interface JestFileResult {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly assertionResults?: unknown;
  readonly message?: unknown;
}

function repositoryPath(root: string, absolute: string): string {
  const path = relative(root, absolute).split(sep).join("/");
  if (!safeRelativePath(path)) throw new Error("QUALITY_SUITE_INVALID");
  return path;
}

function parseJestEvidence(
  raw: string,
  policy: QualityClosurePolicy,
  root: string,
  executionError: Error | null,
): OcrQualityClosureTestEvidence[] {
  let value: unknown;
  try {
    value = parseStrictJson(raw);
  } catch {
    throw new Error("QUALITY_SUITE_INVALID");
  }
  if (
    !object(value) ||
    value.success !== true ||
    value.numFailedTestSuites !== 0 ||
    value.numFailedTests !== 0 ||
    value.numPendingTests !== 0 ||
    value.numTodoTests !== 0 ||
    value.numRuntimeErrorTestSuites !== 0 ||
    !Array.isArray(value.testResults) ||
    executionError
  )
    throw new Error("QUALITY_SUITE_FAILED");
  const suites = value.testResults as JestFileResult[];
  const expectedSuites = new Set(policy.qualificationSuiteFiles);
  const seenSuites = new Set<string>();
  const assertions = new Map<
    string,
    Array<{ status: unknown; sourcePath: string }>
  >();
  for (const suite of suites) {
    if (
      !string(suite.name) ||
      !Array.isArray(suite.assertionResults) ||
      suite.status !== "passed" ||
      suite.message !== ""
    )
      throw new Error("QUALITY_SUITE_FAILED");
    const sourcePath = repositoryPath(root, suite.name);
    if (!expectedSuites.has(sourcePath) || seenSuites.has(sourcePath))
      throw new Error("QUALITY_SUITE_INVALID");
    seenSuites.add(sourcePath);
    for (const assertion of suite.assertionResults as JestAssertion[]) {
      if (
        assertion.status !== "passed" ||
        !Array.isArray(assertion.failureMessages) ||
        assertion.failureMessages.length !== 0
      )
        throw new Error("QUALITY_SUITE_FAILED");
      const title = string(assertion.title)
        ? assertion.title
        : string(assertion.fullName)
          ? assertion.fullName
          : null;
      if (!title) throw new Error("QUALITY_SUITE_INVALID");
      if (!QUALIFICATION_NAME.test(title)) continue;
      const entries = assertions.get(title) ?? [];
      entries.push({ status: assertion.status, sourcePath });
      assertions.set(title, entries);
    }
  }
  if (
    seenSuites.size !== expectedSuites.size ||
    [...expectedSuites].some((path) => !seenSuites.has(path))
  )
    throw new Error("QUALITY_SUITE_INCOMPLETE");
  const expectedNames = new Set(
    policy.qualificationTests.map((item) => item.name),
  );
  if ([...assertions.keys()].some((name) => !expectedNames.has(name)))
    throw new Error("QUALITY_SUITE_UNKNOWN_TEST");
  return policy.qualificationTests.map((expected) => {
    const matches = assertions.get(expected.name);
    if (
      !matches ||
      matches.length !== 1 ||
      matches[0]!.status !== "passed" ||
      matches[0]!.sourcePath !== expected.sourcePath
    )
      throw new Error("QUALITY_SUITE_ATTESTATION_FAILED");
    return {
      name: expected.name,
      status: "PASS",
      sourcePath: expected.sourcePath,
    };
  });
}

export async function runQualityClosureSuite(
  policy: QualityClosurePolicy,
  dependencies: QualityAttestationDependencies = {},
): Promise<OcrQualityClosureTestEvidence[]> {
  const root = dependencies.root ?? REPOSITORY_ROOT;
  const directory = await mkdtemp(join(tmpdir(), "rf-ocr-quality-"));
  await chmod(directory, 0o700);
  const resultPath = join(directory, "jest-results.json");
  try {
    const result = await execute(
      dependencies,
      process.execPath,
      [
        resolve(root, LOCAL_JEST_PATH),
        "--config",
        resolve(root, policy.jestConfigPath),
        "--runInBand",
        "--json",
        "--outputFile",
        resultPath,
        "--runTestsByPath",
        ...policy.qualificationSuiteFiles.map((path) => resolve(root, path)),
      ],
      JEST_OUTPUT_BYTES,
      JEST_TIMEOUT_MS,
    );
    let raw = "";
    try {
      const handle = await open(
        resultPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const metadata = await handle.stat();
        if (
          !metadata.isFile() ||
          metadata.size <= 0 ||
          metadata.size > JEST_OUTPUT_BYTES
        )
          throw new Error("QUALITY_SUITE_INVALID");
        const bytes = await handle.readFile();
        if (bytes.length !== metadata.size)
          throw new Error("QUALITY_SUITE_INVALID");
        raw = bytes.toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      throw new Error("QUALITY_SUITE_INVALID");
    }
    return parseJestEvidence(raw, policy, root, result.error);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function attestQualityClosure(
  dependencies: QualityAttestationDependencies = {},
): Promise<
  Readonly<{
    policy: QualityClosurePolicy;
    closure: OcrQualityClosure;
  }>
> {
  const policy = await loadQualityClosurePolicy(dependencies);
  const before = await snapshotQualityRepository(policy, dependencies);
  const tests = await runQualityClosureSuite(policy, dependencies);
  await assertQualityRepositorySnapshot(before, policy, dependencies);
  const closure: OcrQualityClosure = {
    version: 2,
    policyVersion: policy.policyVersion,
    snapshot: before,
    tests,
  };
  locallyAttestedClosures.add(closure);
  return {
    policy,
    closure,
  };
}

export async function readFinalReviewHashes(
  policy: QualityClosurePolicy,
  dependencies: QualityAttestationDependencies = {},
): Promise<FinalReviewHashes> {
  const root = dependencies.root ?? REPOSITORY_ROOT;
  const result: Record<keyof FinalReviewHashes, string | null> = {
    residualRiskAcceptance: null,
    securityReview: null,
    privacyReview: null,
    dataOwnerReview: null,
  };
  for (const key of Object.keys(result) as Array<keyof FinalReviewHashes>) {
    const path = policy.reviewArtifacts[key];
    const tracked = await execute(dependencies, "git", [
      "ls-files",
      "--",
      path,
    ]);
    if (tracked.error) throw new Error("QUALITY_REPOSITORY_INVALID");
    const trackedPath = tracked.stdout.trim();
    if (trackedPath.length === 0) continue;
    if (trackedPath !== path) throw new Error("QUALITY_REPOSITORY_INVALID");
    result[key] = await sha256(await readBoundedFile(root, path));
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export async function issueVerifiedQualityClosureToken(
  evidence: OcrEvalInput,
  rerun: OcrQualityClosure,
  policy: QualityClosurePolicy,
  dependencies: QualityAttestationDependencies = {},
): Promise<VerifiedQualityClosureToken> {
  const closure = isCanonicalQualityClosure(evidence.qualityClosure)
    ? evidence.qualityClosure
    : undefined;
  const reviews = await readFinalReviewHashes(policy, dependencies);
  const expectedResidualRisk = reviews.residualRiskAcceptance
    ? {
        decision: "OPTION_1_COMPLETE_ORIGINAL_PDF",
        dataOwnerAcceptanceSha256: reviews.residualRiskAcceptance,
        noLocalDerivative: true,
      }
    : null;
  const expectedFinalReviews =
    reviews.securityReview && reviews.privacyReview && reviews.dataOwnerReview
      ? {
          securityReviewSha256: reviews.securityReview,
          privacyReviewSha256: reviews.privacyReview,
          dataOwnerReviewSha256: reviews.dataOwnerReview,
        }
      : null;
  if (
    !closure ||
    !locallyAttestedClosures.has(rerun) ||
    canonicalJson(closure) !== canonicalJson(rerun) ||
    canonicalJson(evidence.run.residualRiskAcceptance) !==
      canonicalJson(expectedResidualRisk) ||
    canonicalJson(evidence.run.finalReviews) !==
      canonicalJson(expectedFinalReviews)
  )
    throw new Error("QUALITY_ATTESTATION_MISMATCH");
  const token = Object.freeze({
    headSha: closure.snapshot.headSha,
    closureSha256: await sha256(canonicalJson(closure)),
    evidenceSha256: await sha256(canonicalJson(evidence)),
  });
  verifiedTokens.add(token);
  return token;
}

export async function isVerifiedQualityClosureToken(
  token: VerifiedQualityClosureToken | undefined,
  evidence: OcrEvalInput,
): Promise<boolean> {
  const closure = isCanonicalQualityClosure(evidence.qualityClosure)
    ? evidence.qualityClosure
    : undefined;
  return (
    token !== undefined &&
    closure !== undefined &&
    verifiedTokens.has(token) &&
    token.headSha === closure.snapshot.headSha &&
    token.closureSha256 === (await sha256(canonicalJson(closure))) &&
    token.evidenceSha256 === (await sha256(canonicalJson(evidence)))
  );
}

export async function assertOutputOutsideRepository(
  outputPath: string,
  dependencies: QualityAttestationDependencies = {},
): Promise<void> {
  const configuredRoot = dependencies.root ?? REPOSITORY_ROOT;
  const root = await realpath(configuredRoot);
  const parent = await realpath(resolve(outputPath, ".."));
  const output = resolve(parent, outputPath.split(/[\\/]/).pop() ?? "");
  const gitDirectories = await Promise.all(
    ["--git-dir", "--git-common-dir"].map(async (argument) => {
      const path = (await git(dependencies, ["rev-parse", argument])).trim();
      return await realpath(resolve(configuredRoot, path));
    }),
  );
  if (
    [root, ...gitDirectories].some(
      (directory) =>
        output === directory || output.startsWith(`${directory}${sep}`),
    )
  )
    throw new Error("LIVE_CAPTURE_OUTPUT_INSIDE_REPOSITORY");
}

export async function qualityCaptureLockPath(
  dependencies: QualityAttestationDependencies = {},
): Promise<string> {
  const root = dependencies.root ?? REPOSITORY_ROOT;
  const commonDirectory = (
    await git(dependencies, ["rev-parse", "--git-common-dir"])
  ).trim();
  const absolute = resolve(root, commonDirectory);
  const metadata = await realpath(absolute);
  return resolve(metadata, "reformaflow-ocr-quality-capture.lock");
}

export function isCanonicalQualityClosure(
  value: unknown,
): value is OcrQualityClosure {
  return (
    exact(value, ["version", "policyVersion", "snapshot", "tests"]) &&
    value.version === 2 &&
    string(value.policyVersion) &&
    exact(value.snapshot, [
      "headSha",
      "treeSha",
      "clean",
      "policySha256",
      "corpusSha256",
      "configurationSha256",
      "adapterSha256",
      "runtimeSha256",
      "suiteSha256",
    ]) &&
    SHA_PATTERN.test(String(value.snapshot.headSha)) &&
    SHA_PATTERN.test(String(value.snapshot.treeSha)) &&
    value.snapshot.clean === true &&
    [
      value.snapshot.policySha256,
      value.snapshot.corpusSha256,
      value.snapshot.configurationSha256,
      value.snapshot.adapterSha256,
      value.snapshot.runtimeSha256,
      value.snapshot.suiteSha256,
    ].every((hash) => typeof hash === "string" && HASH_PATTERN.test(hash)) &&
    Array.isArray(value.tests) &&
    value.tests.length === 45 &&
    value.tests.every(
      (item) =>
        exact(item, ["name", "status", "sourcePath"]) &&
        string(item.name) &&
        QUALIFICATION_NAME.test(item.name) &&
        item.status === "PASS" &&
        string(item.sourcePath) &&
        safeRelativePath(item.sourcePath),
    ) &&
    unique(value.tests.map((item) => item.name))
  );
}
