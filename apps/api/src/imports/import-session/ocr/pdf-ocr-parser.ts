import {
  IMPORT_SESSION_PRIMITIVES,
  PDF_OCR_LIMITS,
  PDF_OCR_MODEL_ID,
  PDF_OCR_MODEL_VERSION_PATTERN,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
  PDF_OCR_VERSION,
  parseInstallmentDateOnlyUtc,
  type PdfOcrDocumentV2,
  type PdfOcrProviderProvenanceV2,
  type PdfOcrProviderRequestTraceV2,
} from "@reformaflow/domain";

export const PdfOcrFailureCode = {
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  PAGE_ACCOUNTING_MISMATCH: "PAGE_ACCOUNTING_MISMATCH",
  CANDIDATE_ACCOUNTING_MISMATCH: "CANDIDATE_ACCOUNTING_MISMATCH",
  INVALID_AMOUNT_CENTS: "INVALID_AMOUNT_CENTS",
  INVALID_DATE: "INVALID_DATE",
  INVALID_INSTALLMENT: "INVALID_INSTALLMENT",
  INVALID_EVIDENCE: "INVALID_EVIDENCE",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  DOCUMENT_UNREADABLE: "DOCUMENT_UNREADABLE",
} as const;
export type PdfOcrFailureCode =
  (typeof PdfOcrFailureCode)[keyof typeof PdfOcrFailureCode];

export type PdfOcrParseResultV2 =
  | { readonly ok: true; readonly value: PdfOcrDocumentV2 }
  | {
      readonly ok: false;
      readonly error: Readonly<{
        code: PdfOcrFailureCode;
        provenance?: PdfOcrProviderProvenanceV2;
      }>;
    };

export interface PdfOcrParseContext {
  readonly artifactSha256: string;
  readonly pageCount: number;
  readonly requestId: string;
  readonly responseId: string;
  readonly modelVersion: unknown;
  readonly usage: Readonly<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
  readonly latencyMs: number;
  readonly requestTrace?: PdfOcrProviderRequestTraceV2;
}

const ROOT_KEYS = [
  "completionStatus",
  "reportedPageCount",
  "pageAccounting",
  "candidates",
] as const;
const PAGE_ACCOUNTING_KEYS = [
  "pageNumber",
  "status",
  "visibleOccurrenceCount",
] as const;
const CANDIDATE_KEYS = [
  "pageNumber",
  "pageOccurrenceIndex",
  "description",
  "amountCents",
  "amountMeaning",
  "date",
  "installment",
  "evidenceText",
] as const;
const INSTALLMENT_KEYS = ["index", "total"] as const;
const HASH = new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern);
const REQUEST_ID = new RegExp(IMPORT_SESSION_PRIMITIVES.requestIdPattern);
const MODEL_VERSION = new RegExp(PDF_OCR_MODEL_VERSION_PATTERN);
const CENTS = /^(?:0|-?[1-9][0-9]*)$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const COMPLETION_STATUS = Object.freeze({
  COMPLETE: "COMPLETE",
  OCCURRENCE_LIMIT_EXCEEDED: "OCCURRENCE_LIMIT_EXCEEDED",
  INCOMPLETE: "INCOMPLETE",
} as const);
const PAGE_STATUS = Object.freeze({
  READABLE: "READABLE",
  EMPTY: "EMPTY",
  UNREADABLE: "UNREADABLE",
} as const);
type ParsedPageAccounting = Readonly<{
  pageNumber: number;
  status: (typeof PAGE_STATUS)[keyof typeof PAGE_STATUS];
  visibleOccurrenceCount: number;
}>;

const failure = (
  code: PdfOcrFailureCode,
  provenance?: PdfOcrProviderProvenanceV2,
): PdfOcrParseResultV2 => ({
  ok: false,
  error: { code, ...(provenance ? { provenance } : {}) },
});
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === null ||
    Object.getPrototypeOf(Object.getPrototypeOf(value)) === null);
const exact = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  record(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const boundedCounter = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= IMPORT_SESSION_PRIMITIVES.maxRevision;
const cleanText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= max &&
  value.normalize("NFC") === value &&
  !CONTROL.test(value);

function validContext(value: PdfOcrParseContext): boolean {
  return (
    HASH.test(value.artifactSha256) &&
    Number.isSafeInteger(value.pageCount) &&
    value.pageCount >= 1 &&
    value.pageCount <= PDF_OCR_LIMITS.pagesPerFile &&
    REQUEST_ID.test(value.requestId) &&
    cleanText(value.responseId, PDF_OCR_LIMITS.providerRequestIdLength) &&
    typeof value.modelVersion === "string" &&
    MODEL_VERSION.test(value.modelVersion) &&
    boundedCounter(value.usage.inputTokens) &&
    boundedCounter(value.usage.outputTokens) &&
    boundedCounter(value.usage.totalTokens) &&
    value.usage.inputTokens + value.usage.outputTokens ===
      value.usage.totalTokens &&
    boundedCounter(value.latencyMs)
  );
}

function provenance(context: PdfOcrParseContext): PdfOcrProviderProvenanceV2 {
  return {
    provider: PDF_OCR_PROVIDER_ID,
    model: PDF_OCR_MODEL_ID,
    modelVersion: context.modelVersion as string,
    region: PDF_OCR_REGION,
    requestId: context.requestId,
    responseId: context.responseId,
    usage: { ...context.usage },
    latencyMs: context.latencyMs,
    ...(context.requestTrace ? { requestTrace: context.requestTrace } : {}),
  };
}

/** Exact bounded provider-payload parser; document identity stays server-side. */
export function parsePdfOcrV2(
  payload: unknown,
  context: PdfOcrParseContext,
): PdfOcrParseResultV2 {
  if (!validContext(context)) return failure(PdfOcrFailureCode.INVALID_PAYLOAD);
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    return failure(PdfOcrFailureCode.INVALID_PAYLOAD);
  }
  if (bytes > PDF_OCR_LIMITS.providerResponseBytes)
    return failure(PdfOcrFailureCode.LIMIT_EXCEEDED);
  if (
    !exact(payload, ROOT_KEYS) ||
    (payload.completionStatus !== COMPLETION_STATUS.COMPLETE &&
      payload.completionStatus !==
        COMPLETION_STATUS.OCCURRENCE_LIMIT_EXCEEDED &&
      payload.completionStatus !== COMPLETION_STATUS.INCOMPLETE) ||
    !Number.isSafeInteger(payload.reportedPageCount) ||
    payload.reportedPageCount !== context.pageCount ||
    !Array.isArray(payload.pageAccounting) ||
    payload.pageAccounting.length !== context.pageCount ||
    !Array.isArray(payload.candidates)
  )
    return failure(PdfOcrFailureCode.INVALID_PAYLOAD);

  let visibleOccurrenceCount = 0;
  let hasUnreadablePage = false;
  const pageAccounting: ParsedPageAccounting[] = [];
  for (const [index, page] of payload.pageAccounting.entries()) {
    if (
      !exact(page, PAGE_ACCOUNTING_KEYS) ||
      page.pageNumber !== index + 1 ||
      (page.status !== PAGE_STATUS.READABLE &&
        page.status !== PAGE_STATUS.EMPTY &&
        page.status !== PAGE_STATUS.UNREADABLE) ||
      !boundedCounter(page.visibleOccurrenceCount) ||
      (page.status === PAGE_STATUS.READABLE &&
        page.visibleOccurrenceCount === 0) ||
      (page.status !== PAGE_STATUS.READABLE &&
        page.visibleOccurrenceCount !== 0)
    )
      return failure(PdfOcrFailureCode.PAGE_ACCOUNTING_MISMATCH);
    visibleOccurrenceCount += page.visibleOccurrenceCount as number;
    if (!Number.isSafeInteger(visibleOccurrenceCount))
      return failure(PdfOcrFailureCode.PAGE_ACCOUNTING_MISMATCH);
    if (page.status === PAGE_STATUS.UNREADABLE) hasUnreadablePage = true;
    pageAccounting.push({
      pageNumber: page.pageNumber as number,
      status: page.status as ParsedPageAccounting["status"],
      visibleOccurrenceCount: page.visibleOccurrenceCount as number,
    });
  }

  const completionStatus = payload.completionStatus;
  const providerProvenance = provenance(context);
  if (completionStatus === COMPLETION_STATUS.OCCURRENCE_LIMIT_EXCEEDED) {
    if (
      hasUnreadablePage ||
      visibleOccurrenceCount <= PDF_OCR_LIMITS.candidatesPerFile ||
      payload.candidates.length !== 0
    )
      return failure(PdfOcrFailureCode.PAGE_ACCOUNTING_MISMATCH);
    return failure(PdfOcrFailureCode.LIMIT_EXCEEDED, providerProvenance);
  }
  if (completionStatus === COMPLETION_STATUS.INCOMPLETE) {
    if (!hasUnreadablePage || payload.candidates.length !== 0)
      return failure(PdfOcrFailureCode.PAGE_ACCOUNTING_MISMATCH);
    return failure(PdfOcrFailureCode.DOCUMENT_UNREADABLE, providerProvenance);
  }
  if (
    hasUnreadablePage ||
    visibleOccurrenceCount > PDF_OCR_LIMITS.candidatesPerFile ||
    payload.candidates.length !== visibleOccurrenceCount
  )
    return failure(PdfOcrFailureCode.PAGE_ACCOUNTING_MISMATCH);

  const parsed: PdfOcrDocumentV2["candidates"][number][] = [];
  let candidateOffset = 0;
  for (const page of pageAccounting) {
    const count = page.visibleOccurrenceCount;
    for (let pageOccurrenceIndex = 1; pageOccurrenceIndex <= count; ) {
      const raw = payload.candidates[candidateOffset];
      if (!exact(raw, CANDIDATE_KEYS))
        return failure(PdfOcrFailureCode.PAGE_ACCOUNTING_MISMATCH);
      if (
        raw.pageNumber !== page.pageNumber ||
        raw.pageOccurrenceIndex !== pageOccurrenceIndex
      )
        return failure(PdfOcrFailureCode.CANDIDATE_ACCOUNTING_MISMATCH);
      pageOccurrenceIndex++;
      candidateOffset++;
      if (
        !cleanText(raw.evidenceText, PDF_OCR_LIMITS.evidenceLength) ||
        (raw.description !== null &&
          !cleanText(raw.description, PDF_OCR_LIMITS.descriptionLength))
      )
        return failure(PdfOcrFailureCode.INVALID_EVIDENCE);
      if (
        raw.amountCents !== null &&
        (typeof raw.amountCents !== "string" || !CENTS.test(raw.amountCents))
      )
        return failure(PdfOcrFailureCode.INVALID_AMOUNT_CENTS);
      const amount = raw.amountCents === null ? null : Number(raw.amountCents);
      if (
        amount !== null &&
        (!Number.isSafeInteger(amount) ||
          amount < IMPORT_SESSION_PRIMITIVES.minCents ||
          amount > IMPORT_SESSION_PRIMITIVES.maxCents)
      )
        return failure(PdfOcrFailureCode.INVALID_AMOUNT_CENTS);
      if (
        raw.amountMeaning !== "LINE_AMOUNT" &&
        raw.amountMeaning !== "UNKNOWN"
      )
        return failure(PdfOcrFailureCode.INVALID_AMOUNT_CENTS);
      if (
        raw.date !== null &&
        (typeof raw.date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(raw.date) ||
          !parseInstallmentDateOnlyUtc(raw.date))
      )
        return failure(PdfOcrFailureCode.INVALID_DATE);
      if (raw.installment !== null) {
        if (
          !exact(raw.installment, INSTALLMENT_KEYS) ||
          !Number.isSafeInteger(raw.installment.index) ||
          !Number.isSafeInteger(raw.installment.total) ||
          (raw.installment.index as number) < 1 ||
          (raw.installment.total as number) < 1 ||
          (raw.installment.index as number) >
            (raw.installment.total as number) ||
          (raw.installment.total as number) >
            PDF_OCR_LIMITS.installmentsPerPurchase
        )
          return failure(PdfOcrFailureCode.INVALID_INSTALLMENT);
      }
      const pageNumber = raw.pageNumber as number;
      parsed.push({
        pageNumber,
        description: raw.description as string | null,
        amountCents: raw.amountCents as string | null,
        amountMeaning: raw.amountMeaning,
        date: raw.date as string | null,
        installment: raw.installment as {
          index: number;
          total: number;
        } | null,
        evidence: { pageNumber, text: raw.evidenceText as string },
      });
    }
  }
  if (candidateOffset !== payload.candidates.length)
    return failure(PdfOcrFailureCode.CANDIDATE_ACCOUNTING_MISMATCH);
  return {
    ok: true,
    value: {
      version: PDF_OCR_VERSION,
      artifactSha256: context.artifactSha256,
      pageCount: context.pageCount,
      provenance: providerProvenance,
      candidates: parsed,
    },
  };
}
