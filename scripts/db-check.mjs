#!/usr/bin/env node
/**
 * Guarda de regressão de integridade referencial (#628).
 *
 * A auditoria do incidente SEV-1 achou 32 violações de chave estrangeira
 * (28 `rooms` ativos sem projeto, 4 `CashFlowEntry` soft-deleted sem despesa)
 * criadas por tooling com FK enforcement OFF (`sqlite3`, `prisma db execute`,
 * PRAGMA manual). O reparo dos dados foi feito em separado; este script só
 * impede a RECORRÊNCIA: roda `PRAGMA foreign_key_check` e falha se houver
 * qualquer órfão.
 *
 * READ-ONLY: abre o banco apontado por DATABASE_URL, roda um único PRAGMA e
 * fecha. Nunca escreve, nunca repara.
 *
 * Uso: `npm run db:check` (pre-commit) ou, no CI, após `npm run test:db:prepare`:
 *   DATABASE_URL="file:$PWD/prisma/test.db" npm run db:check
 *
 * Códigos de saída:
 *   0 — zero violações, OU o arquivo do banco não existe (clone/worktree sem db)
 *   1 — há violações (lista impressa), ou erro ao abrir o banco
 *
 * `PRAGMA foreign_key_check` devolve uma linha por violação:
 *   { table, rowid, parent, fkid }
 *   - table : tabela que contém a FK órfã
 *   - rowid : rowid da linha órfã (null em tabelas WITHOUT ROWID)
 *   - parent: tabela referenciada cuja linha-pai está ausente
 *   - fkid  : índice da FK na tabela (cf. `PRAGMA foreign_key_list(<table>)`)
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const DEFAULT_URL = "file:./prisma/dev.db";

/**
 * Resolve o caminho absoluto de arquivo de uma URL SQLite `file:`.
 * Retorna null para URLs que não são SQLite em arquivo (ex.: `file::memory:`).
 * Caminhos relativos resolvem a partir de `process.cwd()` — que, via
 * `npm run db:check`, é a raiz do pacote (onde mora `prisma/`).
 */
function resolveSqliteFile(url) {
  if (typeof url !== "string") return null;
  const raw = url.trim();
  if (!raw.toLowerCase().startsWith("file:")) return null;
  let filePart = raw.slice("file:".length).split("?")[0];
  if (!filePart || filePart.startsWith(":")) return null; // file::memory:
  return path.resolve(process.cwd(), filePart);
}

async function main() {
  const url = process.env.DATABASE_URL || DEFAULT_URL;
  const file = resolveSqliteFile(url);

  if (!file) {
    console.log(
      `⚠ db:check ignorado: DATABASE_URL não aponta para um arquivo SQLite (${url}).`,
    );
    return 0;
  }

  if (!existsSync(file)) {
    console.log(`⚠ db:check ignorado: banco não encontrado em ${file}.`);
    console.log(
      "  (esperado em clone/worktree sem dev.db — não bloqueia o commit)",
    );
    return 0;
  }

  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${file}` } },
  });

  try {
    await prisma.$connect();
    const rows = await prisma.$queryRawUnsafe("PRAGMA foreign_key_check;");

    if (!Array.isArray(rows) || rows.length === 0) {
      console.log("✓ 0 violações de FK");
      return 0;
    }

    const byTable = new Map();
    console.error(
      `✗ ${rows.length} violação(ões) de integridade referencial em ${file}:`,
    );
    console.error("");
    console.error("  tabela | rowid | referência ausente (parent/fkid)");
    console.error(`  ${"-".repeat(48)}`);
    for (const row of rows) {
      const table = row.table ?? "(desconhecida)";
      const rowid = row.rowid ?? "(sem rowid)";
      const parent = row.parent ?? "(desconhecida)";
      const fkid = row.fkid ?? "?";
      console.error(`  ${table} | ${rowid} | ${parent}/${fkid}`);
      byTable.set(table, (byTable.get(table) ?? 0) + 1);
    }
    console.error("");
    console.error("  Resumo por tabela:");
    for (const [table, count] of [...byTable].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      console.error(`    ${table}: ${count}`);
    }
    console.error("");
    console.error(
      `  Total: ${rows.length} violação(ões) de FK. Contexto: issue #628.`,
    );
    console.error(
      "  Este check é só diagnóstico — não repare com tooling de FK OFF.",
    );
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    console.error(
      `db:check falhou: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
