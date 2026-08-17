"use strict";

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

const path = require("path");
const fs = require("fs");

/** Raiz do worktree atual (este arquivo mora em <raiz>/scripts/). */
const REPO_ROOT = path.resolve(__dirname, "..");
const REAL_REPO_ROOT = fs.realpathSync.native(REPO_ROOT);

/** Banco descartável, por worktree. Coberto pelo `*.db` do .gitignore. */
const TEST_DB_PATH = path.join(REPO_ROOT, "prisma", "test.db");
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

/**
 * Resolve o caminho de arquivo de uma URL SQLite (`file:...`).
 * Retorna null para URLs que não são SQLite em arquivo (ex.: `file::memory:`).
 */
function resolveSqlitePath(url) {
  if (typeof url !== "string") return null;
  const raw = url.trim();
  if (!raw.toLowerCase().startsWith("file:")) return null;

  let filePart = raw.slice("file:".length);
  if (filePart.startsWith("//")) filePart = filePart.slice(2);
  filePart = filePart.split("?")[0];
  if (!filePart || filePart.startsWith(":")) return null; // file::memory:

  // Prisma resolve caminhos relativos a partir do diretório do schema (prisma/).
  return path.resolve(path.join(REPO_ROOT, "prisma"), filePart);
}

/**
 * Resolve symlinks even when the final database file does not exist yet.
 * Walks to the nearest existing ancestor, canonicalizes it, then restores the
 * missing suffix. This catches an in-worktree path whose parent is a symlink.
 */
function resolveRealSqlitePath(url) {
  const resolved = resolveSqlitePath(url);
  if (!resolved) return null;

  let existing = resolved;
  const missingParts = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    missingParts.unshift(path.basename(existing));
    existing = parent;
  }

  return path.join(fs.realpathSync.native(existing), ...missingParts);
}

/**
 * Uma URL é proibida em testes se apontar para um `dev.db` (qualquer checkout)
 * ou para um arquivo fora do worktree atual.
 * Retorna a razão (string) ou null se a URL for segura.
 */
function forbiddenReason(url) {
  if (
    typeof url !== "string" ||
    !url.trim().toLowerCase().startsWith("file:")
  ) {
    return "TEST_DATABASE_URL deve usar uma URL file: para SQLite descartável";
  }

  const resolved = resolveSqlitePath(url);
  if (!resolved) {
    return "TEST_DATABASE_URL deve apontar para um arquivo SQLite descartável";
  }

  if (path.basename(resolved).toLowerCase() === "dev.db") {
    return "aponta para um dev.db (banco de desenvolvimento com dados reais)";
  }

  const relative = path.relative(REPO_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return `aponta para fora do worktree atual (${REPO_ROOT})`;
  }

  const realResolved = resolveRealSqlitePath(url);
  if (realResolved) {
    if (path.basename(realResolved).toLowerCase() === "dev.db") {
      return "resolve para um dev.db (banco de desenvolvimento com dados reais)";
    }
    const realRelative = path.relative(REAL_REPO_ROOT, realResolved);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return `escapa do worktree atual por symlink (${REPO_ROOT})`;
    }
  }

  return null;
}

function explode(url, reason) {
  const resolved = resolveSqlitePath(url);
  throw new Error(
    [
      "",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      " TESTE ABORTADO: DATABASE_URL inseguro",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      ` URL......: ${url}`,
      ` Arquivo..: ${resolved ?? "(não resolvido)"}`,
      ` Motivo...: ${reason}`,
      "",
      " A suíte de testes não pode escrever no banco de desenvolvimento:",
      " ele tem dados reais e uma migration aplicada por engano gera drift",
      " (regra de ouro #1 do CLAUDE.md proíbe `prisma migrate reset`).",
      "",
      " Correção: NÃO defina TEST_DATABASE_URL — a trava usa automaticamente",
      ` ${TEST_DB_URL}`,
      " Se precisar de outro banco de teste, aponte para um arquivo descartável",
      " dentro deste worktree (e nunca chamado dev.db).",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
    ].join("\n"),
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
  REAL_REPO_ROOT,
  TEST_DB_PATH,
  TEST_DB_URL,
  resolveSqlitePath,
  resolveRealSqlitePath,
  forbiddenReason,
  applyTestDatabaseUrl,
};
