import {
  assignOrdinals,
  detectInstallment,
  inferPeriodLabel,
  makeExternalId,
  parseBrlMoney,
  type NormalizedTx,
  type ParseResult,
} from './types';

/**
 * Parser CSV genérico para faturas Nubank e Itaú.
 *
 * Formato Nubank (fatura): `date,title,amount`
 *   ex: 2026-05-12,IFOOD *RESTAURANTE,89.90
 *
 * Formato Itaú (extrato/fatura): `data;descricao;valor`
 *   ex: 12/05/2026;IFOOD ESTABELECIMENTO;R$ 89,90
 *
 * Detecta separador (, ou ;) e formato de data automaticamente.
 */

interface ParseOptions {
  cardId: string;
  source: 'CSV_NUBANK' | 'CSV_ITAU' | 'CSV_GENERIC';
}

export function parseCsv(content: string, opts: ParseOptions): ParseResult {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  if (lines.length === 0) {
    return { source: opts.source, transactions: [], totalAmountCents: 0 };
  }

  // Detecta separador pela 1a linha de dados
  const sample = lines[lines.length > 1 ? 1 : 0];
  const sep = sample.includes(';') ? ';' : ',';

  // Identifica header
  const headerCols = parseCsvLine(lines[0], sep).map((c) => c.toLowerCase());
  const hasHeader = headerCols.some((c) => /data|date|descri|title|valor|amount/.test(c));
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const idx = mapColumns(headerCols, hasHeader);

  const transactions: NormalizedTx[] = [];
  let totalAmountCents = 0;

  for (const line of dataLines) {
    const cols = parseCsvLine(line, sep);
    if (cols.length < 3) continue;

    const dateRaw = cols[idx.date] ?? '';
    const descRaw = cols[idx.merchant] ?? '';
    const amountRaw = cols[idx.amount] ?? '';
    const categoryRaw = idx.category != null ? cols[idx.category] : undefined;

    const date = parseFlexibleDate(dateRaw);
    if (!date) continue;

    let amountCents = parseBrlMoney(amountRaw);
    if (amountCents === 0) continue;

    // Itaú em CSV normalmente já vem com sinal negativo para débitos no extrato.
    // Nubank fatura: valores positivos = despesas.
    // Padronizamos: despesa = positivo. Se vier negativo, invertemos.
    if (opts.source === 'CSV_ITAU' && amountCents < 0) {
      amountCents = -amountCents;
    }

    const { current, total, cleanMerchant } = detectInstallment(descRaw);
    transactions.push({
      externalId: '',  // preenchido abaixo após assignOrdinals
      date,
      merchant: cleanMerchant || 'Lançamento',
      amountCents,
      rawCategory: categoryRaw?.trim() || undefined,
      installmentCurrent: current,
      installmentTotal: total,
    });
    totalAmountCents += amountCents;
  }

  // Atribui ordinal por bucket para diferenciar N linhas idênticas no mesmo dia.
  const withOrdinals = assignOrdinals(transactions);
  for (let i = 0; i < transactions.length; i++) {
    transactions[i].externalId = makeExternalId({
      cardId: opts.cardId,
      date: transactions[i].date,
      merchant: transactions[i].merchant,
      amountCents: transactions[i].amountCents,
      ordinal: withOrdinals[i]._ordinal,
    });
  }

  return {
    source: opts.source,
    transactions,
    totalAmountCents,
    periodLabel: inferPeriodLabel(transactions),
  };
}

// ─── helpers ────────────────────────────────────────────────

function parseCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (c === sep && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

interface ColumnMap {
  date: number;
  merchant: number;
  amount: number;
  category?: number;
}

function mapColumns(header: string[], hasHeader: boolean): ColumnMap {
  if (!hasHeader) {
    return { date: 0, merchant: 1, amount: 2 };
  }
  const find = (...needles: string[]): number => {
    for (let i = 0; i < header.length; i++) {
      if (needles.some((n) => header[i].includes(n))) return i;
    }
    return -1;
  };
  const date = find('data', 'date');
  const merchant = find('descri', 'title', 'memo', 'historic', 'estabelec');
  const amount = find('valor', 'amount', 'value');
  const category = find('categ', 'category');
  return {
    date: date >= 0 ? date : 0,
    merchant: merchant >= 0 ? merchant : 1,
    amount: amount >= 0 ? amount : 2,
    category: category >= 0 ? category : undefined,
  };
}

function parseFlexibleDate(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  // ISO: 2026-05-12
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }
  // BR: 12/05/2026 ou 12/05/26
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    return new Date(Date.UTC(y, +m[2] - 1, +m[1]));
  }
  return null;
}
