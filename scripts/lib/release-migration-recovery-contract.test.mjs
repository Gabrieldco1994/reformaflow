import assert from "node:assert/strict";
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

function deployJob() {
  const start = workflow.indexOf("\n  deploy-api:");
  assert.notEqual(start, -1, "deploy-api job is missing");
  return workflow.slice(start);
}

test("deploy remains serialized without cancelling an in-flight release", () => {
  assert.match(deployJob(), /concurrency:[\s\S]*?cancel-in-progress:\s*false/);
});

test("a full-SHA stale-run gate precedes flyctl deploy", () => {
  const job = deployJob();
  const gate = job.search(/git ls-remote[\s\S]*?refs\/heads\/main/);
  const deploy = job.indexOf("flyctl deploy");

  assert.ok(gate >= 0, "missing remote main SHA gate");
  assert.ok(deploy > gate, "stale-run gate must execute before flyctl deploy");
  assert.match(
    job.slice(gate, deploy),
    /GITHUB_SHA|\$\{\{\s*github\.sha\s*\}\}/,
  );
  assert.doesNotMatch(job.slice(gate, deploy), /::7|short|cut\s+-c/);
});

test("postdeploy verifies exactly one started machine, HTTP contracts, and full SHA", () => {
  const job = deployJob();
  const deploy = job.indexOf("flyctl deploy");
  const postdeploy = job.slice(deploy + "flyctl deploy".length);

  assert.match(postdeploy, /flyctl\s+machines?\s+list[\s\S]*--json/);
  assert.match(postdeploy, /started/);
  assert.match(postdeploy, /==\s*1|-eq\s+1/);
  assert.match(postdeploy, /\/api\/docs-json/);
  assert.match(postdeploy, /200/);
  assert.match(postdeploy, /\/api\/projects/);
  assert.match(postdeploy, /401/);
  assert.match(postdeploy, /GITHUB_SHA|\$\{\{\s*github\.sha\s*\}\}/);
  assert.doesNotMatch(postdeploy, /::7|short|cut\s+-c/);
});

test("Fly keeps the normal app entrypoint and uses docs-json health checks only", () => {
  assert.match(flyConfig, /processes\s*=\s*\["app"\]/);
  assert.match(flyConfig, /path\s*=\s*"\/api\/docs-json"/);
  assert.match(dockerfile, /CMD\s*\["\/entrypoint\.sh"\]/);
  assert.match(
    dockerfile,
    /exec node apps\/api\/dist\/main\.js/,
    "app process must still exec the normal Nest entrypoint",
  );
  assert.doesNotMatch(`${workflow}\n${flyConfig}\n${dockerfile}`, /\/health\b/);
});
