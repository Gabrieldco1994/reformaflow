import { Worker } from "node:worker_threads";
import { join } from "node:path";
import {
  IMPORT_SESSION_LIMITS as LIMITS,
  ImportSessionErrorCode as Code,
} from "@reformaflow/domain";
import { ImportSessionError } from "../../imports/import-session/import-session.errors";
import { validateDocumentExtraction } from "./statement-document";
import {
  buildCardDocument,
  type CardDocumentCapture,
  type DocumentExtractionV1,
} from "./types";

const WORKER_MEMORY_MB = 128;
const OPERATOR_LIMIT = 200_000;
const DEADLINE_MS = 60_000;
// Detection only, never date parsing: date-shaped rows with a description must
// not disappear, even when their amount is missing or unreadable.
const UNSUPPORTED_DATE_ROW = /^\s*\d+[./-]+\d+\S*\s+(.+?)\s*$/;
// Only this complete documentary label is exempt, never a label prefix with
// additional merchant/amount content. Headers with an internal date don't match.
const DATE_ONLY_DOCUMENTARY_HEADER = /^vencimento$/i;
const ERROR_CODES: readonly Code[] = [
  Code.OCR_REQUIRED,
  Code.DOCUMENT_UNREADABLE,
  Code.PDF_PASSWORD_REQUIRED,
  Code.LIMIT_EXCEEDED,
];
type Page = { num: number; text: string };
type PdfWorkerResult =
  | { pages: unknown[] }
  | {
      code: string;
      rasterObserved?: boolean;
      pageCount?: number;
    };
export type PdfDocumentInspection =
  | { readonly kind: "LOCAL"; readonly document: DocumentExtractionV1 }
  | { readonly kind: "OCR_ELIGIBLE"; readonly pageCount: number };
function pages(value: unknown): Page[] {
  if (!value || typeof value !== "object")
    throw new ImportSessionError(Code.DOCUMENT_UNREADABLE);
  if ("code" in value) {
    const code = ERROR_CODES.find((code) => code === value.code);
    throw new ImportSessionError(code ?? Code.DOCUMENT_UNREADABLE);
  }
  if (
    !("pages" in value) ||
    !Array.isArray(value.pages) ||
    value.pages.length < 1 ||
    value.pages.length > LIMITS.pdfPagesPerFile
  )
    throw new ImportSessionError(Code.DOCUMENT_UNREADABLE);
  return value.pages.map((page: unknown, index: number) => {
    if (
      !page ||
      typeof page !== "object" ||
      !("num" in page) ||
      page.num !== index + 1 ||
      !("text" in page) ||
      typeof page.text !== "string" ||
      !page.text.trim()
    )
      throw new ImportSessionError(Code.OCR_REQUIRED);
    return { num: page.num, text: page.text };
  });
}

/** Result is delivered only after worker exit; abort/deadline also await termination. */
async function runPdfWorker(
  bytes: Buffer,
  signal?: AbortSignal,
  deadlineMs: number = DEADLINE_MS,
): Promise<PdfWorkerResult> {
  if (bytes.length > LIMITS.bytesPerFile)
    throw new ImportSessionError(Code.LIMIT_EXCEEDED);
  if (!bytes.subarray(0, 8).toString("ascii").startsWith("%PDF-"))
    throw new ImportSessionError(Code.DOCUMENT_UNREADABLE);
  if (signal?.aborted) throw new ImportSessionError(Code.LEASE_CONFLICT);
  return new Promise<PdfWorkerResult>((resolve, reject) => {
    const worker = new Worker(join(__dirname, "pdf-document.worker.mjs"), {
      workerData: {
        bytes,
        maxPages: LIMITS.pdfPagesPerFile,
        maxOperators: OPERATOR_LIMIT,
        maxOutputBytes: LIMITS.bytesPerFile,
      },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB },
    });
    let output: unknown;
    let failure: Error | undefined;
    const stop = (code: Code): void => {
      if (failure) return;
      failure = new ImportSessionError(code);
      void worker.terminate();
    };
    const abort = (): void => stop(Code.LEASE_CONFLICT);
    const timer = setTimeout(
      () => stop(Code.LIMIT_EXCEEDED),
      Math.max(0, deadlineMs),
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.once("message", (value: unknown) => {
      output = value;
    });
    worker.once("error", () => {
      failure ??= new ImportSessionError(Code.DOCUMENT_UNREADABLE);
    });
    worker.once("exit", (code: number) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0 || output === undefined)
        reject(new ImportSessionError(Code.DOCUMENT_UNREADABLE));
      else resolve(output as PdfWorkerResult);
    });
  });
}

/** Local inspection always runs first and positively identifies raster content. */
export async function inspectPdfDocument(
  bytes: Buffer,
  signal?: AbortSignal,
  deadlineMs: number = DEADLINE_MS,
): Promise<PdfDocumentInspection> {
  const result = await runPdfWorker(bytes, signal, deadlineMs);
  if (
    "code" in result &&
    result.code === Code.OCR_REQUIRED &&
    result.rasterObserved === true &&
    Number.isSafeInteger(result.pageCount) &&
    result.pageCount! >= 1
  )
    return { kind: "OCR_ELIGIBLE", pageCount: result.pageCount! };
  const extracted = pages(result);
  const captures: CardDocumentCapture[] = [];
  let invoice = false;
  for (const page of extracted) {
    const lines = page.text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (/\bfatura\b/i.test(line)) invoice = true;
      const match =
        /^\s*(\d{1,2}\/\d{1,2}(?:\/\d{4})?|\d{4}-\d{2}-\d{2})\s+(.+?)(?:\s+(?:R\$\s*)?([+-]?\s*\d[\d.,]*))?\s*$/.exec(
          line,
        );
      if (!match) {
        const unsupported = UNSUPPORTED_DATE_ROW.exec(line);
        if (unsupported && !DATE_ONLY_DOCUMENTARY_HEADER.test(unsupported[1]))
          throw new ImportSessionError(Code.DOCUMENT_UNREADABLE);
        continue;
      }
      captures.push({
        reference: `pdf:page:${page.num}:line:${index + 1}`,
        date: match[1],
        description: match[2],
        amount: match[3]?.replace(/\s/g, "") ?? null,
        fitId: null,
        section: "CURRENT",
      });
    }
  }
  const document = buildCardDocument(
    captures,
    "PDF",
    invoice ? "INVOICE" : "UNKNOWN",
  );
  return {
    kind: "LOCAL",
    document: validateDocumentExtraction({
      ...document,
      parserVersion: "card-local-pdf-v1",
      metrics: { ...document.metrics, pages: extracted.length },
    }),
  };
}

export async function extractPdfDocument(
  bytes: Buffer,
  signal?: AbortSignal,
  deadlineMs: number = DEADLINE_MS,
): Promise<DocumentExtractionV1> {
  const inspected = await inspectPdfDocument(bytes, signal, deadlineMs);
  if (inspected.kind === "OCR_ELIGIBLE")
    throw new ImportSessionError(Code.OCR_REQUIRED);
  return inspected.document;
}
