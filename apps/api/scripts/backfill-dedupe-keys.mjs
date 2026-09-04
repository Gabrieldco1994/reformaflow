#!/usr/bin/env node
/**
 * #659 — Backfill de `dedupe_key_natural` para linhas importadas históricas.
 *
 * Escopo: SÓ linhas de importação — `import_id IS NOT NULL AND external_id IS NOT
 * NULL AND dedupe_key_natural IS NULL` — em `expenses` e `receipts`.
 *
 * SÓ `dedupe_key_natural`. FITID e bytes do arquivo nunca foram persistidos, então
 * `dedupe_key_strong` fica NULL na história (o índice único é PARCIAL, sem
 * violação). Uma linha histórica ainda casa via Tier B (natural) na próxima
 * importação — aceitável e documentado no design §7.
 *
 * - Idempotente: recompute é determinístico + guard `dedupe_key_natural IS NULL`;
 *   2ª execução = 0 updates, sem P2002 (natural não tem unique).
 * - Transacional: lotes de 500, cada lote num `$transaction`.
 * - Ordinal histórico: recomputado por bucket
 *   `(tenant_id, project_id, iso(data), norm(merchant), amount)` ordenado por
 *   `(created_at, id)` — MESMA regra de `assignOrdinals` / `computeImportOrdinals`.
 *
 * PRODUÇÃO (passo humano):
 *   cp prisma/dev.db prisma/dev.db.bak-659-$(date +%Y%m%d-%H%M%S)
 *   DATABASE_URL="file:./prisma/dev.db" node apps/api/scripts/backfill-dedupe-keys.mjs
 *   # conferir: contagem de (import_id NOT NULL AND dedupe_key_natural IS NULL) == 0
 *
 * CI: roda contra prisma/test.db via `test-db-env.cjs` (ver
 * apps/api/src/import-dedupe/backfill-dedupe-keys.spec.ts, que importa este módulo).
 */
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const BATCH = 500;

const norm = (m) => String(m ?? '').toLowerCase().trim();
// SQLite via Prisma guarda DateTime como INTEGER (epoch ms) → `$queryRaw` devolve
// BigInt; `Date` também aceita string ISO / número. Normaliza os três.
const iso = (d) => {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === 'bigint') return new Date(Number(d)).toISOString().slice(0, 10);
  if (typeof d === 'number') return new Date(d).toISOString().slice(0, 10);
  return new Date(String(d)).toISOString().slice(0, 10);
};
const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);

export function dedupeKeyNatural({
  tenantId,
  projectId,
  date,
  merchant,
  amountCents,
  ordinal,
}) {
  return h(
    `dk-nat-v1|${tenantId}|${projectId}|${iso(date)}|${amountCents}|${norm(merchant)}|${ordinal}`,
  );
}

/**
 * Recomputa ordinais por bucket para um conjunto de linhas já ORDENADO por
 * (created_at, id). Retorna Map<id, ordinal>.
 */
export function assignHistoricalOrdinals(rows) {
  const counts = new Map();
  const out = new Map();
  for (const r of rows) {
    const key = `${r.tenantId}|${r.projectId}|${iso(r.date)}|${norm(r.merchant)}|${r.amountCents}`;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    out.set(r.id, n);
  }
  return out;
}

async function backfillTable(prisma, table) {
  const isExpense = table === 'expenses';
  let totalUpdated = 0;

  // Snapshot completo das linhas em escopo (ordenado) — o ordinal precisa da
  // sequência inteira do bucket, não só do lote.
  const raw = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id as tenantId, project_id as projectId,
       ${isExpense ? 'COALESCE(data_compra, data_pagamento, data_inicio_parcela, created_at)' : 'data'} as date,
       ${isExpense ? 'COALESCE(titulo, fornecedor)' : 'descricao'} as merchant,
       ${isExpense ? 'valor_total' : 'valor'} as amountCents,
       created_at as createdAt
     FROM ${table}
     WHERE import_id IS NOT NULL AND external_id IS NOT NULL AND dedupe_key_natural IS NULL
     ORDER BY tenant_id, project_id, created_at, id`,
  );
  if (raw.length === 0) return 0;

  const rows = raw.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    projectId: r.projectId,
    date: r.date,
    merchant: r.merchant,
    amountCents: Number(r.amountCents ?? 0),
  }));
  const ordinals = assignHistoricalOrdinals(rows);

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const results = await prisma.$transaction(
      slice.map((r) =>
        prisma.$executeRawUnsafe(
          `UPDATE ${table} SET dedupe_key_natural = ? WHERE id = ? AND dedupe_key_natural IS NULL`,
          dedupeKeyNatural({
            tenantId: r.tenantId,
            projectId: r.projectId,
            date: r.date,
            merchant: r.merchant,
            amountCents: r.amountCents,
            ordinal: ordinals.get(r.id) ?? 0,
          }),
          r.id,
        ),
      ),
    );
    totalUpdated += results.reduce((s, n) => s + Number(n ?? 0), 0);
  }
  return totalUpdated;
}

export async function runBackfill(prisma) {
  const expenses = await backfillTable(prisma, 'expenses');
  const receipts = await backfillTable(prisma, 'receipts');
  return { expenses, receipts };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log(`[backfill-659] DATABASE_URL=${process.env.DATABASE_URL}`);
    const res = await runBackfill(prisma);
    console.log(
      `[backfill-659] OK — expenses:${res.expenses} receipts:${res.receipts}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Só executa quando chamado como script (não quando importado pelo spec).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[backfill-659] FALHOU:', err);
    process.exit(1);
  });
}
