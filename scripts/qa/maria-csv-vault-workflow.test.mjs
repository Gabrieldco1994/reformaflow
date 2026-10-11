import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { __parsePrettierYamlConfig as parseYaml } from "prettier/plugins/yaml";
import {
  IMPORT_VAULT_PURGE_SCHEDULER_INTERVAL_MS,
  QA_VAULT_PURGE_WAIT_MARGIN_MS,
  QA_VAULT_PURGE_WAIT_MS,
} from "./maria-csv-vault-timing.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOW_PATH = join(
  ROOT,
  ".github",
  "workflows",
  "maria-csv-vault-qa.yml",
);
const PLAYWRIGHT_ROOT = join(ROOT, "apps", "web", "e2e-qa");
const CSV_JOURNEY_PATH = join(PLAYWRIGHT_ROOT, "maria-csv-invoice.spec.ts");
const ASSERT_SCRIPT_PATH = join(ROOT, "scripts", "qa", "maria-csv-assert.mjs");
const TARGET_JOB = "maria-csv-vault";
const TARGET_STEPS = [
  "Run mandatory real Maria CSV + PDF journeys (${{ matrix.viewport }})",
  "Assert exact CSV financial inventory (${{ matrix.viewport }})",
];
const EXPECTED_TMPDIR = "${{ env.QA_RUNTIME_DIR }}";
const REQUIRED_RUN_PREFIX = [
  "set -euo pipefail",
  'test -n "${QA_RUNTIME_DIR:-}"',
  'test "${TMPDIR:-}" = "$QA_RUNTIME_DIR"',
];
const REQUIRED_POST_CONFIRM = `node scripts/qa/maria-csv-assert.mjs post-confirm --db "$QA_DB_PATH" --selected-count 2 --vault "$QA_VAULT_DIR" --purge-wait-ms ${QA_VAULT_PURGE_WAIT_MS}`;

function parseWorkflow() {
  return parseYaml(readFileSync(WORKFLOW_PATH, "utf8"), {});
}

function tmpdirLocations(workflow) {
  const locations = [];
  if (Object.hasOwn(workflow.env ?? {}, "TMPDIR"))
    locations.push({ location: "workflow", value: workflow.env.TMPDIR });

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    if (Object.hasOwn(job.env ?? {}, "TMPDIR"))
      locations.push({
        location: `jobs.${jobName}`,
        value: job.env.TMPDIR,
      });
    for (const step of job.steps ?? []) {
      if (Object.hasOwn(step.env ?? {}, "TMPDIR"))
        locations.push({
          location: `jobs.${jobName}.steps.${step.name ?? "<unnamed>"}`,
          value: step.env.TMPDIR,
        });
    }
  }
  return locations;
}

function assertPurgeWindow(milliseconds, label) {
  assert(
    Number.isSafeInteger(milliseconds) &&
      milliseconds >=
        IMPORT_VAULT_PURGE_SCHEDULER_INTERVAL_MS +
          QA_VAULT_PURGE_WAIT_MARGIN_MS,
    `${label} must exceed one purge scheduler interval by the QA margin`,
  );
  assert.equal(
    milliseconds,
    QA_VAULT_PURGE_WAIT_MS,
    `${label} must use the shared QA purge window`,
  );
}

function commandPurgeWait(command) {
  const matches = [...command.matchAll(/--purge-wait-ms(?:=|\s+)([0-9]+)/g)];
  assert.equal(matches.length, 1, "expected exactly one purge wait option");
  return Number(matches[0][1]);
}

function playwrightOracleCallsites(directory = PLAYWRIGHT_ROOT) {
  const callsites = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isDirectory())
      callsites.push(...playwrightOracleCallsites(candidate));
    else if (
      entry.isFile() &&
      candidate.endsWith(".ts") &&
      readFileSync(candidate, "utf8").includes("maria-csv-assert.mjs")
    )
      callsites.push(candidate);
  }
  return callsites;
}

function assertPlaywrightPurgeWindow(source) {
  assert.deepEqual(playwrightOracleCallsites(), [CSV_JOURNEY_PATH]);
  assert.equal(
    source.match(/execFileAsync\(process\.execPath/g)?.length,
    1,
    "CSV journey must have exactly one active oracle subprocess",
  );
  assert.equal(
    source.match(/"--purge-wait-ms"/g)?.length,
    1,
    "Every active Playwright oracle subprocess must set one purge window",
  );
  assert.match(
    source,
    /"--purge-wait-ms",\s*String\(QA_VAULT_PURGE_WAIT_MS\),/,
    "Playwright oracle must use the shared QA purge window",
  );
}

function assertOracleDefaultPurgeWindow(source) {
  assert.match(
    source,
    /import \{ QA_VAULT_PURGE_WAIT_MS \} from "\.\/maria-csv-vault-timing\.mjs";/,
    "Oracle default must import the shared QA purge window",
  );
  assert.match(
    source,
    /args\["--purge-wait-ms"\] \?\? QA_VAULT_PURGE_WAIT_MS/,
    "Oracle default must use the shared QA purge window",
  );
}

function assertScopedTempRoot(workflow) {
  assert.deepEqual(
    tmpdirLocations(workflow),
    TARGET_STEPS.map((name) => ({
      location: `jobs.${TARGET_JOB}.steps.${name}`,
      value: EXPECTED_TMPDIR,
    })),
  );

  const steps = workflow.jobs[TARGET_JOB].steps;
  for (const name of TARGET_STEPS) {
    const matches = steps.filter((step) => step.name === name);
    assert.equal(matches.length, 1, `expected exactly one "${name}" step`);
    assert.deepEqual(
      matches[0].run.trim().split("\n").slice(0, 3),
      REQUIRED_RUN_PREFIX,
      `${name} must fail closed before its first QA command`,
    );
  }

  const inventoryStep = steps.find((step) => step.name === TARGET_STEPS[1]);
  assert.equal(
    inventoryStep.run.trim().split("\n")[3],
    REQUIRED_POST_CONFIRM,
    "post-confirm must poll DB quota and raw-byte cleanup beyond one scheduler cadence",
  );
  assertPurgeWindow(
    commandPurgeWait(inventoryStep.run),
    "workflow inventory oracle",
  );
}

test("only the two DB-consuming Maria QA steps trust the scoped ext4 temp root", () => {
  assertScopedTempRoot(parseWorkflow());
});

test("every live Maria CSV oracle waits beyond the purge scheduler cadence", () => {
  assertPurgeWindow(QA_VAULT_PURGE_WAIT_MS, "shared QA purge window");
  assertOracleDefaultPurgeWindow(readFileSync(ASSERT_SCRIPT_PATH, "utf8"));
  assertPlaywrightPurgeWindow(readFileSync(CSV_JOURNEY_PATH, "utf8"));
});

test("the scoped temp-root contract rejects missing, broad, arbitrary, or unguarded trust", () => {
  const mutations = [
    (workflow) => {
      delete workflow.jobs[TARGET_JOB].steps.find(
        (step) => step.name === TARGET_STEPS[0],
      ).env.TMPDIR;
    },
    (workflow) => {
      workflow.jobs[TARGET_JOB].env = { TMPDIR: EXPECTED_TMPDIR };
    },
    (workflow) => {
      workflow.jobs[TARGET_JOB].steps.find(
        (step) => step.name === TARGET_STEPS[0],
      ).env.TMPDIR = "${{ env.ARBITRARY_RUNTIME_DIR }}";
    },
    (workflow) => {
      const step = workflow.jobs[TARGET_JOB].steps.find(
        (candidate) => candidate.name === TARGET_STEPS[1],
      );
      step.run = step.run.replace(`${REQUIRED_RUN_PREFIX[2]}\n`, "");
    },
    (workflow) => {
      const step = workflow.jobs[TARGET_JOB].steps.find(
        (candidate) => candidate.name === TARGET_STEPS[1],
      );
      step.run = step.run.replace(
        '--vault "$QA_VAULT_DIR" --purge-wait-ms 75000',
        "--purge-wait-ms 30000",
      );
    },
  ];

  for (const mutate of mutations) {
    const workflow = structuredClone(parseWorkflow());
    mutate(workflow);
    assert.throws(() => assertScopedTempRoot(workflow));
  }

  const shortJourney = readFileSync(CSV_JOURNEY_PATH, "utf8").replace(
    "String(QA_VAULT_PURGE_WAIT_MS)",
    '"30000"',
  );
  assert.throws(() => assertPlaywrightPurgeWindow(shortJourney));
  const shortDefault = readFileSync(ASSERT_SCRIPT_PATH, "utf8").replace(
    'args["--purge-wait-ms"] ?? QA_VAULT_PURGE_WAIT_MS',
    'args["--purge-wait-ms"] ?? 30000',
  );
  assert.throws(() => assertOracleDefaultPurgeWindow(shortDefault));
});

const blockerDWorkflowSource = readFileSync(WORKFLOW_PATH, "utf8");
const blockerDModelLock = JSON.parse(
  readFileSync(
    join(ROOT, "scripts", "qa", "maria-import-eval", "model-lock.v1.json"),
    "utf8",
  ),
);

test("blocker D workflow watches eval, prompt, provider, lock and test surfaces", () => {
  for (const required of [
    "scripts/qa/**",
    "apps/api/src/agent/**",
    "packages/domain/src/import-*.ts",
    "package-lock.json",
    "docs/maria-ia.md",
    ".github/workflows/maria-csv-vault-qa.yml",
  ])
    assert.ok(blockerDWorkflowSource.includes(required), required);
});

test("blocker D has one mandatory dedicated loopback eval job without fallback", () => {
  assert.equal(
    (blockerDWorkflowSource.match(/^  maria-model-eval:/gm) ?? []).length,
    1,
  );
  assert.match(blockerDWorkflowSource, /MARIA_IMPORT_MODEL_EVAL:\s*["\x27]?1/);
  assert.match(
    blockerDWorkflowSource,
    /npm --workspace @reformaflow\/api run maria-import:eval/,
  );
  assert.doesNotMatch(blockerDWorkflowSource, /continue-on-error:\s*true/);
  assert.doesNotMatch(blockerDWorkflowSource, /\|\|\s*(true|echo|:)/);
  assert.doesNotMatch(blockerDWorkflowSource, /AGENT_LLM_FALLBACK/);
});

test("blocker D reads canonical lock and requires digest provenance plus report validation", () => {
  assert.equal(blockerDModelLock.name, "qwen2.5:7b-instruct");
  assert.match(blockerDModelLock.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(blockerDWorkflowSource, /model-lock\.v1\.json/);
  assert.match(blockerDWorkflowSource, /ollama-model-lock\.cjs verify/);
  assert.match(blockerDWorkflowSource, /maria-model-provenance\.json/);
  assert.match(blockerDWorkflowSource, /maria-import-eval-report\.json/);
  assert.match(blockerDWorkflowSource, /if:\s*always\(\)/);
  assert.match(blockerDWorkflowSource, /validate-report/);
});

test("viewport jobs continue to consume the same explicit locked instruct model", () => {
  assert.match(
    blockerDWorkflowSource,
    /matrix:[\s\S]*mobile-375[\s\S]*mobile-390[\s\S]*desktop-1280/,
  );
  assert.doesNotMatch(blockerDWorkflowSource, /qwen2\.5:7b(?!-instruct)/);
  assert.match(blockerDWorkflowSource, /QA_OLLAMA_MODEL=\$model/);
  assert.match(
    blockerDWorkflowSource,
    /maria-import-eval-contract\.cjs model-name/,
  );
});
