import { isUtf8 } from "node:buffer";
import {
  IMPORT_SESSION_LIMITS as LIMITS,
  IMPORT_SESSION_PRIMITIVES as PRIMITIVES,
  isInvoiceDueMonth,
  parseInstallmentDateOnlyUtc,
} from "@reformaflow/domain";
import { parseCsvDocument } from "./csv";
import { computeImportOrdinals } from "./dedupe-key";
import {
  DocumentExtractionError,
  type CardStatementDocumentInputV1,
  type CardStatementBinaryDocumentInputV1,
  type DocumentDiagnosticV1,
  type DocumentExtractionV1,
  type DocumentOccurrenceV1,
} from "./types";

export {
  BinaryDocumentExtractionError,
  DocumentExtractionError,
} from "./types";

const INPUT_KEYS = ["version", "context", "format", "profile", "bytes"];
const DOCUMENT_KEYS = [
  "version",
  "parserVersion",
  "documentKind",
  "invoiceDueMonth",
  "metrics",
  "occurrences",
  "diagnostics",
];
const METRIC_KEYS = [
  "pages",
  "rows",
  "expandedBytes",
  "archiveEntries",
  "imagePixels",
  "frames",
];
const OCCURRENCE_KEYS = [
  "reference",
  "sourceOrdinal",
  "section",
  "raw",
  "cycle",
  "dateOnly",
  "merchant",
  "amountCents",
  "amountMeaning",
  "installmentCount",
  "installmentIndex",
  "fitId",
  "identityOrdinal",
];
const DIAGNOSTIC_CODES: readonly DocumentDiagnosticV1["code"][] = [
  "UNREADABLE_ROW",
  "UNKNOWN_DATE",
  "UNKNOWN_AMOUNT_MEANING",
  "UNSUPPORTED_CONTENT",
  "INVALID_CALENDAR_DATE",
  "AMBIGUOUS_CYCLE",
  "OVERLONG_FIELD",
];

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        descriptor.enumerable === true &&
        "value" in descriptor
      );
    })
  );
}

function jsonArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return false;
  const own = Reflect.ownKeys(value);
  if (own.length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      return false;
  }
  return true;
}

const oneOf = <T extends string>(
  value: unknown,
  options: readonly T[],
): value is T =>
  typeof value === "string" && options.some((option) => option === value);
const integer = (
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;
const text = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" &&
  value.length >= min &&
  value.length <= max &&
  value.normalize("NFC") === value;
const reference = (value: unknown): value is string =>
  text(value, 1, PRIMITIVES.maxReferenceLength);
const rawText = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const dateOnly = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const date = parseInstallmentDateOnlyUtc(value);
  return (
    date !== null &&
    date.getUTCFullYear() >= PRIMITIVES.minYear &&
    date.getUTCFullYear() <= PRIMITIVES.maxYear
  );
};
const month = (value: unknown): value is string =>
  typeof value === "string" &&
  isInvoiceDueMonth(value) &&
  dateOnly(`${value}-01`);

function occurrence(value: unknown): value is DocumentOccurrenceV1 {
  if (
    !exactRecord(value, OCCURRENCE_KEYS) ||
    !reference(value.reference) ||
    !integer(value.sourceOrdinal) ||
    !oneOf(value.section, ["CURRENT", "FUTURE", "UNKNOWN"]) ||
    !exactRecord(value.raw, ["date", "description", "amount", "installment"]) ||
    !Object.values(value.raw).every(rawText) ||
    !(
      value.cycle === null ||
      (exactRecord(value.cycle, ["invoiceDueMonth", "reference"]) &&
        month(value.cycle.invoiceDueMonth) &&
        reference(value.cycle.reference))
    ) ||
    !(value.dateOnly === null || dateOnly(value.dateOnly)) ||
    !(
      value.merchant === null ||
      text(value.merchant, 1, PRIMITIVES.maxSupplierLength)
    ) ||
    !(
      value.amountCents === null ||
      integer(value.amountCents, PRIMITIVES.minCents, PRIMITIVES.maxCents)
    ) ||
    !oneOf(value.amountMeaning, [
      "TOTAL_PURCHASE",
      "INSTALLMENT_CHARGE",
      "UNKNOWN",
    ]) ||
    !(value.installmentCount === null || integer(value.installmentCount, 1)) ||
    !(value.installmentIndex === null || integer(value.installmentIndex, 1)) ||
    !(
      value.fitId === null ||
      text(value.fitId, 0, PRIMITIVES.maxReferenceLength)
    ) ||
    !(value.identityOrdinal === null || integer(value.identityOrdinal))
  )
    return false;
  return (
    value.installmentIndex === null ||
    (value.installmentCount !== null &&
      value.installmentIndex <= value.installmentCount)
  );
}

function diagnostic(value: unknown): value is DocumentDiagnosticV1 {
  return (
    exactRecord(value, ["reference", "code"]) &&
    (value.reference === null || reference(value.reference)) &&
    oneOf(value.code, DIAGNOSTIC_CODES)
  );
}

function binaryPosition(
  reference: string,
  version: DocumentExtractionV1["parserVersion"],
  pages: number,
  cycle = false,
): [number, number] | null {
  if (version === "card-local-pdf-v1") {
    const match = /^pdf:page:([1-9]\d*):line:([1-9]\d*)$/.exec(reference);
    if (
      !match ||
      !integer(Number(match[1]), 1, pages) ||
      !integer(Number(match[2]), 1)
    )
      return null;
    return [Number(match[1]), Number(match[2])];
  }
  const prefix = version === "card-local-xls-v1" ? "xls" : "xlsx";
  if (cycle) {
    const match = /^(xls|xlsx):sheet:1:cell:([A-Z]{1,3})([1-9]\d*)$/.exec(
      reference,
    );
    if (!match || match[1] !== prefix || !integer(Number(match[3]), 1, 1048576))
      return null;
    let column = 0;
    for (const letter of match[2])
      column = column * 26 + letter.charCodeAt(0) - 64;
    return column <= 16384 ? [1, Number(match[3])] : null;
  }
  const match = /^(xls|xlsx):sheet:1:row:([1-9]\d*)$/.exec(reference);
  return match && match[1] === prefix && integer(Number(match[2]), 1, 1048576)
    ? [1, Number(match[2])]
    : null;
}

function document(value: unknown): value is DocumentExtractionV1 {
  if (
    !exactRecord(value, DOCUMENT_KEYS) ||
    value.version !== 1 ||
    !oneOf(value.parserVersion, [
      "card-local-text-v1",
      "card-local-pdf-v1",
      "card-local-xls-v1",
      "card-local-xlsx-v1",
    ]) ||
    !oneOf(value.documentKind, [
      "INVOICE",
      "BANK_STATEMENT",
      "RECEIPT",
      "UNKNOWN",
    ]) ||
    !(value.invoiceDueMonth === null || month(value.invoiceDueMonth)) ||
    !exactRecord(value.metrics, METRIC_KEYS) ||
    !jsonArray(value.occurrences) ||
    !value.occurrences.every(occurrence) ||
    !jsonArray(value.diagnostics) ||
    !value.diagnostics.every(diagnostic)
  )
    return false;
  const metrics = value.metrics;
  const binary = value.parserVersion !== "card-local-text-v1";
  if (
    !METRIC_KEYS.every((key) => integer(metrics[key])) ||
    metrics.rows !== value.occurrences.length ||
    (!binary && METRIC_KEYS.some((key) => key !== "rows" && metrics[key] !== 0))
  )
    return false;
  if (
    binary &&
    (metrics.rows === 0 ||
      metrics.imagePixels !== 0 ||
      metrics.frames !== 0 ||
      (value.parserVersion === "card-local-pdf-v1"
        ? !integer(metrics.pages, 1) ||
          metrics.archiveEntries !== 0 ||
          metrics.expandedBytes !== 0
        : metrics.pages !== 0 || !integer(metrics.archiveEntries, 1)))
  )
    return false;

  const references = new Set<string>();
  let previousPage = 0;
  let previousRecord = 0;
  let previousFormat: string | null = null;
  const identities: { date: Date; merchant: string; amountCents: number }[] =
    [];
  for (const [index, row] of value.occurrences.entries()) {
    if (row.sourceOrdinal !== index || references.has(row.reference))
      return false;
    if (binary) {
      const position = binaryPosition(
        row.reference,
        value.parserVersion,
        Number(metrics.pages),
      );
      if (
        !position ||
        position[0] < previousPage ||
        (position[0] === previousPage && position[1] <= previousRecord) ||
        (row.cycle !== null &&
          !binaryPosition(
            row.cycle.reference,
            value.parserVersion,
            Number(metrics.pages),
            true,
          ))
      )
        return false;
      [previousPage, previousRecord] = position;
    } else {
      const locator = /^(csv:record|ofx:stmttrn):([1-9]\d*)$/.exec(
        row.reference,
      );
      if (!locator) return false;
      const record = Number(locator[2]);
      if (
        !integer(record, locator[1] === "csv:record" ? 2 : 1) ||
        record <= previousRecord ||
        (previousFormat !== null && locator[1] !== previousFormat)
      )
        return false;
      previousRecord = record;
      previousFormat = locator[1];
    }
    references.add(row.reference);
    if (
      row.dateOnly !== null &&
      row.merchant !== null &&
      row.amountCents !== null
    ) {
      identities.push({
        date: new Date(`${row.dateOnly}T00:00:00.000Z`),
        merchant: row.merchant,
        amountCents: row.amountCents,
      });
    } else if (row.identityOrdinal !== null) return false;
  }
  const ordinals = computeImportOrdinals(identities);
  let index = 0;
  for (const row of value.occurrences) {
    if (
      row.dateOnly !== null &&
      row.merchant !== null &&
      row.amountCents !== null &&
      row.identityOrdinal !== ordinals[index++]
    )
      return false;
  }
  return value.diagnostics.every(
    (item) => item.reference === null || references.has(item.reference),
  );
}

/**
 * The new extraction envelope deliberately reuses bytesPerFile, not the 1 MiB
 * draft cap. Only validated data enters this bounded counter: no toJSON/getters.
 */
function assertDocumentEnvelope(value: DocumentExtractionV1): void {
  let bytes = 0;
  const add = (count: number) => {
    bytes += count;
    if (bytes > LIMITS.bytesPerFile)
      throw new DocumentExtractionError("LIMIT_EXCEEDED");
  };
  const string = (value: string) => {
    add(2);
    // A chunk is allocation granularity, not an additional document/field cap.
    const chunkUnits = 4096;
    for (let start = 0; start < value.length; ) {
      let end = Math.min(value.length, start + chunkUnits);
      const last = value.charCodeAt(end - 1);
      const next = value.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
        end--;
      add(
        Buffer.byteLength(JSON.stringify(value.slice(start, end)), "utf8") - 2,
      );
      start = end;
    }
  };
  const count = (item: unknown): void => {
    if (item === null) {
      add(4);
      return;
    }
    if (typeof item === "string") {
      string(item);
      return;
    }
    if (typeof item === "number") {
      add(String(item).length);
      return;
    }
    if (Array.isArray(item)) {
      add(2 + Math.max(0, item.length - 1));
      for (const element of item) count(element);
      return;
    }
    if (typeof item === "object") {
      const entries = Object.entries(item);
      add(2 + Math.max(0, entries.length - 1));
      for (const [key, child] of entries) {
        string(key);
        add(1);
        count(child);
      }
      return;
    }
    throw new DocumentExtractionError("INVALID_RESULT");
  };
  count(value);
}

export function validateDocumentExtraction(
  value: unknown,
): DocumentExtractionV1 {
  if (!document(value)) throw new DocumentExtractionError("INVALID_RESULT");
  if (value.occurrences.length > LIMITS.parsedRowsPerFile)
    throw new DocumentExtractionError("LIMIT_EXCEEDED");
  if (
    value.parserVersion !== "card-local-text-v1" &&
    (value.metrics.pages > LIMITS.pdfPagesPerFile ||
      value.metrics.archiveEntries > LIMITS.expandedArchiveEntries ||
      value.metrics.expandedBytes > LIMITS.expandedArchiveBytes)
  )
    throw new DocumentExtractionError("LIMIT_EXCEEDED");
  assertDocumentEnvelope(value);
  return Object.freeze({
    ...value,
    metrics: Object.freeze({ ...value.metrics }),
    occurrences: Object.freeze(
      value.occurrences.map((row) =>
        Object.freeze({
          ...row,
          raw: Object.freeze({ ...row.raw }),
          cycle: row.cycle === null ? null : Object.freeze({ ...row.cycle }),
        }),
      ),
    ),
    diagnostics: Object.freeze(
      value.diagnostics.map((item) => Object.freeze({ ...item })),
    ),
  });
}

export function extractCardStatementDocument(
  input: CardStatementDocumentInputV1,
): DocumentExtractionV1 {
  if (
    !exactRecord(input, INPUT_KEYS) ||
    input.version !== 1 ||
    input.context !== "CARD_INVOICE" ||
    !Buffer.isBuffer(input.bytes) ||
    !(
      input.format === "CSV" && oneOf(input.profile, ["CSV_NUBANK", "CSV_ITAU"])
    )
  ) {
    throw new DocumentExtractionError("INVALID_INPUT");
  }
  if (input.bytes.length > LIMITS.bytesPerFile)
    throw new DocumentExtractionError("LIMIT_EXCEEDED");
  if (!isUtf8(input.bytes) || input.bytes.includes(0))
    throw new DocumentExtractionError("UNSUPPORTED_DOCUMENT");
  const content = input.bytes.toString("utf8");
  const result = parseCsvDocument(
    content,
    input.profile as "CSV_NUBANK" | "CSV_ITAU",
  );
  return validateDocumentExtraction(result);
}

export async function extractCardStatementBinaryDocument(
  input: CardStatementBinaryDocumentInputV1,
): Promise<DocumentExtractionV1> {
  if (
    !exactRecord(input, INPUT_KEYS) ||
    input.version !== 1 ||
    input.context !== "CARD_INVOICE" ||
    !Buffer.isBuffer(input.bytes) ||
    !(
      (input.format === "PDF" && input.profile === "PDF_TEXT_CARD") ||
      (input.format === "XLS" && input.profile === "XLS_CARD") ||
      (input.format === "XLSX" && input.profile === "XLSX_CARD")
    )
  )
    throw new DocumentExtractionError("INVALID_INPUT");
  if (input.bytes.length > LIMITS.bytesPerFile)
    throw new DocumentExtractionError("LIMIT_EXCEEDED");
  // Protocol remains available for the inactive runner; this release admits CSV only.
  throw new DocumentExtractionError("UNSUPPORTED_DOCUMENT");
}
