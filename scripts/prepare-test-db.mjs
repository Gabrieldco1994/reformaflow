#!/usr/bin/env node
/**
 * Cria/atualiza o SQLite descartável usado pelos testes que precisam de banco real
 * (os `e2e.test.ts` de credit-card e bank-account).
 *
 * Aplica as migrations em `prisma/test.db` DO WORKTREE ATUAL — nunca no dev.db,
 * porque o alvo vem de scripts/test-db-env.cjs, que recusa qualquer dev.db.
 *
 * Uso: npm run test:db:prepare
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const guard = require('./test-db-env.cjs');

const schema = path.join(guard.REPO_ROOT, 'prisma', 'schema.prisma');

console.log(`[db-guard] preparando banco de teste: ${process.env.DATABASE_URL}`);

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy', `--schema=${schema}`], {
  cwd: guard.REPO_ROOT,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
});

process.exit(result.status ?? 1);
