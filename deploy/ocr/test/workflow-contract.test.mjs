import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { writeKmsCurlConfig } from "../kms-curl-config.mjs";
const root = resolve(import.meta.dirname, "../../..");
const q = await readFile(
  resolve(root, ".github/workflows/ocr-qualification.yml"),
  "utf8",
);
const a = await readFile(
  resolve(root, ".github/workflows/ocr-activation.yml"),
  "utf8",
);
const runtime = await readFile(
  resolve(root, ".github/workflows/ocr-runtime-subject.yml"),
  "utf8",
);
const recovery = await readFile(
  resolve(root, ".github/workflows/ocr-recovery-evidence.yml"),
  "utf8",
);
const captureAdapter = await readFile(
  resolve(root, "deploy/ocr/wif-adapter.mjs"),
  "utf8",
);
const offlineAdapter = await readFile(
  resolve(root, "deploy/ocr/offline-report-adapter.mjs"),
  "utf8",
);
function section(source, name, next) {
  const start = source.indexOf(`\n  ${name}:`);
  const end = next ? source.indexOf(`\n  ${next}:`, start + 1) : source.length;
  assert.ok(start > 0 && end > start);
  return source.slice(start, end);
}

test("workflow is serialized and capture and KMS capabilities are isolated", () => {
  assert.match(q, /cancel-in-progress: false/);
  const capture = section(q, "capture-vertex", "verify-offline");
  const sign = section(q, "sign-kms");
  assert.match(capture, /GCP_CAPTURE_SERVICE_ACCOUNT/);
  assert.doesNotMatch(capture, /GCP_SIGNING_SERVICE_ACCOUNT|asymmetricSign/);
  assert.match(sign, /GCP_SIGNING_SERVICE_ACCOUNT|GCP_SIGNING_WIF_PROVIDER/);
  assert.doesNotMatch(sign, /GCP_CAPTURE_SERVICE_ACCOUNT|aiplatform/);
  for (const value of [capture, section(q, "verify-offline", "sign-kms")]) {
    assert.match(value, /--read-only/);
    assert.doesNotMatch(value, /docker\.sock|--volume| -v /);
  }
});

test("qualification has no caller subject assertions and all gates precede provider and KMS", () => {
  assert.doesNotMatch(
    q,
    /inputs\.(?:subject|production|backup|legacy|provider)/,
  );
  assert.match(q, /GITHUB_SHA.*GITHUB_WORKFLOW_SHA/);
  assert.match(q, /GITHUB_RUN_ATTEMPT.*1/);
  assert.match(q, /resolve_artifact ocr-runtime-subject\.yml/);
  assert.match(q, /resolve_artifact ocr-recovery-evidence\.yml/);
  assert.match(q, /verify-artifact/);
  assert.ok(
    q.indexOf("Select and verify exact-SHA canonical producer artifacts") <
      q.indexOf("protected-reviews:"),
  );
  assert.ok(
    q.indexOf("protected-reviews:") < q.indexOf("google-github-actions/auth"),
  );
  assert.match(q, /requestedModelAlias/);
  assert.match(q, /promptSha256/);
  assert.match(q, /OCR_REQUESTED_MODEL_ALIAS/);
  assert.doesNotMatch(q, /OCR_PROVIDER_MODEL_VERSION/);
  assert.doesNotMatch(q, /run:[\s\S]{0,300}\$\{\{ inputs\./);
});

test("V4 GAPS assessment is persisted and gates unsigned bytes and KMS", () => {
  const assess = q.indexOf("assess-report -");
  const artifact = q.indexOf("ocr-report-assessment-");
  const gate = q.indexOf(
    "Block signing unless independently recomputed V4 assessment passes",
  );
  const build = q.indexOf("build-unsigned -", assess);
  const signing = q.indexOf("sign-kms:");
  assert.ok(assess > 0 && artifact > assess && gate > artifact);
  assert.ok(build > gate && signing > build);
  assert.match(q, /reportSchemaVersion == 4/);
  assert.match(q, /releaseStatus == .*PASS/);
  assert.match(q, /signable == true/);
});

test("capture and report adapters remain fail closed without product executables", () => {
  assert.match(captureAdapter, /OCR_CAPTURE_WIF_EXECUTABLE_NOT_AVAILABLE/);
  assert.match(offlineAdapter, /OCR_OFFLINE_REPORT_EXECUTABLE_NOT_AVAILABLE/);
  assert.doesNotMatch(captureAdapter, /releaseStatus:\s*"PASS"/);
  assert.doesNotMatch(offlineAdapter, /releaseStatus:\s*"PASS"/);
});

test("unsigned transfer and two exact EC signatures are explicit", () => {
  assert.match(q, /artifact-digest\.mjs create/);
  assert.match(
    q,
    /ocr-unsigned-attestation-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(q, /activation-payload-draft\.json/);
  assert.match(q, /runtime-payload\.json/);
  assert.match(q, /make-runtime-envelope/);
  assert.match(q, /finalize-activation/);
  assert.match(q, /verify-cross-binding/);
  assert.equal((q.match(/asymmetricSign/g) ?? []).length >= 1, true);
  assert.match(q, /curl --config "\$runtime_config"/);
  assert.match(q, /curl --config "\$activation_config"/);
  assert.doesNotMatch(q, /curl[^\n]*Authorization: Bearer/);
  assert.match(
    q,
    /apps\/api\/src\/imports\/import-session\/ocr\/ocr-release-trust\.json/,
  );
  assert.doesNotMatch(q, /deploy\/ocr\/trust/);
});

test("KMS token is written only to a 0600 config and never argv", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kms-config-"));
  const path = join(dir, "curl.conf");
  const token = "secret-token-not-for-argv-123456";
  await writeKmsCurlConfig(
    path,
    {
      requestPath: join(dir, "request.json"),
      responsePath: join(dir, "response.json"),
      endpoint:
        "https://cloudkms.googleapis.com/v1/projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1:asymmetricSign",
    },
    token,
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(await readFile(path, "utf8"), new RegExp(token));
  assert.doesNotMatch(q, new RegExp(token));
});

test("runtime subject producer has no evidence inputs and derives image executable closure", () => {
  assert.match(runtime, /workflow_dispatch:\s*\n\s*permissions:/);
  assert.doesNotMatch(runtime, /workflow_dispatch:[\s\S]{0,100}inputs:/);
  assert.match(runtime, /docker buildx build --provenance=false/);
  assert.equal((runtime.match(/docker buildx build/g) ?? []).length, 1);
  assert.doesNotMatch(runtime, /--build-arg[^\n]*(?:SHA|TREE)/);
  assert.match(runtime, /GH_SHA=\$GITHUB_SHA/);
  assert.match(runtime, /containerimage\.digest/);
  assert.match(
    runtime,
    /docker pull --platform linux\/amd64 "\$IMAGE_REFERENCE"/,
  );
  assert.match(runtime, /resolve-path/);
  assert.match(runtime, /docker cp/);
  assert.match(runtime, /ocr-runtime-subject-v1/);
});

test("recovery producer is protected dormant and sealer requires operation success", () => {
  assert.match(recovery, /workflow_dispatch:\s*\n\s*permissions:/);
  assert.doesNotMatch(recovery, /workflow_dispatch:[\s\S]{0,100}inputs:/);
  assert.match(recovery, /environment: ocr-recovery-operation/);
  assert.match(recovery, /RECOVERY_OPERATION_NOT_EXECUTED/);
  const sealer = section(recovery, "seal-live-evidence");
  assert.match(sealer, /needs: protected-live-operation/);
  assert.match(sealer, /backup-restore-receipt\.json/);
  assert.match(sealer, /legacy-upgrade-receipt\.json/);
  assert.match(sealer, /ocr-recovery-evidence-v1/);
});

test("activation independently verifies pinned artifacts and dormant exact digest deployment", () => {
  assert.doesNotMatch(
    a,
    /expected_production_image|backup_restore_evidence|legacy_upgrade_evidence/,
  );
  assert.match(a, /actions\/artifacts\/\$artifact_id/);
  assert.match(a, /verify-artifact/);
  assert.match(a, /docker pull --platform linux\/amd64/);
  assert.match(a, /runtimeSubjectArtifactSha256/);
  assert.match(a, /recoveryEvidenceArtifactSha256/);
  assert.match(a, /ACTIVATION_BLOCKED_RUNTIME_PROFILE_OFF/);
  assert.match(a, /flyctl deploy[^\n]*--image "\$IMAGE"/);
  assert.match(a, /IMPORT_OCR_ENABLED=false/);
  assert.match(a, /IMPORT_VAULT_ENABLED=false/);
  assert.match(a, /rollback/);
  assert.match(a, /image_ref\.labels\.GH_SHA/);
  assert.match(a, /state == .*started/);
  assert.match(a, /api\/docs-json/);
  assert.match(a, /auth\/me/);
  const deploy = section(a, "deploy-dormant-exact-digest");
  assert.ok(deploy.lastIndexOf("ls-remote") > deploy.indexOf("flyctl deploy"));
});

test("qualification OCI layout intentionally disables provenance", () => {
  assert.match(q, /docker buildx build --provenance=false/);
  assert.equal((q.match(/--provenance=false/g) ?? []).length, 1);
});
