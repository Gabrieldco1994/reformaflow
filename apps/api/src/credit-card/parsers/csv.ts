import { IMPORT_SESSION_LIMITS } from "@reformaflow/domain";
import {
  assignOrdinals,
  buildCardDocument,
  DocumentExtractionError,
  detectInstallment,
  inferPeriodLabel,
  makeExternalId,
  parseBrlMoney,
  type NormalizedTx,
  type ParseResult,
  type DocumentExtractionV1,
} from "./types";

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
  source: "CSV_NUBANK" | "CSV_ITAU" | "CSV_GENERIC";
}

export function parseCsv(content: string, opts: ParseOptions): ParseResult {
  const { rows, headerCols, hasHeader } = captureCsv(content);
  const lines = rows.filter((row) => row.line.trim());

  if (lines.length === 0) {
    return { source: opts.source, transactions: [], totalAmountCents: 0 };
  }

  const dataLines = hasHeader ? lines.slice(1) : lines;

  const idx = mapColumns(headerCols, hasHeader);

  const transactions: NormalizedTx[] = [];
  let totalAmountCents = 0;

  for (const row of dataLines) {
    const cols = row.columns.map((value) => value.trim());
    if (cols.length < 3) continue;

    const dateRaw = cols[idx.date] ?? "";
    const descRaw = cols[idx.merchant] ?? "";
    const amountRaw = cols[idx.amount] ?? "";
    const categoryRaw = idx.category != null ? cols[idx.category] : undefined;

    const date = parseFlexibleDate(dateRaw);
    if (!date) continue;

    let amountCents = parseBrlMoney(amountRaw);
    if (amountCents === 0) continue;

    // CSV de FATURA Itaú: positivo = despesa (compra), negativo = crédito
    // (pagamento da fatura anterior, estornos, descontos). Mantemos o sinal:
    // o serviço de import trata negativos como estornos/pagamento de fatura.
    // CSV Nubank também usa positivo=despesa.
    // (Antes invertíamos negativos do CSV_ITAU — bug: confundia com extrato
    // bancário, mascarando estornos como despesa positiva.)

    const { current, total, cleanMerchant } = detectInstallment(descRaw);
    transactions.push({
      externalId: "", // preenchido abaixo após assignOrdinals
      date,
      merchant: cleanMerchant || "Lançamento",
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

export function parseCsvDocument(
  content: string,
  profile: "CSV_NUBANK" | "CSV_ITAU",
): DocumentExtractionV1 {
  assertStrictCsvText(content);
  const separator = profile === "CSV_ITAU" ? ";" : ",";
  const { rows, headerCols, hasHeader } = captureCsv(
    content,
    separator,
  );
  const headerIndex = rows.findIndex((row) => row.line.trim() !== "");
  const dataRows = rows
    .slice(headerIndex + 1)
    .filter((row) => row.line.trim() !== "");
  const idx = strictColumnMap(headerCols);
  const opposite = captureCsv(content, separator === "," ? ";" : ",");
  if (
    !hasHeader ||
    headerIndex < 0 ||
    idx === null ||
    opposite.headerCols.length > 1 ||
    strictColumnMap(opposite.headerCols) !== null ||
    dataRows.length === 0 ||
    rows.some((row) => !row.supported) ||
    rows.some(
      (row) =>
        row.line.trim() !== "" && row.columns.length !== headerCols.length,
    )
  ) {
    throw new DocumentExtractionError("UNSUPPORTED_DOCUMENT");
  }
  if (
    headerCols.length > IMPORT_SESSION_LIMITS.csvColumnsPerFile ||
    rows.some((row) =>
      row.columns.some(
        (field) =>
          Buffer.byteLength(field, "utf8") >
          IMPORT_SESSION_LIMITS.csvFieldBytes,
      ),
    )
  )
    throw new DocumentExtractionError("LIMIT_EXCEEDED");
  return buildCardDocument(
    dataRows.map((row) => ({
      reference: `csv:record:${row.record}`,
      date: row.columns[idx.date] ?? null,
      description: row.columns[idx.merchant] ?? null,
      amount: row.columns[idx.amount] ?? null,
      fitId: null,
    })),
    "CSV",
    "UNKNOWN",
  );
}

// ─── helpers ────────────────────────────────────────────────

const CSV_DATE_HEADERS = new Set(["date", "data"]);
const CSV_DESCRIPTION_HEADERS = new Set([
  "title",
  "descricao",
  "descrição",
  "memo",
  "historico",
  "histórico",
  "estabelecimento",
  "lancamento",
  "lançamento",
]);
const CSV_AMOUNT_HEADERS = new Set(["amount", "valor", "value"]);

function assertStrictCsvText(content: string): void {
  const text = content.replace(/^\uFEFF/, "");
  const prefix = text.slice(0, 16);
  if (
    prefix.startsWith("%PDF-") ||
    prefix.startsWith("PK\u0003\u0004") ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text) ||
    /<\s*(?:!doctype\s+html|html|script|svg|xml)\b|<\?xml\b/i.test(text)
  )
    throw new DocumentExtractionError("UNSUPPORTED_DOCUMENT");
}

function strictColumnMap(header: string[]): ColumnMap | null {
  const indexes = (accepted: ReadonlySet<string>) =>
    header.flatMap((value, index) =>
      accepted.has(value.normalize("NFC").trim().toLowerCase()) ? [index] : [],
    );
  const dates = indexes(CSV_DATE_HEADERS);
  const descriptions = indexes(CSV_DESCRIPTION_HEADERS);
  const amounts = indexes(CSV_AMOUNT_HEADERS);
  if (
    dates.length !== 1 ||
    descriptions.length !== 1 ||
    amounts.length !== 1
  )
    return null;
  return {
    date: dates[0]!,
    merchant: descriptions[0]!,
    amount: amounts[0]!,
  };
}

function captureCsv(content: string, separator?: string) {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (separator !== undefined) {
    const header = lines.findIndex((line) => line.trim() !== "");
    if (
      header >= 0 &&
      lines.length - header - 1 > IMPORT_SESSION_LIMITS.parsedRowsPerFile
    ) {
      throw new DocumentExtractionError("LIMIT_EXCEEDED");
    }
  }
  const nonempty = lines.filter((line) => line.trim() !== "");
  const sample = nonempty[nonempty.length > 1 ? 1 : 0] ?? "";
  const sep = separator ?? (sample.includes(";") ? ";" : ",");
  const rows = lines.map((line, index) => ({
    line,
    record: index + 1,
    ...parseCsvLine(line, sep),
  }));
  const headerCols = (
    rows.find((row) => row.line.trim() !== "")?.columns ?? []
  ).map((c) => c.trim().toLowerCase());
  const hasHeader = headerCols.some((c) =>
    /data|date|descri|title|valor|amount/.test(c),
  );
  return { rows, headerCols, hasHeader };
}

function parseCsvLine(
  line: string,
  sep: string,
): { columns: string[]; supported: boolean } {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let closedQuote = false;
  let supported = true;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        if (!inQuotes && (cur.trim() !== "" || closedQuote)) supported = false;
        if (inQuotes) closedQuote = true;
        inQuotes = !inQuotes;
      }
    } else if (c === sep && !inQuotes) {
      out.push(cur);
      cur = "";
      closedQuote = false;
    } else {
      if (closedQuote && !inQuotes && c.trim() !== "") supported = false;
      cur += c;
    }
  }
  out.push(cur);
  return { columns: out, supported: supported && !inQuotes };
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
  const date = find("data", "date");
  const merchant = find(
    "descri",
    "title",
    "memo",
    "historic",
    "estabelec",
    "lançamento",
  );
  const amount = find("valor", "amount", "value");
  const category = find("categ", "category");
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
