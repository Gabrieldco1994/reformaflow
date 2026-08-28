import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

test("deploy remains serialized, gates stale SHA immediately before deploy, then validates Fly state", async () => {
  const workflow = await readFile(
    path.join(root, ".github/workflows/ci.yml"),
    "utf8",
  );
  const staleGate = workflow.indexOf("Reject stale main deploy");
  const deploy = workflow.indexOf("flyctl deploy");
  const postdeploy = workflow.indexOf("Validate deployed Fly machine");

  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.ok(staleGate > 0 && staleGate < deploy);
  assert.ok(postdeploy > deploy);
  assert.match(workflow, /git fetch --no-tags origin main/);
  assert.match(workflow, /refs\/remotes\/origin\/main/);
  assert.match(workflow, /GITHUB_SHA/);
  assert.match(workflow, /machines list/);
  assert.match(workflow, /state.*started/);
  assert.match(workflow, /image_ref\.labels\.GH_SHA/);
  assert.match(workflow, /checks list/);
  assert.match(workflow, /checks_total.*-eq 1/);
  assert.match(workflow, /checks_passing.*-eq 1/);
  assert.match(workflow, /releases/);
  assert.match(workflow, /complete/);
  assert.match(workflow, /ImageRef/);
  assert.match(workflow, /config\.image/);
  assert.match(workflow, /api\/docs-json/);
  assert.match(workflow, /auth\/me/);
  assert.match(workflow, /401/);
  assert.doesNotMatch(workflow, /--metadata/);
  assert.doesNotMatch(workflow, /--build-arg/);
});

test("Fly app keeps the normal Docker entrypoint without a process command override", async () => {
  const config = await readFile(path.join(root, "apps/api/fly.toml"), "utf8");
  const dockerfile = await readFile(
    path.join(root, "apps/api/Dockerfile"),
    "utf8",
  );
  assert.doesNotMatch(config, /\[processes\]/);
  assert.match(config, /processes\s*=\s*\["app"\]/);
  assert.match(dockerfile, /CMD\s+\["\/entrypoint\.sh"\]/);
  assert.match(config, /path\s*=\s*"\/api\/docs-json"/);
  assert.doesNotMatch(config, /\/health/);
});
