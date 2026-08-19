"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * globalSetup do jest: aplica a trava de banco e prepara o SQLite descartável
 * pelo script canônico antes que qualquer suíte importe o PrismaClient.
 * A aplicação por worker fica em `setupFiles` (ver apps/api/package.json).
 *
 * Roda no processo principal, onde `JEST_WORKER_ID` não existe — portanto a
 * trava aponta para o TEMPLATE (`prisma/test.db`), que é o que precisa receber
 * as migrations. Depois disso o template é copiado uma vez por worker (#486):
 * com um banco por worker, dois specs que compartilham o mesmo módulo de
 * fixture deixam de se apagar mutuamente em paralelo.
 */
const guard = require("../../../scripts/test-db-env.cjs");

module.exports = async (globalConfig) => {
  // Se alguém rodar jest-dentro-de-jest, o filho herdaria JEST_WORKER_ID e
  // migraria o banco do worker em vez do template. Fail-safe explícito.
  const childEnv = { ...process.env };
  delete childEnv.JEST_WORKER_ID;

  execFileSync(
    process.execPath,
    [path.join(guard.REPO_ROOT, "scripts", "prepare-test-db.mjs")],
    {
      cwd: guard.REPO_ROOT,
      env: childEnv,
      stdio: "inherit",
    },
  );

  const stale = guard.cleanWorkerDatabases();
  const workerCount = Math.max(1, Number(globalConfig?.maxWorkers) || 1);
  guard.provisionWorkerDatabases(workerCount);

  console.log(`[db-guard] template dos testes: ${guard.TEST_DB_URL}`);
  console.log(
    `[db-guard] ${workerCount} banco(s) por worker provisionado(s) como ` +
      `prisma/${guard.WORKER_DB_PREFIX}<id>.db` +
      (stale.length
        ? ` (${stale.length} arquivo(s) obsoleto(s) removido(s))`
        : ""),
  );
  if (process.env.DATABASE_URL !== guard.TEST_DB_URL) {
    console.log(`[db-guard] (padrão seria ${guard.TEST_DB_URL})`);
  }
};
