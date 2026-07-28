'use strict';

/**
 * Trava de segurança do banco em testes.
 *
 * Contexto (incidente 2026-07-28): worktrees não têm `.env` próprio, a API lê
 * `process.env.DATABASE_URL` puro (sem ConfigModule/dotenv) e o default exportado
 * no profile do shell aponta para o `prisma/dev.db` do checkout principal — que tem
 * dados reais. Rodar `npx jest` de qualquer worktree, portanto, escrevia no banco real.
 *
 * Este módulo força `DATABASE_URL` para um SQLite descartável **dentro do worktree
 * atual** e recusa, com erro legível, qualquer URL que aponte para um `dev.db` ou
 * para fora do worktree. Requerer o módulo já aplica a trava (efeito colateral
 * proposital, para poder ser usado direto como `setupFiles` do jest/vitest).
 *
 * Não afeta desenvolvimento: nada aqui é carregado por `npm run dev`.
 */

const path = require('path');

/** Raiz do worktree atual (este arquivo mora em <raiz>/scripts/). */
const REPO_ROOT = path.resolve(__dirname, '..');

/** Banco descartável, por worktree. Coberto pelo `*.db` do .gitignore. */
const TEST_DB_PATH = path.join(REPO_ROOT, 'prisma', 'test.db');
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

/**
 * Resolve o caminho de arquivo de uma URL SQLite (`file:...`).
 * Retorna null para URLs que não são SQLite em arquivo (ex.: `file::memory:`).
 */
function resolveSqlitePath(url) {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw.toLowerCase().startsWith('file:')) return null;

  let filePart = raw.slice('file:'.length);
  if (filePart.startsWith('//')) filePart = filePart.slice(2);
  filePart = filePart.split('?')[0];
  if (!filePart || filePart.startsWith(':')) return null; // file::memory:

  // Prisma resolve caminhos relativos a partir do diretório do schema (prisma/).
  return path.resolve(path.join(REPO_ROOT, 'prisma'), filePart);
}

/**
 * Uma URL é proibida em testes se apontar para um `dev.db` (qualquer checkout)
 * ou para um arquivo fora do worktree atual.
 * Retorna a razão (string) ou null se a URL for segura.
 */
function forbiddenReason(url) {
  const resolved = resolveSqlitePath(url);
  if (!resolved) return null; // memória / outro provider: sem risco de dev.db

  if (path.basename(resolved) === 'dev.db') {
    return 'aponta para um dev.db (banco de desenvolvimento com dados reais)';
  }

  const relative = path.relative(REPO_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return `aponta para fora do worktree atual (${REPO_ROOT})`;
  }

  return null;
}

function explode(url, reason) {
  const resolved = resolveSqlitePath(url);
  throw new Error(
    [
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      ' TESTE ABORTADO: DATABASE_URL inseguro',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      ` URL......: ${url}`,
      ` Arquivo..: ${resolved ?? '(não resolvido)'}`,
      ` Motivo...: ${reason}`,
      '',
      ' A suíte de testes não pode escrever no banco de desenvolvimento:',
      ' ele tem dados reais e uma migration aplicada por engano gera drift',
      ' (regra de ouro #1 do CLAUDE.md proíbe `prisma migrate reset`).',
      '',
      ' Correção: NÃO defina TEST_DATABASE_URL — a trava usa automaticamente',
      ` ${TEST_DB_URL}`,
      ' Se precisar de outro banco de teste, aponte para um arquivo descartável',
      ' dentro deste worktree (e nunca chamado dev.db).',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
    ].join('\n'),
  );
}

/**
 * Força `process.env.DATABASE_URL` para o banco de teste do worktree.
 * `TEST_DATABASE_URL` permite escolher outro alvo — que também é validado.
 */
function applyTestDatabaseUrl() {
  const requested = process.env.TEST_DATABASE_URL;

  if (requested) {
    const reason = forbiddenReason(requested);
    if (reason) explode(requested, reason);
    process.env.DATABASE_URL = requested;
  } else {
    process.env.DATABASE_URL = TEST_DB_URL;
  }

  // Cinto e suspensório: o alvo final nunca pode ser perigoso.
  const finalReason = forbiddenReason(process.env.DATABASE_URL);
  if (finalReason) explode(process.env.DATABASE_URL, finalReason);

  return process.env.DATABASE_URL;
}

// Aplicar ao ser requerido, para servir como setupFile "cru" de jest/vitest.
applyTestDatabaseUrl();

module.exports = {
  REPO_ROOT,
  TEST_DB_PATH,
  TEST_DB_URL,
  resolveSqlitePath,
  forbiddenReason,
  applyTestDatabaseUrl,
};
