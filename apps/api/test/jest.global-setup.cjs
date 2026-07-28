'use strict';

/**
 * globalSetup do jest: aplica a trava de banco uma vez no processo principal e
 * imprime o alvo, para ficar visível que a suíte NÃO está usando o dev.db.
 * A aplicação por worker fica em `setupFiles` (ver apps/api/package.json).
 */
const guard = require('../../../scripts/test-db-env.cjs');

module.exports = async () => {
  console.log(`[db-guard] DATABASE_URL dos testes: ${process.env.DATABASE_URL}`);
  if (process.env.DATABASE_URL !== guard.TEST_DB_URL) {
    console.log(`[db-guard] (padrão seria ${guard.TEST_DB_URL})`);
  }
};
