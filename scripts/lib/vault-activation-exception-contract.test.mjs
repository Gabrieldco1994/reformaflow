import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const AUDITOR = join(ROOT, "scripts", "audit-vault-fk-baseline.mjs");
const LAUNCHER =
  process.env.VAULT_LAUNCHER_UNDER_TEST ??
  join(ROOT, "deploy", "vault-startup", "run-fk-baseline-audit.sh");
const RUNBOOK = join(ROOT, "deploy", "vault-startup", "README.md");
const LOCK_OWNER_VERIFIER = join(
  ROOT,
  "deploy",
  "vault-startup",
  "verify-api-lock-owner.mjs",
);
const PACKAGE = join(ROOT, "package.json");
const AGENTS = join(ROOT, "AGENTS.md");
const DB_CHECK = join(ROOT, "scripts", "db-check.mjs");
const WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");
const MACHINE_WAITER = join(ROOT, "scripts", "ci", "wait-for-fly-machine.sh");
const DISABLED = join(
  ROOT,
  "apps",
  "api",
  "src",
  "imports",
  "import-session",
  "import-session.disabled.ts",
);
const SCHEMA = join(ROOT, "prisma", "schema.prisma");
const MIGRATIONS = join(ROOT, "prisma", "migrations");
const API_SOURCE = join(ROOT, "apps", "api", "src");
const DOMAIN = join(ROOT, "packages", "domain", "src");
const QUIESCE = join(ROOT, "deploy", "quiesce");
const PACKAGE_LOCK = join(ROOT, "package-lock.json");
const REPAIR = join(ROOT, "scripts", "repair-legacy-fk-integrity.mjs");
const REPAIR_TEST = join(
  ROOT,
  "scripts",
  "lib",
  "repair-legacy-fk-integrity.test.mjs",
);

const BASELINE_HASHES = Object.freeze({
  dbCheck: "9c1269036c0e07b5f9e1552c42daf1e9bacf2c328b2218c35b601a2016e52e03",
  disabled: "9b623545824d76db802fb3f919c97046f305657ddba55d7795db1f7c6a59eac3",
  schema: "c2b5d1a1da68703122d106ae2919ec2cae46384c8a9658e6975c132a447f7bf4",
  migrations:
    "195663b4b97762841e059b820350d50e0a79f682d276152e02a57b6cbaf212c3",
  apiSource: "1348c6bf3330b260fbb578704a21b4e6868e27a748c56d1d92f9eb528237429a",
  domain: "4a4f783d64211f98b562883aa4c4494d76dcde54c73c3a7515fdc552ee3c5db2",
  quiesce: "9b5d7783fe75cd285ce72cda2e000a36b9059967660fb5af35745e4d89595356",
  packageLock:
    "53c64b293bde1a96dae5527773468096ebb41a00dceb7441b77bd1a2833fe105",
  repair: "7f81b56ebde232eae1c50a1d581783e5bf1bf82698670b820cf3405b722b2586",
  repairTest:
    "fa231dbdc76f9bc07697fe1147a592f6cb9cd61fe0e6e131029fe645c91e6734",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function directoryDigest(directory) {
  const files = [];
  function walk(current) {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(path);
    }
  }
  walk(directory);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(directory, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const BYTE_PINNED_SCOPES = Object.freeze([
  DB_CHECK,
  DISABLED,
  SCHEMA,
  MIGRATIONS,
  API_SOURCE,
  DOMAIN,
  QUIESCE,
  PACKAGE_LOCK,
  REPAIR,
  REPAIR_TEST,
]);

function matchingBytePinnedScopes(candidate) {
  return BYTE_PINNED_SCOPES.map((scope) => relative(ROOT, scope)).filter(
    (scope) => candidate === scope || candidate.startsWith(`${scope}/`),
  );
}

function assertPathIsNotBytePinned(candidate) {
  assert.deepEqual(
    matchingBytePinnedScopes(candidate),
    [],
    `${candidate} is byte-pinned`,
  );
}

function deployJob(workflow) {
  const marker = "  deploy-api:";
  const start = workflow.indexOf(`\n${marker}`);
  assert.notEqual(start, -1, "deploy-api job is missing");

  const jobStart = start + 1;
  const afterMarker = jobStart + marker.length;
  const nextJob = workflow
    .slice(afterMarker)
    .search(/\n  [A-Za-z0-9_-]+:\s*(?:\n|$)/);
  const end = nextJob === -1 ? workflow.length : afterMarker + nextJob;
  return workflow.slice(jobStart, end);
}

const WORKFLOW_DEPLOY_GUARANTEES = Object.freeze([
  ["push-only trigger", /github\.event_name\s*==\s*'push'\s*&&/],
  ["main-only trigger", /&&\s*github\.ref\s*==\s*'refs\/heads\/main'/],
  ["deploy concurrency group", /^\s+group:\s*deploy-api\s*$/m],
  ["in-flight deploy retention", /^\s+cancel-in-progress:\s*false\s*$/m],
  [
    "current main lookup",
    /current_main="\$\(git ls-remote --exit-code origin refs\/heads\/main \| awk '\{print \$1\}'\)"/,
  ],
  ["predeploy full SHA", /!\s*"\$GITHUB_SHA"\s*=~\s*\^\[0-9a-f\]\{40\}\$/],
  [
    "predeploy current-main equality",
    /\[\[\s*"\$GITHUB_SHA"\s*!=\s*"\$current_main"\s*\]\]/,
  ],
  ["Fly config", /-c apps\/api\/fly\.toml(?:\s|$)/],
  ["API Dockerfile", /--dockerfile apps\/api\/Dockerfile(?:\s|$)/],
  ["remote builder", /--remote-only(?:\s|$)/],
  [
    "machine convergence guard",
    /FLY_APP="\$app" EXPECTED_GH_SHA="\$GITHUB_SHA" \\\s*\n\s+timeout --signal=TERM --kill-after=15s 330s scripts\/ci\/wait-for-fly-machine\.sh/,
  ],
  [
    "exactly one passing check",
    /has\(\$id\) and \(\.\[\$id\] \| length == 1\) and \(\.\[\$id\]\[0\]\.status == "passing"\)/,
  ],
  ["complete release", /\[\[\s*"\$release_status"\s*==\s*"complete"\s*\]\]/],
  [
    "machine image normalization",
    /machine_image_without_digest="\$\{machine_image%%@\*\}"/,
  ],
  [
    "release-machine image equality",
    /\[\[\s*"\$release_image"\s*==\s*"\$machine_image_without_digest"\s*\]\]/,
  ],
  ["docs probe", /https:\/\/reformaflow-api\.fly\.dev\/api\/docs-json/],
  ["docs 200", /\[\[\s*"\$docs_status"\s*==\s*"200"\s*\]\]/],
  ["auth probe", /https:\/\/reformaflow-api\.fly\.dev\/auth\/me/],
  ["auth 401", /\[\[\s*"\$auth_status"\s*==\s*"401"\s*\]\]/],
  [
    "postdeploy main lookup",
    /postdeploy_main="\$\(git ls-remote --exit-code origin refs\/heads\/main \| awk '\{print \$1\}'\)"/,
  ],
  [
    "postdeploy current-main equality",
    /\[\[\s*"\$GITHUB_SHA"\s*!=\s*"\$postdeploy_main"\s*\]\]/,
  ],
]);

const MACHINE_WAITER_GUARANTEES = Object.freeze([
  ["exactly one machine", /\[\[\s*"\$count"\s*==\s*"1"\s*\]\]/],
  ["started machine", /"\$machine_state"\s*==\s*"started"/],
  ["deployed full SHA", /"\$deployed_sha"\s*==\s*"\$EXPECTED_GH_SHA"/],
]);

function assertDeployGuarantees(workflow, machineWaiter) {
  const job = deployJob(workflow);
  for (const [name, pattern] of WORKFLOW_DEPLOY_GUARANTEES)
    assert.match(job, pattern, name);
  for (const [name, pattern] of MACHINE_WAITER_GUARANTEES)
    assert.match(machineWaiter, pattern, name);

  const condition = job.slice(
    job.indexOf("\n    if:"),
    job.indexOf("\n    concurrency:"),
  );
  assert.doesNotMatch(
    condition,
    /\|\|\s*github\.(?:event_name|ref)|pull_request|refs\/heads\/develop/,
    "deploy must not broaden beyond pushes to main",
  );
  assert.equal(
    job.match(/^\s*run: flyctl deploy\b/gm)?.length,
    1,
    "expected one Fly deploy command",
  );
  const ordered = [
    "current_main=",
    "run: flyctl deploy",
    "scripts/ci/wait-for-fly-machine.sh",
    "flyctl checks list",
    "flyctl releases",
    "docs_status=",
    "auth_status=",
    "postdeploy_main=",
  ].map((fragment) => job.indexOf(fragment));
  assert.ok(
    ordered.every(
      (position, index) =>
        position >= 0 && (index === 0 || position > ordered[index - 1]),
    ),
    "deploy gates, checks, smokes, and final stale gate must remain ordered",
  );
}

function replaceExactlyOnce(source, expected, replacement) {
  assert.equal(
    source.split(expected).length - 1,
    1,
    `mutation fixture must occur once: ${expected}`,
  );
  return source.replace(expected, replacement);
}

test("production launcher is a narrow fixed-path capture/compare checksum gate", () => {
  const source = readFileSync(LAUNCHER, "utf8");
  const auditorBytes = readFileSync(AUDITOR);
  const checksum = source.match(
    /^readonly AUDITOR_SHA256='([0-9a-f]{64})'$/m,
  )?.[1];
  assert.equal(checksum, sha256(auditorBytes));
  assert.match(
    source,
    /^readonly AUDITOR='\/app\/audit-vault-fk-baseline\.mjs'$/m,
  );
  assert.match(source, /^readonly DATABASE='\/data\/dev\.db'$/m);
  assert.match(
    source,
    /^readonly MANIFEST='\/data\/vault-fk-baseline\.private\.json'$/m,
  );
  assert.match(
    source,
    /^readonly AUTHORIZATION='\/data\/vault-fk-baseline\.authorization\.json'$/m,
  );
  assert.match(source, /^readonly MOUNT_ROOT='\/data'$/m);
  assert.match(source, /sha256sum/);
  assert.match(source, /findmnt[\s\S]*ext4/);
  assert.match(source, /VAULT_FK_RELEASE_ID/);
  assert.match(source, /VAULT_FK_AUTHORIZATION_SHA256/);
  assert.match(source, /capture\|compare/);
  assert.doesNotMatch(source, /\beval\b|sqlite3|prisma|migrate|apply|repair/);
  assert.doesNotMatch(source, /\$\{@:|\$\*|DATABASE_URL/);

  for (const args of [
    [],
    ["apply"],
    ["capture", "/tmp/other.db"],
    ["compare", "--sql", "SELECT 1"],
  ]) {
    const result = spawnSync("sh", [LAUNCHER, ...args], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 64, `launcher accepted: ${args.join(" ")}`);
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /\/data\/|\/app\//,
    );
  }
});

test("runbook documents only the exact one-window preservation exception and review-only QA", () => {
  const runbook = readFileSync(RUNBOOK, "utf8");
  for (const required of [
    /foreign_key_check\s*=\s*0/i,
    /28[\s\S]{0,120}rooms[\s\S]{0,120}projects/i,
    /4[\s\S]{0,120}cash_flow_entries[\s\S]{0,120}expenses/i,
    /32/,
    /byte[- ](?:identical|idêntic)/i,
    /flag[^.\n]*OFF/i,
    /capture/i,
    /compare/i,
    /cleanup/i,
    /release SHA/i,
    /image digest/i,
    /authorization/i,
    /window/i,
    /four hours/i,
    /consumed/i,
    /deny\/flag network guard/i,
    /READY/,
    /challenge/,
    /confirm/,
    /execute/,
  ]) {
    assert.match(runbook, required);
  }
  assert.match(
    runbook,
    /review-only[\s\S]{0,500}READY[\s\S]{0,500}(?:never|nunca)[\s\S]{0,300}challenge[\s\S]{0,200}confirm[\s\S]{0,200}execute/i,
  );
  assert.match(
    runbook,
    /READY[\s\S]{0,300}proposal[^.\n]*non-null[\s\S]{0,300}confirmation[^.\n]*receipt[^.\n]*null[\s\S]{0,300}never[\s\S]{0,100}APPLIED/i,
  );
  assert.match(
    runbook,
    /no financial-table[\s\S]{0,150}UserActivityLog[\s\S]{0,100}execute/i,
  );
  assert.match(
    runbook,
    /(?:prohibit|proib)[\s\S]{0,300}(?:repair|reparo)[\s\S]{0,300}(?:raw SQLite|SQLite bruto)[\s\S]{0,300}migration/i,
  );
  assert.match(runbook, /IMPORT_SESSION_WRITES_ENABLED[\s\S]{0,100}false/);
});

test("Fly API lock owner verifier is fixed-purpose, read-only, and fail-closed", () => {
  const source = readFileSync(LOCK_OWNER_VERIFIER, "utf8");
  for (const required of [
    /const PROC_ROOT = "\/proc"/,
    /const INIT_EXE = "\/fly\/init"/,
    /const NODE_EXE = "\/usr\/local\/bin\/node"/,
    /Buffer\.from\("node\\0apps\/api\/dist\/main\.js\\0"\)/,
    /const API_CWD = "\/app"/,
    /const LOCK_FD = 9/,
    /const LOCK_PATH = "\/data\/import-vault\/\.lock"/,
    /\/1\/task\/1\/children/,
    /CANDIDATE_COUNT/,
    /CHILD_SET_CHANGED/,
    /CANDIDATE_CHANGED/,
    /LOCK_CHANGED/,
  ]) {
    assert.match(source, required);
  }
  assert.doesNotMatch(source, /process\.env|\/environ\b|node:child_process/);
  assert.doesNotMatch(
    source,
    /\bspawn(?:Sync)?\b|process\.kill|setTimeout|setInterval/,
  );
  assert.doesNotMatch(
    source,
    /\b(?:writeFile|appendFile|truncate|unlink|rename|mkdir|chmod|chown|open)\w*Sync\b/,
  );

  const unsupported = spawnSync(
    process.execPath,
    [LOCK_OWNER_VERIFIER, "--proc", "/tmp/proc"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(unsupported.status, 1);
  assert.equal(unsupported.stdout, "state=DENIED reason=UNSUPPORTED_ARGS\n");
  assert.equal(unsupported.stderr, "");
  assert.doesNotMatch(unsupported.stdout, /\/proc|\/data|cmdline|fdinfo/);
});

test("runbook distinguishes Fly init from the retained unwrapped Docker PID1 proof", () => {
  const runbook = readFileSync(RUNBOOK, "utf8");
  assert.match(
    runbook,
    /2026-10-13[\s\S]{0,500}PID1 was `\/fly\/init`[\s\S]{0,300}direct API child was PID 643/i,
  );
  assert.match(
    runbook,
    /restored the vault to \*\*OFF\*\*[\s\S]{0,200}no financial writes/i,
  );
  assert.match(
    runbook,
    /unwrapped Docker[\s\S]{0,200}API PID1[\s\S]{0,300}Fly[\s\S]{0,100}`\/fly\/init`[\s\S]{0,200}direct child/i,
  );
  assert.match(
    runbook,
    /unwrapped Docker API-as-PID1\/FD9 Linux proof[\s\S]{0,200}retains the Docker topology/i,
  );
  assert.match(
    runbook,
    /verify-api-lock-owner\.mjs[\s\S]{0,500}exactly one direct child[\s\S]{0,700}FD9[\s\S]{0,300}WRITE\s+flock/i,
  );
  assert.doesNotMatch(runbook, /PID1 is the API, `\/proc\/1\/fd\/9`/);
});

test("global scar keeps FK checks strict outside this vault activation", () => {
  const agents = readFileSync(AGENTS, "utf8");
  assert.match(
    agents,
    /PO[\s\S]{0,300}(?:retained|reteve|preserv)[\s\S]{0,300}28[\s\S]{0,120}4[\s\S]{0,120}32/i,
  );
  assert.match(
    agents,
    /(?:only|únic)[\s\S]{0,300}vault activation[\s\S]{0,300}(?:global|globais)[\s\S]{0,300}(?:strict|estrit)/i,
  );
});

test("migration-recovery adds both exception suites without changing db:check or precommit", () => {
  const pkg = JSON.parse(readFileSync(PACKAGE, "utf8"));
  assert.equal(pkg.scripts["db:check"], "node scripts/db-check.mjs");
  assert.equal(
    pkg.scripts["pre-commit"],
    "npm run db:check && cd packages/domain && npx tsc --noEmit && cd ../../apps/api && npx tsc --noEmit && cd ../../apps/web && npx tsc --noEmit",
  );
  assert.match(
    pkg.scripts["test:migration-recovery"],
    /scripts\/lib\/audit-vault-fk-baseline\.test\.mjs/,
  );
  assert.match(
    pkg.scripts["test:migration-recovery"],
    /scripts\/lib\/vault-activation-exception-contract\.test\.mjs/,
  );
  assert.match(
    pkg.scripts["test:migration-recovery"],
    /deploy\/vault-startup\/test\/production-qa-guard\.test\.mjs/,
  );
  assert.match(
    pkg.scripts["test:migration-recovery"],
    /deploy\/vault-startup\/test\/api-lock-owner-proof\.test\.mjs/,
  );
});

test("byte-pin scope permits frontend changes but retains vault controls", () => {
  assert.doesNotThrow(() =>
    assertPathIsNotBytePinned(
      "apps/web/src/app/projects/project/maria/ImportConversationBody.tsx",
    ),
  );
  assert.doesNotThrow(() =>
    assertPathIsNotBytePinned(".github/workflows/ci.yml"),
  );
  assert.deepEqual(
    matchingBytePinnedScopes(
      "apps/api/src/imports/import-session/vault/vault-storage.ts",
    ),
    ["apps/api/src"],
  );
  assert.throws(
    () =>
      assertPathIsNotBytePinned(
        "apps/api/src/imports/import-session/vault/vault-storage.ts",
      ),
    /apps\/api\/src\/imports\/import-session\/vault\/vault-storage\.ts is byte-pinned/,
  );
});

test("CI deploy keeps every release and stale-main guarantee without a whole-file pin", () => {
  assertDeployGuarantees(
    readFileSync(WORKFLOW, "utf8"),
    readFileSync(MACHINE_WAITER, "utf8"),
  );
});

test("an unrelated path-aware detection job can evolve without changing deploy guarantees", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const detector = `
  detect-path-scope:
    name: Detect Path Scope
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: scripts/ci/api-deploy-required.sh
`;
  const evolved = replaceExactlyOnce(
    workflow,
    "\n  deploy-api:",
    `${detector}\n  deploy-api:`,
  );

  assert.notEqual(sha256(evolved), sha256(workflow));
  assertDeployGuarantees(evolved, readFileSync(MACHINE_WAITER, "utf8"));
});

test("every critical deploy guarantee rejects a weakening mutation", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const machineWaiter = readFileSync(MACHINE_WAITER, "utf8");

  for (const [target, source, guarantees] of [
    ["workflow", workflow, WORKFLOW_DEPLOY_GUARANTEES],
    ["machine waiter", machineWaiter, MACHINE_WAITER_GUARANTEES],
  ]) {
    for (const [name, pattern] of guarantees) {
      const match = source.match(pattern);
      assert.ok(match, `${target} mutation fixture is missing: ${name}`);
      const weakened = source.replace(match[0], "");
      const mutatedWorkflow = target === "workflow" ? weakened : workflow;
      const mutatedWaiter =
        target === "machine waiter" ? weakened : machineWaiter;
      assert.throws(
        () => assertDeployGuarantees(mutatedWorkflow, mutatedWaiter),
        `${name} removal unexpectedly passed`,
      );
    }
  }

  const mainTrigger = workflow.match(/github\.ref\s*==\s*'refs\/heads\/main'/);
  assert.ok(mainTrigger, "main trigger mutation fixture is missing");
  const broadenedTrigger = workflow.replace(
    mainTrigger[0],
    `${mainTrigger[0]} || github.event_name == 'pull_request'`,
  );
  assert.throws(
    () => assertDeployGuarantees(broadenedTrigger, machineWaiter),
    "pull-request deploy trigger unexpectedly passed",
  );
});

test("security-relevant application, data, recovery, and global checks are byte-unchanged", () => {
  assert.equal(sha256(readFileSync(DB_CHECK)), BASELINE_HASHES.dbCheck);
  assert.equal(sha256(readFileSync(DISABLED)), BASELINE_HASHES.disabled);
  assert.equal(sha256(readFileSync(SCHEMA)), BASELINE_HASHES.schema);
  assert.equal(directoryDigest(MIGRATIONS), BASELINE_HASHES.migrations);
  assert.equal(directoryDigest(API_SOURCE), BASELINE_HASHES.apiSource);
  assert.equal(directoryDigest(DOMAIN), BASELINE_HASHES.domain);
  assert.equal(directoryDigest(QUIESCE), BASELINE_HASHES.quiesce);
  assert.equal(sha256(readFileSync(PACKAGE_LOCK)), BASELINE_HASHES.packageLock);
  assert.equal(sha256(readFileSync(REPAIR)), BASELINE_HASHES.repair);
  assert.equal(sha256(readFileSync(REPAIR_TEST)), BASELINE_HASHES.repairTest);
  assert.match(
    readFileSync(DISABLED, "utf8"),
    /IMPORT_SESSION_WRITES_ENABLED\s*=\s*false/,
  );
});
