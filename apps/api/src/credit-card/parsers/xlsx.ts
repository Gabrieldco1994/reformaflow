import * as XLSX from "xlsx";
import { IMPORT_SESSION_LIMITS } from "@reformaflow/domain";
import {
  assignOrdinals,
  detectInstallment,
  inferPeriodLabel,
  makeExternalId,
  parseBrlMoney,
  type NormalizedTx,
  type ParseResult,
  BinaryDocumentExtractionError,
  DocumentExtractionError,
  BINARY_DOCUMENT_LIMITS,
  buildBinaryCardDocument,
  captureDocumentHeading,
  type CardDocumentCapture,
  type CardDocumentEvent,
  type DocumentExtractionV1,
} from "./types";
import { expandSheetRange } from "./xlsx-range";

/**
 * Parser Excel (.xlsx/.xls) para faturas e extratos.
 *
 * Heurística fuzzy para headers:
 * - Case-insensitive
 * - Remove acentos para matching
 * - Procura por palavras-chave: "data", "descrição", "valor"
 *
 * Normaliza:
 * - Valor: BR (1.234,56) e US (1,234.56)
 * - Data: dd/mm/aaaa, aaaa-mm-dd, serial Excel
 */

interface ParseOptions {
  cardId: string;
}

export function parseXlsx(buffer: Buffer, cardId: string): ParseResult {
  try {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    if (!workbook.SheetNames.length) {
      return {
        source: "XLSX",
        transactions: [],
        totalAmountCents: 0,
        error: "Arquivo Excel vazio",
      };
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    // Corrige `<dimension>` defasada antes de ler — evita truncamento contíguo
    // quando o arquivo foi filtrado/re-salvo com um range declarado menor que os
    // dados reais. Ver xlsx-range.ts.
    expandSheetRange(sheet);
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

    if (!data.length) {
      return {
        source: "XLSX",
        transactions: [],
        totalAmountCents: 0,
        error: "Nenhuma linha no Excel",
      };
    }

    // Detecta índices das colunas essenciais
    const headerIdx = findHeaderRow(data);
    if (headerIdx === -1) {
      return {
        source: "XLSX",
        transactions: [],
        totalAmountCents: 0,
        error:
          "Não identifiquei as colunas de data, descrição e valor. Exporte como CSV ou OFX.",
      };
    }

    const headers = (data[headerIdx] ?? []) as string[];
    const colMap = mapColumns(headers);
    const installmentColIdx = findInstallmentColumn(headers);

    if (colMap.date === -1 || colMap.merchant === -1 || colMap.amount === -1) {
      return {
        source: "XLSX",
        transactions: [],
        totalAmountCents: 0,
        error:
          "Não identifiquei as colunas de data, descrição e valor. Exporte como CSV ou OFX.",
      };
    }

    const transactions: NormalizedTx[] = [];
    let totalAmountCents = 0;

    for (let i = headerIdx + 1; i < data.length; i++) {
      const row = data[i] ?? [];
      if (!Array.isArray(row) || row.length === 0) continue;

      const captured = captureSpreadsheetRow(
        row,
        i + 1,
        colMap,
        installmentColIdx,
        "XLSX",
      );
      const dateRaw = (captured.date ?? "").trim();
      const descRaw = (captured.description ?? "").trim();
      const amountRaw = (captured.amount ?? "").trim();
      const categoryRaw =
        colMap.category !== -1
          ? String(row[colMap.category] ?? "").trim()
          : undefined;

      if (!dateRaw || !amountRaw) continue;

      const date = parseFlexibleDate(dateRaw);
      if (!date) continue;

      const amountCents = parseFlexibleMoney(amountRaw);
      if (amountCents === 0) continue;

      // Itaú manda o parcelamento numa coluna separada ("Parcela 1 de 2"), não
      // embutido na descrição — detectInstallment() só olha a descrição.
      const installmentColRaw = (captured.installment ?? "").trim();
      const fromColumn = parseInstallmentColumn(installmentColRaw);
      const { current, total, cleanMerchant } = fromColumn
        ? { ...fromColumn, cleanMerchant: descRaw }
        : detectInstallment(descRaw);
      transactions.push({
        externalId: "", // preenchido abaixo após assignOrdinals
        date,
        merchant: cleanMerchant || "Lançamento",
        amountCents,
        rawCategory: categoryRaw || undefined,
        installmentCurrent: current,
        installmentTotal: total,
      });
      totalAmountCents += amountCents;
    }

    // Atribui ordinal por bucket para diferenciar N linhas idênticas no mesmo dia.
    const withOrdinals = assignOrdinals(transactions);
    for (let i = 0; i < transactions.length; i++) {
      transactions[i].externalId = makeExternalId({
        cardId,
        date: transactions[i].date,
        merchant: transactions[i].merchant,
        amountCents: transactions[i].amountCents,
        ordinal: withOrdinals[i]._ordinal,
      });
    }

    return {
      source: "XLSX",
      transactions,
      totalAmountCents,
      periodLabel: inferPeriodLabel(transactions),
      invoiceDueMonth: findInvoiceDueMonth(data, headerIdx),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      source: "XLSX",
      transactions: [],
      totalAmountCents: 0,
      error: `Erro ao parsear Excel: ${message}`,
    };
  }
}

/**
 * Encontra a linha de cabeçalho procurando por palavras-chave.
 * Retorna o índice da primeira linha com headers, ou -1 se não encontrar.
 */
function findHeaderRow(data: unknown[][]): number {
  // ponytail: 30 cobre os preâmbulos observados (Itaú tem ~13 linhas de
  // metadados antes do header); sobe se aparecer um export com mais linhas.
  for (let i = 0; i < Math.min(data.length, 30); i++) {
    const row = data[i];
    if (!Array.isArray(row)) continue;
    const headers = row.map((cell) => String(cell ?? "").toLowerCase());
    if (hasHeaderKeywords(headers)) {
      return i;
    }
  }
  return -1;
}

/**
 * Verifica se uma linha contém keywords de header (data, descrição, valor).
 */
function hasHeaderKeywords(headers: string[]): boolean {
  const normalized = headers.map((h) => removeAccents(h));
  const hasData = normalized.some((h) => /data|date|dt/.test(h));
  const hasDesc = normalized.some((h) =>
    /descri|historico|lancamento|memo|title/.test(h),
  );
  const hasAmount = normalized.some((h) =>
    /valor|amount|montante|quantia/.test(h),
  );
  return hasData && hasDesc && hasAmount;
}

/**
 * Remove acentos de uma string para matching case-insensitive.
 */
function removeAccents(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

interface ColumnMap {
  date: number;
  merchant: number;
  amount: number;
  category: number;
}

/**
 * Mapeia colunas pelo header usando fuzzy matching.
 * Evita falsos positivos: prefere keywords mais específicas.
 */
function mapColumns(headers: string[]): ColumnMap {
  // Array.from (não .map): células vazias viram buracos no array (sparse),
  // e .map() pula buracos preservando-os — daí .includes() quebrando em
  // undefined mais abaixo. Array.from percorre todo índice, buraco ou não.
  const normalized = Array.from(headers, (h) => removeAccents(String(h ?? "")));

  // Procura mais específica: prioritiza keywords únicos por coluna
  const findBest = (
    dateKeywords: string[],
    descKeywords: string[],
    amountKeywords: string[],
  ): ColumnMap => {
    const scores: { date: number; merchant: number; amount: number } = {
      date: -1,
      merchant: -1,
      amount: -1,
    };

    for (let i = 0; i < normalized.length; i++) {
      const h = normalized[i];

      // Procura keywords de data
      for (const kw of dateKeywords) {
        if (h.includes(kw)) {
          if (scores.date === -1) scores.date = i;
          break;
        }
      }

      // Procura keywords de descrição
      // Evita "lancamento" se "data lancamento" está presente
      let foundDesc = false;
      for (const kw of descKeywords) {
        if (h.includes(kw)) {
          if (!h.includes("data")) {
            // Evita "data lancamento"
            if (scores.merchant === -1) scores.merchant = i;
            foundDesc = true;
            break;
          }
        }
      }

      // Procura keywords de valor
      for (const kw of amountKeywords) {
        if (h.includes(kw)) {
          if (scores.amount === -1) scores.amount = i;
          break;
        }
      }
    }

    return {
      date: scores.date >= 0 ? scores.date : -1,
      merchant: scores.merchant >= 0 ? scores.merchant : -1,
      amount: scores.amount >= 0 ? scores.amount : -1,
      category: -1,
    };
  };

  const result = findBest(
    ["data", "date", "dt"],
    ["descri", "historico", "memo", "title", "estabelec", "lancamento"],
    ["valor", "amount", "montante", "quantia"],
  );

  // Se não encontrou, tenta category
  if (result.category === -1) {
    for (let i = 0; i < normalized.length; i++) {
      if (
        normalized[i].includes("categ") ||
        normalized[i].includes("category")
      ) {
        result.category = i;
        break;
      }
    }
  }

  return result;
}

/**
 * Lê o mês de VENCIMENTO da fatura no preâmbulo (antes da tabela de
 * lançamentos). Faturas Itaú trazem uma célula "Vencimento" com a data logo
 * abaixo/ao lado, na mesma coluna.
 *
 * Isso não é firula: a fatura Itaú repete a data da COMPRA em todas as
 * parcelas, então sem o vencimento não há como saber em qual fatura a
 * "Parcela 2 de 10" está sendo cobrada.
 */
function findInvoiceDueMonth(
  data: unknown[][],
  headerIdx: number,
): string | undefined {
  const limit = Math.min(headerIdx, data.length);
  for (let i = 0; i < limit; i++) {
    const row = data[i];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      if (removeAccents(String(row[c] ?? "")).trim() !== "vencimento") continue;
      // Data costuma vir na MESMA coluna, poucas linhas abaixo.
      for (let r = i; r < Math.min(i + 4, limit); r++) {
        const cell = data[r]?.[c];
        const date = parseCellDate(cell);
        if (date) {
          return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
        }
      }
    }
  }
  return undefined;
}

/** Data de uma célula que pode vir como Date, serial Excel ou texto. */
function parseCellDate(cell: unknown): Date | null {
  if (cell instanceof Date) return cell;
  if (typeof cell === "number") {
    // Serial Excel: dia 1 = 1900-01-01, com o bug do ano 1900 bissexto —
    // a época efetiva é 1899-12-30.
    if (cell <= 0 || cell > 100000) return null;
    return new Date(Date.UTC(1899, 11, 30) + cell * 86400000);
  }
  const s = String(cell ?? "").trim();
  if (!s) return null;
  return parseFlexibleDate(s);
}

/**
 * Encontra a coluna "Parcelamento" (Itaú manda o parcelamento separado da
 * descrição, ex.: "Parcela 1 de 2", em vez de embutido no texto).
 */
function findInstallmentColumn(headers: string[]): number {
  const normalized = Array.from(headers, (h) => removeAccents(String(h ?? "")));
  return normalized.findIndex((h) => h.includes("parcela"));
}

/**
 * Extrai current/total de uma coluna de parcelamento dedicada, ex.:
 * "Parcela 1 de 2" -> { current: 1, total: 2 }.
 */
function parseInstallmentColumn(
  raw: string,
): { current: number; total: number } | null {
  const m = raw.match(/(\d{1,2})\s*(?:de|\/)\s*(\d{1,2})/i);
  if (!m) return null;
  const current = parseInt(m[1], 10);
  const total = parseInt(m[2], 10);
  if (current >= 1 && total > 1 && current <= total && total <= 60) {
    return { current, total };
  }
  return null;
}

/**
 * Parseia data em múltiplos formatos:
 * - ISO: 2026-05-12
 * - BR: 12/05/2026 ou 12/05/26
 * - Serial Excel: número inteiro representando dias desde 1900-01-01
 */
function parseFlexibleDate(raw: string): Date | null {
  const s = String(raw).trim();
  if (!s) return null;

  // Serial Excel (número)
  if (/^\d+$/.test(s)) {
    const serial = parseInt(s, 10);
    if (serial > 0 && serial < 100000) {
      // Excel serial: 1 = 1900-01-01 (com bug de 1900 sendo bissexto)
      // Ajustamos para JavaScript: 1 = 1900-01-01, mas -1 para compensar bug Excel
      const date = new Date(1900, 0, serial - 1);
      return date;
    }
  }

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

/**
 * Parseia valores em formatos BR e US:
 * - BR: 1.234,56
 * - US: 1,234.56
 * - simples: 1234.56 / 1234,56
 */
function parseFlexibleMoney(raw: string): number {
  const s = String(raw).trim();
  if (!s) return 0;

  // Se já for número puro sem separadores de milhar, delega.
  if (/^-?\d+[.,]?\d*$/.test(s)) {
    return parseBrlMoney(s);
  }

  const hasDot = s.includes(".");
  const hasComma = s.includes(",");

  // Com ponto e vírgula: inferimos decimal pelo último separador.
  if (hasDot && hasComma) {
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    const normalized =
      lastDot > lastComma
        ? s.replace(/,/g, "") // US: 1,234.56
        : s.replace(/\./g, "").replace(",", "."); // BR: 1.234,56
    return parseBrlMoney(normalized);
  }

  return parseBrlMoney(s);
}

function captureSpreadsheetRow(
  row: readonly unknown[],
  physicalRow: number,
  columns: ColumnMap,
  installmentColumn: number,
  format: "XLS" | "XLSX",
  date1904?: boolean,
): CardDocumentCapture {
  const raw = (column: number): string | null =>
    row[column] === undefined || row[column] === null
      ? null
      : String(row[column]);
  const date = row[columns.date];
  return {
    reference: `${format.toLowerCase()}:sheet:1:row:${physicalRow}`,
    date: raw(columns.date),
    description: raw(columns.merchant),
    amount: raw(columns.amount),
    installment: installmentColumn < 0 ? null : raw(installmentColumn),
    fitId: null,
    ...(date1904 !== undefined && typeof date === "number"
      ? { serialDate: { value: date, date1904 } }
      : {}),
  };
}

function invalidInventory(): never {
  throw new DocumentExtractionError("INVALID_RESULT");
}

function inventoryRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalidInventory();
  return value as Record<string, unknown>;
}

function property(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor && !("value" in descriptor)) return invalidInventory();
  return descriptor?.value;
}

function denseArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalidInventory();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (!descriptor || !("value" in descriptor)) return invalidInventory();
  }
  return value;
}

function binaryContent(value: unknown): Uint8Array {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array))
    return invalidInventory();
  return value;
}

function inventorySize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return invalidInventory();
  return value;
}

function emptyContent(value: unknown): void {
  if (value !== undefined && binaryContent(value).byteLength !== 0)
    invalidInventory();
}

function readSpreadsheetInventory(
  workbook: XLSX.WorkBook,
  format: "XLS" | "XLSX",
): { archiveEntries: number; expandedBytes: number } {
  let archiveEntries = 0;
  let expandedBytes = 0;
  const count = (bytes: number): void => {
    archiveEntries++;
    expandedBytes += bytes;
    if (
      !Number.isSafeInteger(expandedBytes) ||
      archiveEntries > IMPORT_SESSION_LIMITS.expandedArchiveEntries ||
      expandedBytes > IMPORT_SESSION_LIMITS.expandedArchiveBytes
    )
      throw new DocumentExtractionError("LIMIT_EXCEEDED");
  };
  const book = inventoryRecord(workbook);
  if (format === "XLS") {
    const cfb = inventoryRecord(property(book, "cfb"));
    const paths = denseArray(property(cfb, "FullPaths"));
    const entries = denseArray(property(cfb, "FileIndex"));
    if (!entries.length || entries.length !== paths.length) invalidInventory();
    const root = inventoryRecord(entries[0]);
    const rootName = property(root, "name");
    const rootPath = paths[0];
    if (
      property(root, "type") !== 5 ||
      typeof rootName !== "string" ||
      !rootName ||
      rootName.includes("/") ||
      rootPath !== `${rootName}/`
    )
      invalidInventory();
    inventorySize(property(root, "size"));
    if (property(root, "content") !== undefined)
      binaryContent(property(root, "content"));
    const active = new Map<string, number>();
    active.set(String(rootPath), 5);
    for (let i = 1; i < entries.length; i++) {
      const entry = inventoryRecord(entries[i]);
      const type = property(entry, "type");
      const content = property(entry, "content");
      if (type === 0) {
        if (
          property(entry, "name") !== "" ||
          inventorySize(property(entry, "size")) !== 0
        )
          invalidInventory();
        emptyContent(content);
        continue;
      }
      const path = paths[i];
      const name = property(entry, "name");
      if (
        (type !== 1 && type !== 2) ||
        typeof path !== "string" ||
        typeof name !== "string" ||
        !name ||
        name.includes("/") ||
        !path.startsWith(String(rootPath)) ||
        active.has(path)
      )
        invalidInventory();
      const withoutSlash = type === 1 ? path.slice(0, -1) : path;
      if (
        (type === 1) !== path.endsWith("/") ||
        withoutSlash.slice(withoutSlash.lastIndexOf("/") + 1) !== name
      )
        invalidInventory();
      active.set(path, type);
      if (type === 1) {
        emptyContent(content);
        count(0);
      } else {
        const size = inventorySize(property(entry, "size"));
        const bytes =
          content === undefined && size === 0
            ? 0
            : binaryContent(content).byteLength;
        if (bytes !== size) invalidInventory();
        count(bytes);
      }
    }
    for (const [path, type] of active) {
      if (type === 5) continue;
      const trimmed = type === 1 ? path.slice(0, -1) : path;
      const parent = active.get(trimmed.slice(0, trimmed.lastIndexOf("/") + 1));
      if (parent !== 1 && parent !== 5) invalidInventory();
    }
  } else {
    const seedKey = "\u0001Sh33tJ5";
    const keys = denseArray(property(book, "keys"));
    const files = inventoryRecord(property(book, "files"));
    const unique = new Set<string>();
    for (const key of keys) {
      if (typeof key !== "string" || unique.has(key)) invalidInventory();
      unique.add(key);
    }
    const own = Reflect.ownKeys(files);
    if (
      own.length !== keys.length ||
      own.some((key) => typeof key !== "string" || !unique.has(key)) ||
      !unique.has("") ||
      !unique.has(seedKey)
    )
      invalidInventory();
    const root = inventoryRecord(property(files, ""));
    if (
      property(root, "name") !== "Root Entry" ||
      property(root, "type") !== 5 ||
      property(root, "size") !== 0
    )
      invalidInventory();
    emptyContent(property(root, "content"));
    const seed = inventoryRecord(property(files, seedKey));
    const seedBytes = binaryContent(property(seed, "content"));
    if (
      property(seed, "name") !== seedKey ||
      property(seed, "type") !== 2 ||
      property(seed, "size") !== 4 ||
      seedBytes.byteLength !== 4 ||
      ![55, 50, 54, 50].every((byte, i) => seedBytes[i] === byte)
    )
      invalidInventory();
    for (const key of unique) {
      if (key === "" || key === seedKey) continue;
      const entry = inventoryRecord(property(files, key));
      if (property(entry, "type") !== 2) invalidInventory();
      const size = inventorySize(property(entry, "size"));
      const content = binaryContent(property(entry, "content"));
      if (size !== content.byteLength || (key.endsWith("/") && size !== 0))
        invalidInventory();
      count(content.byteLength);
    }
  }
  return { archiveEntries, expandedBytes };
}

interface SparseRow {
  index: number;
  values: unknown[];
}

function readSparseWorksheetRows(sheet: XLSX.WorkSheet): SparseRow[] {
  const populatedRows = new Set<number>();
  const populatedColumns = new Set<number>();
  const cells: { row: number; column: number; value: unknown }[] = [];
  for (const address of Object.keys(sheet)) {
    if (address.startsWith("!")) continue;
    if (!/^[A-Z]{1,3}[1-9]\d*$/.test(address))
      throw new BinaryDocumentExtractionError("UNSUPPORTED_LAYOUT");
    const { r, c } = XLSX.utils.decode_cell(address);
    if (r >= 1048576 || c >= 16384)
      throw new BinaryDocumentExtractionError("UNSUPPORTED_LAYOUT");
    populatedRows.add(r);
    populatedColumns.add(c);
    if (
      populatedRows.size > BINARY_DOCUMENT_LIMITS.populatedRows ||
      populatedColumns.size > BINARY_DOCUMENT_LIMITS.populatedColumns
    )
      throw new DocumentExtractionError("LIMIT_EXCEEDED");
    const value: unknown = sheet[address]?.v;
    if (
      value !== undefined &&
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number"
    )
      throw new BinaryDocumentExtractionError("UNSUPPORTED_LAYOUT");
    cells.push({ row: r, column: c, value });
  }
  const rows = new Map<number, unknown[]>();
  for (const cell of cells) {
    let row = rows.get(cell.row);
    if (!row) rows.set(cell.row, (row = []));
    row[cell.column] = cell.value;
  }
  return [...rows]
    .sort(([a], [b]) => a - b)
    .map(([index, values]) => ({ index, values }));
}

export function parseXlsxDocument(
  bytes: Buffer,
  format: "XLS" | "XLSX",
): DocumentExtractionV1 {
  const magic = format === "XLS" ? "d0cf11e0a1b11ae1" : "504b0304";
  if (bytes.subarray(0, magic.length / 2).toString("hex") !== magic)
    throw new BinaryDocumentExtractionError("UNSUPPORTED_CONTAINER");
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(bytes, { type: "buffer", bookFiles: true });
  } catch {
    throw new BinaryDocumentExtractionError("CORRUPT_DOCUMENT");
  }
  if (book.SheetNames.length > 1)
    throw new BinaryDocumentExtractionError("MULTIPLE_SHEETS");
  if (book.SheetNames.length !== 1)
    throw new BinaryDocumentExtractionError("UNSUPPORTED_LAYOUT");
  const inventory = readSpreadsheetInventory(book, format);
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new DocumentExtractionError("INVALID_RESULT");
  const rows = readSparseWorksheetRows(sheet);
  const events: CardDocumentEvent[] = [];
  const date1904 = book.Workbook?.WBProps?.date1904 === true;
  let columns: ColumnMap | null = null;
  let installmentColumn = -1;
  let totalPurchase = false;
  let occurrences = 0;
  let pendingDue: { column: number; reference: string } | null = null;
  const cellRef = (row: number, column: number): string =>
    `${format.toLowerCase()}:sheet:1:cell:${XLSX.utils.encode_cell({ r: row, c: column })}`;
  for (const row of rows) {
    const present = Object.keys(row.values)
      .map(Number)
      .filter((c) => row.values[c] !== undefined && row.values[c] !== null);
    if (!present.length) continue;
    if (pendingDue) {
      const value = row.values[pendingDue.column];
      if (present.length !== 1 || value === undefined || value === null)
        throw new BinaryDocumentExtractionError("UNSUPPORTED_LAYOUT");
      events.push({
        kind: "due",
        raw: String(value),
        reference: cellRef(row.index, pendingDue.column),
        ...(typeof value === "number"
          ? { serialDate: { value, date1904 } }
          : {}),
      });
      pendingDue = null;
      continue;
    }
    const texts = row.values.map((value) => String(value ?? ""));
    const capture = columns
      ? captureSpreadsheetRow(
          row.values,
          row.index + 1,
          columns,
          installmentColumn,
          format,
          date1904,
        )
      : null;
    const dateRow =
      capture !== null &&
      (capture.serialDate !== undefined ||
        /^\s*(?:\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})/.test(capture.date ?? ""));
    const dataRow = capture !== null && (dateRow || capture.amount !== null);
    if (!dataRow && hasHeaderKeywords(texts)) {
      if (columns)
        throw new BinaryDocumentExtractionError("UNSUPPORTED_LAYOUT");
      columns = mapColumns(texts);
      installmentColumn = findInstallmentColumn(texts);
      const normalized = texts.map(removeAccents);
      const dateColumns = normalized.filter((h) =>
        /data|date|dt/.test(h),
      ).length;
      const merchantColumns = normalized.filter(
        (h) =>
          !h.includes("data") &&
          /descri|historico|memo|title|estabelec|lancamento/.test(h),
      ).length;
      const amountColumns = normalized.filter((h) =>
        /valor|amount|montante|quantia/.test(h),
      ).length;
      if (
        dateColumns !== 1 ||
        merchantColumns !== 1 ||
        amountColumns !== 1 ||
        normalized.filter((h) => h.includes("parcela")).length > 1
      )
        throw new BinaryDocumentExtractionError("UNSUPPORTED_LAYOUT");
      totalPurchase = /\b(?:valor\s+)?total\s+da\s+compra\b/.test(
        normalized[columns.amount],
      );
      if (
        (sheet["!merges"] ?? []).some(
          (merge) =>
            merge.e.r > row.index &&
            [
              columns!.date,
              columns!.merchant,
              columns!.amount,
              installmentColumn,
            ].some((c) => c >= merge.s.c && c <= merge.e.c),
        )
      )
        throw new BinaryDocumentExtractionError("UNSUPPORTED_LAYOUT");
      continue;
    }
    let heading = false;
    for (const column of dataRow ? [] : present) {
      const value = row.values[column];
      if (typeof value !== "string") continue;
      if (/^vencimento\s*:?\s*$/i.test(value.trim())) {
        const nextColumn = present.find((c) => c > column);
        if (nextColumn !== undefined) {
          const next = row.values[nextColumn];
          events.push({
            kind: "due",
            raw: String(next),
            reference: cellRef(row.index, nextColumn),
            ...(typeof next === "number"
              ? { serialDate: { value: next, date1904 } }
              : {}),
          });
        } else pendingDue = { column, reference: cellRef(row.index, column) };
        heading = true;
      } else {
        const event = captureDocumentHeading(value, cellRef(row.index, column));
        if (event) {
          events.push(event);
          heading = true;
        }
      }
    }
    if (heading) continue;
    if (!columns || !capture) {
      if (
        present.some((c) =>
          /^\s*(?:\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})/.test(
            String(row.values[c]),
          ),
        )
      )
        throw new BinaryDocumentExtractionError("UNSUPPORTED_LAYOUT");
      continue;
    }
    const first = String(row.values[present[0]] ?? "").trim();
    if (!dateRow && /^(?:total|subtotal|saldo|limite)\b/i.test(first)) {
      if (capture.description?.trim() || capture.installment?.trim())
        throw new BinaryDocumentExtractionError("UNSUPPORTED_LAYOUT");
      continue;
    }
    if (/^(?:data|date|dt)\b/i.test(String(row.values[columns.date] ?? "")))
      throw new BinaryDocumentExtractionError("UNSUPPORTED_LAYOUT");
    if (capture.description === null && capture.amount === null && !dateRow)
      throw new BinaryDocumentExtractionError("UNSUPPORTED_LAYOUT");
    if (++occurrences > IMPORT_SESSION_LIMITS.parsedRowsPerFile)
      throw new DocumentExtractionError("LIMIT_EXCEEDED");
    events.push({
      kind: "row",
      capture: {
        ...capture,
        ...(totalPurchase ? { amountMeaning: "TOTAL_PURCHASE" } : {}),
      },
    });
  }
  if (!columns || !occurrences || pendingDue)
    throw new BinaryDocumentExtractionError("UNSUPPORTED_LAYOUT");
  return buildBinaryCardDocument(events, format, {
    ...inventory,
    pages: 0,
    imagePixels: 0,
    frames: 0,
  });
}
