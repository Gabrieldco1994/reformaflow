"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PRISMA_ROOT = path.join(REPO_ROOT, "prisma");
const OWNED_BASENAME = /^\.tmp-quality-closure-[1-9][0-9]*\.db$/;
const ACCESSORY_SUFFIXES = ["", "-journal", "-wal", "-shm"];

module.exports = async () => {
  const databasePath = process.env.QUALITY_CLOSURE_DATABASE_PATH;
  if (
    !databasePath ||
    path.dirname(databasePath) !== PRISMA_ROOT ||
    !OWNED_BASENAME.test(path.basename(databasePath))
  ) {
    throw new Error("[quality-db] refusing teardown for an unowned database");
  }

  for (const suffix of ACCESSORY_SUFFIXES) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }
};
