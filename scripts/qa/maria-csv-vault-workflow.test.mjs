import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { __parsePrettierYamlConfig as parseYaml } from "prettier/plugins/yaml";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOW_PATH = join(
  ROOT,
  ".github",
  "workflows",
  "maria-csv-vault-qa.yml",
);
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
}

test("only the two DB-consuming Maria QA steps trust the scoped ext4 temp root", () => {
  assertScopedTempRoot(parseWorkflow());
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
  ];

  for (const mutate of mutations) {
    const workflow = structuredClone(parseWorkflow());
    mutate(workflow);
    assert.throws(() => assertScopedTempRoot(workflow));
  }
});
