"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const DATABASE_BASENAME = `.tmp-quality-closure-${process.pid}.db`;
const DATABASE_PATH = path.join(REPO_ROOT, "prisma", DATABASE_BASENAME);
const DATABASE_URL = `file:${DATABASE_PATH}`;
const ACCESSORY_SUFFIXES = ["", "-journal", "-wal", "-shm"];

module.exports = async () => {
  for (const suffix of ACCESSORY_SUFFIXES) {
    if (fs.existsSync(`${DATABASE_PATH}${suffix}`)) {
      throw new Error(
        `[quality-db] refusing to reuse existing owned path: ${DATABASE_PATH}${suffix}`,
      );
    }
  }

  process.env.TEST_DATABASE_URL = DATABASE_URL;
  process.env.QUALITY_CLOSURE_DATABASE_PATH = DATABASE_PATH;

  // Load the canonical guard only after selecting the private nested-suite DB.
  const guard = require("../../../scripts/test-db-env.cjs");
  if (
    guard.forbiddenReason(DATABASE_URL) !== null ||
    process.env.DATABASE_URL !== DATABASE_URL
  ) {
    throw new Error(
      "[quality-db] disposable database failed safety validation",
    );
  }

  execFileSync(
    process.execPath,
    [
      require.resolve("prisma/build/index.js"),
      "migrate",
      "deploy",
      `--schema=${path.join(REPO_ROOT, "prisma", "schema.prisma")}`,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL },
      stdio: "inherit",
    },
  );
};
