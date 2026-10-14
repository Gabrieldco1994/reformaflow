import {
  IMPORT_SESSION_PRIMITIVES,
  PDF_OCR_LIMITS,
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  type PdfOcrDocumentV2,
} from "@reformaflow/domain";

export const PDF_OCR_PROVIDER = Symbol("PDF_OCR_PROVIDER");

export interface FixedPdfOcrProviderRequest {
  readonly artifactSha256: string;
  readonly pageCount: number;
  readonly requestId: string;
  /** Original immutable application/pdf bytes from the private vault. */
  readonly pdfBytes: Buffer;
  /** Request disconnect, vault stop and parser-lease cancellation. */
  readonly signal: AbortSignal;
}

const HASH = new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern);
const REQUEST_ID = new RegExp(IMPORT_SESSION_PRIMITIVES.requestIdPattern);

export function isAdmittedPdfOcrRequest(
  request: FixedPdfOcrProviderRequest,
): boolean {
  const candidate: unknown = request;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  )
    return false;
  const value = candidate as Partial<FixedPdfOcrProviderRequest>;
  return (
    typeof value.artifactSha256 === "string" &&
    HASH.test(value.artifactSha256) &&
    Number.isSafeInteger(value.pageCount) &&
    value.pageCount! >= 1 &&
    value.pageCount! <= PDF_OCR_LIMITS.pagesPerFile &&
    typeof value.requestId === "string" &&
    REQUEST_ID.test(value.requestId) &&
    Buffer.isBuffer(value.pdfBytes) &&
    value.pdfBytes.length > 0 &&
    value.pdfBytes.subarray(0, 8).toString("ascii").startsWith("%PDF-") &&
    value.signal instanceof AbortSignal &&
    !value.signal.aborted
  );
}

/** One fixed provider/model only; no selector, fallback, File API or cache. */
export interface FixedPdfOcrProviderPort {
  readonly provider: typeof PDF_OCR_PROVIDER_ID;
  readonly model: typeof PDF_OCR_MODEL_ID;
  ready(): boolean;
  extractPdf(request: FixedPdfOcrProviderRequest): Promise<PdfOcrDocumentV2>;
}
