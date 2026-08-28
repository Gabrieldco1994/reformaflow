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
  assert.match(postdeploy, /started/);

  assert.match(
    postdeploy,
    /flyctl\s+checks\s+list[\s\S]{0,1200}(?:machine[_ .-]*id|MachineID|MACHINE_ID)[\s\S]{0,1200}passing[\s\S]{0,500}length[\s\S]{0,200}(?:==\s*1|-eq\s+1)/i,
  );

  assert.match(
    postdeploy,
    /flyctl\s+releases[\s\S]{0,1200}--json[\s\S]{0,1200}\[0\][\s\S]{0,1200}complete/,
  );
  assert.match(
    postdeploy,
    /(?:ImageRef[\s\S]{0,800}config\.image|config\.image[\s\S]{0,800}ImageRef)/,
  );

  assert.match(postdeploy, /\/api\/docs-json/);
  assert.match(postdeploy, /200/);
  assert.match(postdeploy, /\/auth\/me/);
  assert.match(postdeploy, /401/);
  assert.doesNotMatch(postdeploy, /::7|short|cut\s+-c/);
});

test("Fly relies on Docker CMD for app and adds no process override, health route, or build SHA arg", () => {
  assert.match(flyConfig, /processes\s*=\s*\["app"\]/);
  assert.match(flyConfig, /path\s*=\s*"\/api\/docs-json"/);
  assert.doesNotMatch(flyConfig, /^\s*\[processes\]\s*$/m);
  assert.doesNotMatch(flyConfig, /entrypoint\s*=|cmd\s*=/i);
  assert.doesNotMatch(workflow, /--build-arg[^\n]*(?:SHA|COMMIT)/i);
  assert.match(dockerfile, /CMD\s*\["\/entrypoint\.sh"\]/);
  assert.match(
    dockerfile,
    /exec node apps\/api\/dist\/main\.js/,
    "app process must still exec the normal Nest entrypoint",
  );
  assert.doesNotMatch(dockerfile, /^\s*ARG\s+.*(?:SHA|COMMIT)/im);
  assert.doesNotMatch(`${workflow}\n${flyConfig}\n${dockerfile}`, /\/health\b/);
});
