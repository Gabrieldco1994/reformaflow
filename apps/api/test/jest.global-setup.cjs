"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * globalSetup do jest: aplica a trava de banco e prepara o SQLite descartável
 * pelo script canônico antes que qualquer suíte importe o PrismaClient.
 * A aplicação por worker fica em `setupFiles` (ver apps/api/package.json).
 */
const guard = require("../../../scripts/test-db-env.cjs");

module.exports = async () => {
  execFileSync(
    process.execPath,
    [path.join(guard.REPO_ROOT, "scripts", "prepare-test-db.mjs")],
    {
      cwd: guard.REPO_ROOT,
      env: process.env,
      stdio: "inherit",
    },
  );
  console.log(
    `[db-guard] DATABASE_URL dos testes: ${process.env.DATABASE_URL}`,
  );
  if (process.env.DATABASE_URL !== guard.TEST_DB_URL) {
    console.log(`[db-guard] (padrão seria ${guard.TEST_DB_URL})`);
  }
};
