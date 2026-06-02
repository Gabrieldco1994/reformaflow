import { createHash } from 'node:crypto';

export interface NormalizedTx {
  externalId: string;        // hash determinístico para dedup
  date: Date;                // data da transação
  merchant: string;          // descrição do estabelecimento
  amountCents: number;       // positivo = despesa, negativo = estorno
  rawCategory?: string;      // se a fonte enviar
  installmentCurrent?: number;
  installmentTotal?: number;
  isFuture?: boolean;        // true = parcela/lançamento futuro (entrará como PLANEJADO)
}

export interface ParseResult {
  source: 'OFX' | 'CSV_NUBANK' | 'CSV_ITAU' | 'CSV_GENERIC' | 'PDF';
  transactions: NormalizedTx[];
  totalAmountCents: number;
  periodLabel?: string;       // YYYY-MM da maior densidade
  futureInstallments?: NormalizedTx[]; // parcelas/lançamentos futuros (apenas informativo)
}

export function makeExternalId(parts: {
  cardId: string;
  date: Date;
  merchant: string;
  amountCents: number;
  bankRef?: string;
  ordinal?: number;       // ordinal por bucket (date+merchant+amount) — diferencia
                          // N transações idênticas no mesmo dia. Quando bankRef
                          // é único, ordinal não é necessário (e é ignorado).
}): string {
  if (parts.bankRef) {
    return createHash('sha256').update(`${parts.cardId}|${parts.bankRef}`).digest('hex').slice(0, 32);
  }
  const ord = parts.ordinal ?? 0;
  // BACKWARD COMPAT: ordinal=0 produz o MESMO hash do formato antigo
  // (sem campo ordinal). Isso garante que re-importar dados pré-fix
  // não duplique: linhas únicas continuam casando o externalId existente.
  // Apenas ordinal>0 (2ª, 3ª... ocorrência idêntica) entra no hash.
  const baseKey = `${parts.cardId}|${parts.date.toISOString().slice(0, 10)}|${parts.merchant.toLowerCase().trim()}|${parts.amountCents}`;
  const key = ord === 0 ? baseKey : `${baseKey}|${ord}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/**
 * Atribui ordinais sequenciais a transações com mesmo bucket (date+merchant+amount).
 * Preserva a ordem original do arquivo — re-import do mesmo arquivo gera os mesmos
 * ordinais (idempotente). N linhas idênticas geram N externalIds distintos.
 *
 * Use depois de parsear o arquivo, ANTES de gerar os externalIds.
 */
export function assignOrdinals<T extends { date: Date; merchant: string; amountCents: number }>(
  txs: T[],
): (T & { _ordinal: number })[] {
  const counts = new Map<string, number>();
  return txs.map((t) => {
    const key = `${t.date.toISOString().slice(0, 10)}|${t.merchant.toLowerCase().trim()}|${t.amountCents}`;
    const next = counts.get(key) ?? 0;
    counts.set(key, next + 1);
    return Object.assign({}, t, { _ordinal: next });
  });
}

export function inferPeriodLabel(txs: NormalizedTx[]): string | undefined {
  if (txs.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const t of txs) {
    const key = `${t.date.getUTCFullYear()}-${String(t.date.getUTCMonth() + 1).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

export function detectInstallment(description: string): { current?: number; total?: number; cleanMerchant: string } {
  // Padrões: "PARC 02/10", "PARC. 2/10", "2/10", "2 DE 10", "(2/10)"
  const patterns = [
    /\bPARC\.?\s*(\d{1,2})\s*\/\s*(\d{1,2})\b/i,
    /\((\d{1,2})\s*\/\s*(\d{1,2})\)/,
    /\b(\d{1,2})\s*\/\s*(\d{1,2})\b(?!\d)/,
    /\b(\d{1,2})\s*DE\s*(\d{1,2})\b/i,
  ];
  for (const re of patterns) {
    const m = description.match(re);
    if (m) {
      const current = parseInt(m[1], 10);
      const total = parseInt(m[2], 10);
      if (current >= 1 && total > 1 && current <= total && total <= 60) {
        const cleanMerchant = description.replace(re, '').replace(/\s+/g, ' ').trim();
        return { current, total, cleanMerchant: cleanMerchant || description.trim() };
      }
    }
  }
  return { cleanMerchant: description.trim() };
}

export function parseBrlMoney(raw: string): number {
  // "1.234,56" -> 123456; "-89.90" -> -8990; "89,90" -> 8990
  if (raw == null || raw === '') return 0;
  let s = String(raw).replace(/[^\d,.\-]/g, '').trim();
  if (!s || s === '-' || s === '.' || s === ',') return 0;
  const negative = s.startsWith('-');
  s = s.replace(/^-/, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  if (!isFinite(n)) return 0;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}
