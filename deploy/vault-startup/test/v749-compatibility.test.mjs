import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CompatibilityProofError,
  captureCompatibilityManifest,
  compareCompatibilityManifest,
} from "../v749-db-manifest.mjs";
import { simulateV749Bootstrap } from "./v749-bootstrap.fixture.mjs";

const RUNBOOK = fileURLToPath(new URL("../README.md", import.meta.url));
const LAUNCHER = fileURLToPath(
  new URL("../run-v749-compatibility.sh", import.meta.url),
);
const TOOL = fileURLToPath(new URL("../v749-db-manifest.mjs", import.meta.url));
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function runSqlite(database, sql) {
  const result = spawnSync("sqlite3", [database], {
    encoding: "utf8",
    input: sql,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rf-v749-compat-"));
  directories.push(directory);
  const database = join(directory, "current.db");
  runSqlite(
    database,
    `PRAGMA journal_mode=DELETE;
     CREATE TABLE tenants (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     );
     CREATE TABLE users (
       id TEXT PRIMARY KEY,
       tenant_id TEXT NOT NULL,
       username TEXT NOT NULL,
       email TEXT,
       name TEXT NOT NULL,
       role TEXT NOT NULL,
       password_hash TEXT,
       allowed_modules TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       FOREIGN KEY (tenant_id) REFERENCES tenants(id)
     );
     CREATE UNIQUE INDEX users_tenant_username ON users(tenant_id, username);
     INSERT INTO tenants VALUES (char(116,101,110,97,110,116,45,49), char(81,65), 1, 1);
     INSERT INTO users VALUES (
       char(101,120,105,115,116,105,110,103,45,97,100,109,105,110),
       char(116,101,110,97,110,116,45,49),
       char(101,120,105,115,116,105,110,103), NULL,
       char(69,120,105,115,116,105,110,103), char(65,68,77,73,78),
       char(104,97,115,104), char(91,93), 1, 1
     );`,
  );
  chmodSync(database, 0o600);
  return {
    database,
    preManifest: join(directory, "pre.private.json"),
    postManifest: join(directory, "post.private.json"),
    receipt: join(directory, "receipt.private.json"),
    sqliteBinary: "sqlite3",
  };
}

function userCount(database) {
  return Number(runSqlite(database, "SELECT count(*) FROM users;"));
}

function syntheticUserShape(database) {
  return runSqlite(
    database,
    `SELECT role || char(124) || (email IS NULL) || char(124) ||
            (password_hash IS NOT NULL) || char(124) || allowed_modules ||
            char(124) || created_at || char(124) || updated_at
       FROM users
      WHERE username=char(114,101,115,116,111,114,101,45,99,111,110,116,114,111,108);`,
  );
}

function cleanEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !["ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_EMAIL"].includes(name),
    ),
  );
}

test("v749 omitted bootstrap variables preserve rows, schema, header and file bytes", () => {
  const options = fixture();
  const before = captureCompatibilityManifest(options);
  const result = simulateV749Bootstrap({
    database: options.database,
    env: {},
  });
  assert.deepEqual(result, { inserted: false });
  assert.equal(userCount(options.database), 1);
  const after = compareCompatibilityManifest(options);
  assert.deepEqual(after, before);
  assert.equal(statSync(options.preManifest).mode & 0o777, 0o600);
  assert.equal(statSync(options.postManifest).mode & 0o777, 0o600);
  assert.equal(statSync(options.receipt).mode & 0o777, 0o600);
});

test("v749 synthetic bootstrap variables reproduce the prior user mutation", () => {
  const options = fixture();
  captureCompatibilityManifest(options);
  const result = simulateV749Bootstrap({
    database: options.database,
    env: {
      ADMIN_USERNAME: "restore-control",
      ADMIN_PASSWORD: "synthetic-control-only",
    },
  });
  assert.deepEqual(result, { inserted: true });
  assert.equal(userCount(options.database), 2);
  assert.equal(
    syntheticUserShape(options.database),
    "ADMIN|1|1|[]|1791927101854|1791927101854",
  );
  assert.throws(
    () => compareCompatibilityManifest(options),
    (error) =>
      error instanceof CompatibilityProofError &&
      error.code === "DATABASE_MUTATED",
  );
  assert.equal(existsSync(options.postManifest), true);
  assert.equal(existsSync(options.receipt), false);
});

test("compatibility launcher rejects every bootstrap variable before boot", () => {
  const environment = cleanEnvironment();
  const clean = spawnSync("sh", [LAUNCHER, "check"], {
    encoding: "utf8",
    env: environment,
  });
  assert.equal(clean.status, 0, clean.stderr);

  for (const name of ["ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_EMAIL"]) {
    const denied = spawnSync("sh", [LAUNCHER, "check"], {
      encoding: "utf8",
      env: { ...environment, [name]: "" },
    });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /admin bootstrap environment present/);
    assert.doesNotMatch(denied.stderr, /restore-control|synthetic-control/);
  }
});

test("launcher pins the manifest tool and exact v749 entrypoint", () => {
  const launcher = readFileSync(LAUNCHER, "utf8");
  const tool = readFileSync(TOOL);
  const expected = createHash("sha256").update(tool).digest("hex");
  assert.match(
    launcher,
    new RegExp('^readonly TOOL_SHA256="' + expected + '"$', "m"),
  );
  assert.match(launcher, /exec \/entrypoint\.sh$/m);
  assert.doesNotMatch(launcher, /unset ADMIN_/);
});

test("runbook omits admin bootstrap variables and requires exact pre/post proof", () => {
  const runbook = readFileSync(RUNBOOK, "utf8");
  const start = runbook.indexOf(
    "#### Exact v749 no-mutation compatibility procedure",
  );
  const end = runbook.indexOf("## Separate activation sequence", start);
  assert.ok(start >= 0 && end > start);
  const procedure = runbook.slice(start, end);
  assert.match(
    procedure,
    /env -u ADMIN_USERNAME -u ADMIN_PASSWORD -u ADMIN_EMAIL/,
  );
  assert.doesNotMatch(procedure, /--env ADMIN_(?:USERNAME|PASSWORD|EMAIL)/);
  assert.match(procedure, /run-v749-compatibility\.sh capture/);
  assert.match(procedure, /run-v749-compatibility\.sh compare/);
  assert.match(procedure, /v749-compatibility\.consumed\.private\.json/);
});
