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
  workflow: "fcb8ab9589bc68818136983ab0d6b8c361e721a75429f75702ecfcaae071d7cd",
  disabled: "9b623545824d76db802fb3f919c97046f305657ddba55d7795db1f7c6a59eac3",
  schema: "a5f0b8d064d897b0faa8dabc7d9df5a93ad006d82900cb5c69e4500146294e7c",
  migrations:
    "ac567bf705b1bd4eed0d2b9ad5c1a4ed92ab13c50aa69890123e4488f03f8497",
  apiSource: "dc0ecd2df1893ce0f46eb9af5c07ccb1280c927c79015b752e299d70c61702ae",
  domain: "12b8b398de8cb9f4738ed16f2ae49917c2eccc84f8b56425690f3d1d0dbd3ac7",
  quiesce: "9b5d7783fe75cd285ce72cda2e000a36b9059967660fb5af35745e4d89595356",
  packageLock:
    "7d8e1a05a6bc56a061e2dceaee620e4f5398bc8254693d5a2f901d0c0f1b7f58",
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
  WORKFLOW,
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

test("security-relevant application, data, recovery, and global checks are byte-unchanged", () => {
  assert.equal(sha256(readFileSync(DB_CHECK)), BASELINE_HASHES.dbCheck);
  assert.equal(sha256(readFileSync(WORKFLOW)), BASELINE_HASHES.workflow);
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
