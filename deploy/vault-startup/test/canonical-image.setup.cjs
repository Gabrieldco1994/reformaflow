"use strict";
require("../../../scripts/test-db-env.cjs");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const original = cp.execFileSync;
let imageUpgrades = 0;
const image = process.env.VAULT_STARTUP_IMAGE || "vault-startup:test";
const docker = (...args) =>
  original("docker", args, {
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

// Adapter only: the independent canonical Jest fixture still constructs and asserts all
// legacy rows/FK tuples. Intercept its final deploy, not its seeding or SQL assertions.
jest.spyOn(cp, "execFileSync").mockImplementation((command, args, options) => {
  const schemaIndex = args?.indexOf("--schema");
  const schema = schemaIndex >= 0 ? args[schemaIndex + 1] : undefined;
  if (
    !args?.includes("migrate") ||
    !args.includes("deploy") ||
    !schema?.includes("test-main-import-legacy-orphans-") ||
    fs
      .readdirSync(path.join(path.dirname(schema), "migrations"))
      .filter((n) => /^\d/.test(n)).length !== 76
  ) {
    return original(command, args, options);
  }
  assert.equal(process.platform, "linux");
  const source = options.env.DATABASE_URL.slice("file:".length);
  const guard = require("../../../scripts/test-db-env.cjs");
  assert.equal(guard.forbiddenReason(options.env.DATABASE_URL), null);
  assert.ok(
    path.basename(source).startsWith("test-main-import-legacy-orphans"),
  );
  assert.equal(
    original("sqlite3", [source, "SELECT COUNT(*) FROM _prisma_migrations"], {
      encoding: "utf8",
    }).trim(),
    "69",
  );
  const dir = fs.mkdtempSync(
    path.join(process.env.VAULT_IMAGE_DATA_DIR, "canonical-"),
  );
  const target = path.join(dir, "test.db");
  assert.equal(path.basename(target), "test.db");
  fs.copyFileSync(source, target);
  const name = `vault-canonical-${crypto.randomUUID()}`;
  try {
    docker(
      "run",
      "-d",
      "--name",
      name,
      "--mount",
      `type=bind,src=${dir},dst=/data`,
      "-e",
      "DATABASE_URL=file:/data/test.db",
      "-e",
      "JWT_SECRET=synthetic-canonical-image-not-a-production-secret",
      "-e",
      "IMPORT_VAULT_ENABLED=true",
      "-e",
      "VAULT_DIR=/data/import-vault",
      "-e",
      "IMPORT_VAULT_IDLE_TIMEOUT_MS=10000",
      "-e",
      "IMPORT_VAULT_HEADROOM_BYTES=1048576",
      "-e",
      "IMPORT_VAULT_DRAIN_TIMEOUT_MS=0",
      image,
    );
    const deadline = Date.now() + 60000;
    let healthy = false;
    while (Date.now() < deadline) {
      assert.equal(
        docker("inspect", "-f", "{{.State.Running}}", name),
        "true",
        "canonical actual production entrypoint exited",
      );
      try {
        docker(
          "exec",
          name,
          "curl",
          "-fsS",
          "http://127.0.0.1:3001/api/docs-json",
        );
        healthy = true;
        break;
      } catch {
        /* Poll actual HTTP readiness, never infer it from helper logs. */
      }
    }
    assert.ok(healthy, "canonical actual production entrypoint not healthy");
    assert.match(
      docker("logs", name),
      /vault_startup_gate[\s\S]*?"state": "ON"/,
    );
    assert.equal(
      docker("exec", name, "sh", "-c", 'basename "$(readlink /proc/1/exe)"'),
      "node",
    );
    const runtimeVersion = docker("exec", name, "sqlite3", "--version").split(
      " ",
    )[0];
    const prismaVersion = docker(
      "exec",
      name,
      "node",
      "-e",
      "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();" +
        "p.$queryRawUnsafe('SELECT sqlite_version() AS version').then(r=>console.log(r[0].version)).finally(()=>p.$disconnect());",
    );
    console.log(
      `canonical_production_image sqlite_cli=${runtimeVersion} prisma_engine_sqlite=${prismaVersion}`,
    );
    docker("stop", "--time", "10", name);
    fs.copyFileSync(target, source);
    imageUpgrades++;
    return options.encoding ? "" : Buffer.alloc(0);
  } finally {
    docker("rm", "-f", name);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
afterAll(() => {
  expect(imageUpgrades).toBe(1);
  jest.restoreAllMocks();
});
