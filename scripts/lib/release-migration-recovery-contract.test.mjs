import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const workflow = readFileSync(
  join(ROOT, ".github", "workflows", "ci.yml"),
  "utf8",
);
const flyConfig = readFileSync(join(ROOT, "apps", "api", "fly.toml"), "utf8");
const dockerfile = readFileSync(
  join(ROOT, "apps", "api", "Dockerfile"),
  "utf8",
);
const CHECKS_FIXTURE = JSON.stringify({
  "48e123": [
    {
      name: "http_service",
      status: "passing",
      output: "HTTP GET /api/docs-json: 200 OK",
      updated_at: "2026-08-28T12:00:00Z",
    },
  ],
});
const MACHINE_IMAGE_FIXTURE =
  "registry.fly.io/reformaflow-api:deployment-01K39@sha256:abc123";
const RELEASE_IMAGE_FIXTURE =
  "registry.fly.io/reformaflow-api:deployment-01K39";

function deployJob() {
  const start = workflow.indexOf("\n  deploy-api:");
  assert.notEqual(start, -1, "deploy-api job is missing");
  return workflow.slice(start);
}

test("deploy remains serialized without cancelling an in-flight release", () => {
  assert.match(deployJob(), /concurrency:[\s\S]*?cancel-in-progress:\s*false/);
});

test("full-SHA stale-run gates run before deploy and after checks and smokes", () => {
  const job = deployJob();
  const gates = [
    ...job.matchAll(/git ls-remote[^\n]*origin refs\/heads\/main/g),
  ].map((match) => match.index);
  const deploy = job.indexOf("flyctl deploy");
  const completedSmokes = job.indexOf('[[ "$auth_status" == "401" ]]');

  assert.equal(
    gates.length,
    2,
    "expected one stale gate on each side of deploy",
  );
  assert.ok(deploy > gates[0], "first stale gate must precede flyctl deploy");
  assert.ok(
    gates[1] > completedSmokes,
    "second stale gate must follow checks and HTTP smokes",
  );
  assert.match(
    job.slice(gates[0], deploy),
    /GITHUB_SHA|\$\{\{\s*github\.sha\s*\}\}/,
  );
  assert.match(
    job.slice(gates[0], deploy),
    /\[\[\s*"\$GITHUB_SHA"\s*!=\s*"\$current_main"\s*\]\]/,
  );
  assert.ok(
    job
      .slice(gates[0], deploy)
      .includes(
        'if [[ ! "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || [[ "$GITHUB_SHA" != "$current_main" ]]; then',
      ),
    "initial stale gate must reject an invalid SHA or a stale SHA",
  );
  assert.match(job.slice(gates[1]), /GITHUB_SHA/);
  assert.match(
    job.slice(gates[1]),
    /\[\[\s*"\$GITHUB_SHA"\s*!=\s*"\$postdeploy_main"\s*\]\]/,
  );
  assert.doesNotMatch(
    `${job.slice(gates[0], deploy)}\n${job.slice(gates[1])}`,
    /::7|short|cut\s+-c/,
  );
});

test("postdeploy verifies the single machine identity, checks, release image, and HTTP contracts", () => {
  const job = deployJob();
  const deploy = job.indexOf("flyctl deploy");
  const postdeploy = job.slice(deploy + "flyctl deploy".length);

  assert.match(
    postdeploy,
    /flyctl\s+machines?\s+list[\s\S]{0,1200}--json[\s\S]{0,1200}length[\s\S]{0,200}(?:==\s*1|-eq\s+1)/,
  );
  assert.match(
    postdeploy,
    /image_ref\.labels\.GH_SHA[\s\S]{0,500}(?:GITHUB_SHA|\$\{\{\s*github\.sha\s*\}\})/,
  );
  assert.match(postdeploy, /\[\[\s*"\$machine_state"\s*==\s*"started"\s*\]\]/);
  assert.match(
    postdeploy,
    /\[\[\s*"\$deployed_sha"\s*==\s*"\$GITHUB_SHA"\s*\]\]/,
  );

  const checksContract =
    'has($id) and (.[$id] | length == 1) and (.[$id][0].status == "passing")';
  assert.match(postdeploy, /flyctl\s+checks\s+list/);
  assert.ok(
    postdeploy.includes(checksContract),
    "checks must use Fly's object keyed by machine ID",
  );
  assert.doesNotMatch(postdeploy, /\.machine_id|\.MachineID|\.Machine\b/);
  const fixtureResult = spawnSync(
    "jq",
    ["-e", "--arg", "id", "48e123", checksContract],
    { input: CHECKS_FIXTURE, encoding: "utf8" },
  );
  assert.equal(fixtureResult.status, 0, fixtureResult.stderr);

  assert.match(
    postdeploy,
    /flyctl\s+releases[\s\S]{0,1200}--json[\s\S]{0,1200}\[0\][\s\S]{0,1200}complete/,
  );
  assert.match(
    postdeploy,
    /\[\[\s*"\$release_status"\s*==\s*"complete"\s*\]\]/,
  );
  assert.match(
    postdeploy,
    /(?:ImageRef[\s\S]{0,800}config\.image|config\.image[\s\S]{0,800}ImageRef)/,
  );
  const imageNormalization =
    'machine_image_without_digest="${machine_image%%@*}"';
  assert.ok(
    postdeploy.includes(imageNormalization),
    "machine image digest must be removed before comparing the release tag",
  );
  assert.match(
    postdeploy,
    /\[\[\s*"\$release_image"\s*==\s*"\$machine_image_without_digest"\s*\]\]/,
  );
  assert.doesNotMatch(
    postdeploy,
    /\[\[\s*"\$release_image"\s*==\s*"\$machine_image"\s*\]\]/,
  );
  const imageFixtureResult = spawnSync(
    "bash",
    [
      "-c",
      `${imageNormalization}; [[ "$release_image" == "$machine_image_without_digest" ]]`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        machine_image: MACHINE_IMAGE_FIXTURE,
        release_image: RELEASE_IMAGE_FIXTURE,
      },
    },
  );
  assert.equal(imageFixtureResult.status, 0, imageFixtureResult.stderr);

  const probeLines = postdeploy
    .split("\n")
    .filter((line) => line.includes('status="$(curl'));
  assert.equal(probeLines.length, 2);
  assert.match(probeLines[0], /--connect-timeout 5/);
  assert.match(probeLines[0], /--max-time 15/);
  assert.match(probeLines[0], /--retry 2/);
  assert.match(probeLines[0], /\/api\/docs-json/);
  assert.match(probeLines[1], /--connect-timeout 5/);
  assert.match(probeLines[1], /--max-time 15/);
  assert.match(probeLines[1], /--retry 2/);
  assert.match(probeLines[1], /\/auth\/me/);
  assert.match(postdeploy, /\[\[\s*"\$docs_status"\s*==\s*"200"\s*\]\]/);
  assert.match(postdeploy, /\[\[\s*"\$auth_status"\s*==\s*"401"\s*\]\]/);
  assert.doesNotMatch(postdeploy, /::7|short|cut\s+-c/);
});

test("Fly relies on Docker CMD for app and adds no process override, health route, or build SHA arg", () => {
  assert.match(flyConfig, /processes\s*=\s*\["app"\]/);
  assert.match(flyConfig, /path\s*=\s*"\/api\/docs-json"/);
  assert.doesNotMatch(flyConfig, /^\s*\[processes\]\s*$/m);
  assert.doesNotMatch(flyConfig, /entrypoint\s*=|cmd\s*=/i);
  assert.doesNotMatch(workflow, /--build-arg[^\n]*(?:SHA|COMMIT)/i);
  assert.match(dockerfile, /CMD\s*\["\/entrypoint\.sh"\]/);
  const entrypoint = dockerfile.slice(
    dockerfile.indexOf("# Entrypoint:"),
    dockerfile.indexOf("\nEXPOSE"),
  );
  const migrate = entrypoint.indexOf(
    "npx prisma migrate deploy --schema=prisma/schema.prisma",
  );
  const exec = entrypoint.indexOf("exec node apps/api/dist/main.js");
  assert.ok(migrate >= 0, "entrypoint must run prisma migrate deploy");
  assert.ok(exec > migrate, "entrypoint must migrate before exec node");
  assert.match(
    dockerfile,
    /exec node apps\/api\/dist\/main\.js/,
    "app process must still exec the normal Nest entrypoint",
  );
  assert.doesNotMatch(dockerfile, /^\s*ARG\s+.*(?:SHA|COMMIT)/im);
  assert.doesNotMatch(`${workflow}\n${flyConfig}\n${dockerfile}`, /\/health\b/);
});
