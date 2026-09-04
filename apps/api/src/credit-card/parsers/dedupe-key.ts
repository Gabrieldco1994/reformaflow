import { createHash } from 'node:crypto';

/**
 * #659 — chaves de dedupe cross-origin de importação.
 *
 * Os 3 canais (Carteira/receipt, extrato/bank, fatura/card) chamam estes helpers
 * com os MESMOS argumentos — o `seed` por canal (que quebra o `external_id`)
 * NUNCA entra aqui. Fórmulas: docs/659-cross-origin-dedupe-design.md §5.
 *
 * - `dedupeKeyStrong`: prova de "é a MESMA transação" — FITID (id do banco) OU
 *   hash dos bytes do arquivo dobrado na assinatura da linha. Auto-skip.
 * - `dedupeKeyNatural`: (tenant, project, date, amount, merchant, ordinal) sem
 *   respaldo de id/arquivo → colide entre arquivos diferentes → NUNCA auto-skip,
 *   só superfície `possibleDuplicate`.
 */

/** Igual à normalização de `makeExternalId` / `assignOrdinals`. */
const norm = (m: string): string => m.toLowerCase().trim();
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const h = (s: string): string =>
  createHash('sha256').update(s).digest('hex').slice(0, 32);

/**
 * Hash dos bytes do upload — ordem-independente (o import mescla N buffers e a
 * ordem não é significativa). 32 hex chars.
 */
export function fileContentHash(buffers: Buffer[]): string {
  return h(
    buffers
      .map((b) => createHash('sha256').update(b).digest('hex'))
      .sort()
      .join('|'),
  );
}

export interface DedupeKeyStrongParams {
  tenantId: string;
  projectId: string;
  date: Date;
  merchant: string;
  amountCents: number;
  ordinal: number;
  fitId?: string;
  fileContentHash?: string;
}

export function dedupeKeyStrong(p: DedupeKeyStrongParams): string | null {
  if (p.fitId) {
    return h(`dk-strong-fit-v1|${p.tenantId}|${p.projectId}|${p.fitId}`);
  }
  if (p.fileContentHash) {
    return h(
      `dk-strong-file-v1|${p.tenantId}|${p.projectId}|${p.fileContentHash}|${iso(p.date)}|${p.amountCents}|${norm(p.merchant)}|${p.ordinal}`,
    );
  }
  // Nem fitId nem bytes de arquivo → linha histórica (backfill). Índice parcial.
  return null;
}

export interface DedupeKeyNaturalParams {
  tenantId: string;
  projectId: string;
  date: Date;
  merchant: string;
  amountCents: number;
  ordinal: number;
}

export function dedupeKeyNatural(p: DedupeKeyNaturalParams): string {
  return h(
    `dk-nat-v1|${p.tenantId}|${p.projectId}|${iso(p.date)}|${p.amountCents}|${norm(p.merchant)}|${p.ordinal}`,
  );
}

/**
 * Ordinal por bucket `iso(date)|norm(merchant)|amountCents`, na ordem do array —
 * MESMA regra de `assignOrdinals` (`types.ts`). N linhas idênticas no mesmo
 * arquivo recebem 0, 1, 2… e portanto chaves distintas.
 */
export function computeImportOrdinals<
  T extends { date: Date; merchant: string; amountCents: number },
>(txs: T[]): number[] {
  const counts = new Map<string, number>();
  return txs.map((t) => {
    const key = `${iso(t.date)}|${norm(t.merchant)}|${t.amountCents}`;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    return n;
  });
}
