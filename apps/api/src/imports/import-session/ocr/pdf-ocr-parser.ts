import {
  IMPORT_SESSION_PRIMITIVES,
  PDF_OCR_LIMITS,
  PDF_OCR_DOCUMENT_VERSION,
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
const CANDIDATE_V3_KEYS = [
  "pageNumber",
  "pageOccurrenceIndex",
  "description",
  "amountCents",
  "sign",
  "amountMeaning",
  "dateText",
  "normalizedDate",
  "dateExplicitness",
  "installment",
  "evidenceText",
] as const;
const INSTALLMENT_KEYS = ["index", "total"] as const;
const HASH = new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern);
const REQUEST_ID = new RegExp(IMPORT_SESSION_PRIMITIVES.requestIdPattern);
const MODEL_VERSION = new RegExp(PDF_OCR_MODEL_VERSION_PATTERN);
const CENTS = /^(?:0|-?[1-9][0-9]*)$/;
const FULL_DATE_TEXT = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const YEARLESS_DATE_TEXT = /^(\d{2})\/(\d{2})$/;
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

type ParsedDate = Readonly<{
  dateText: string | null;
  normalizedDate: string | null;
  dateExplicitness: "FULL" | "YEARLESS" | "MISSING" | "UNKNOWN";
  dateOnly: string | null;
}>;

function calendarDate(year: number, month: number, day: number): boolean {
  const value = new Date(Date.UTC(year, month - 1, day));
  return (
    value.getUTCFullYear() === year &&
    value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day
  );
}

function parseCandidateDate(raw: Record<string, unknown>): ParsedDate | null {
  const explicitness = raw.dateExplicitness;
  if (
    explicitness !== "FULL" &&
    explicitness !== "YEARLESS" &&
    explicitness !== "MISSING" &&
    explicitness !== "UNKNOWN"
  )
    return null;
  if (explicitness === "MISSING")
    return raw.dateText === null && raw.normalizedDate === null
      ? {
          dateText: null,
          normalizedDate: null,
          dateExplicitness: "MISSING",
          dateOnly: null,
        }
      : null;
  if (explicitness === "UNKNOWN")
    return raw.normalizedDate === null &&
      (raw.dateText === null ||
        cleanText(raw.dateText, PDF_OCR_LIMITS.evidenceLength))
      ? {
          dateText: raw.dateText as string | null,
          normalizedDate: null,
          dateExplicitness: "UNKNOWN",
          dateOnly: null,
        }
      : null;
  if (typeof raw.dateText !== "string") return null;
  if (explicitness === "YEARLESS") {
    const match = YEARLESS_DATE_TEXT.exec(raw.dateText);
    if (
      raw.normalizedDate !== null ||
      !match ||
      !calendarDate(2000, Number(match[2]), Number(match[1]))
    )
      return null;
    return {
      dateText: raw.dateText,
      normalizedDate: null,
      dateExplicitness: "YEARLESS",
      dateOnly: null,
    };
  }
  if (typeof raw.normalizedDate !== "string") return null;
  const match = FULL_DATE_TEXT.exec(raw.dateText);
  if (
    !match ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raw.normalizedDate) ||
    !parseInstallmentDateOnlyUtc(raw.normalizedDate)
  )
    return null;
  const expected = `${match[3]}-${match[2]}-${match[1]}`;
  if (raw.normalizedDate !== expected) return null;
  return {
    dateText: raw.dateText,
    normalizedDate: raw.normalizedDate,
    dateExplicitness: "FULL",
    dateOnly: raw.normalizedDate,
  };
}

function signForCents(
  value: string | null,
): "NEGATIVE" | "ZERO" | "POSITIVE" | "UNKNOWN" {
  if (value === null) return "UNKNOWN";
  const cents = BigInt(value);
  return cents < 0n ? "NEGATIVE" : cents > 0n ? "POSITIVE" : "ZERO";
}

/** Exact bounded provider-payload parser; document identity stays server-side. */
function parsePdfOcr(
  payload: unknown,
  context: PdfOcrParseContext,
  strictV3: boolean,
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
      if (strictV3) {
        if (!exact(raw, CANDIDATE_V3_KEYS))
          return failure(PdfOcrFailureCode.INVALID_PAYLOAD);
      } else if (!exact(raw, CANDIDATE_KEYS)) {
        return failure(PdfOcrFailureCode.PAGE_ACCOUNTING_MISMATCH);
      }
      const candidate = raw as Record<string, unknown>;
      if (
        candidate.pageNumber !== page.pageNumber ||
        candidate.pageOccurrenceIndex !== pageOccurrenceIndex
      )
        return failure(PdfOcrFailureCode.CANDIDATE_ACCOUNTING_MISMATCH);
      pageOccurrenceIndex++;
      candidateOffset++;
      if (
        !cleanText(candidate.evidenceText, PDF_OCR_LIMITS.evidenceLength) ||
        (candidate.description !== null &&
          !cleanText(candidate.description, PDF_OCR_LIMITS.descriptionLength))
      )
        return failure(PdfOcrFailureCode.INVALID_EVIDENCE);
      if (
        candidate.amountCents !== null &&
        (typeof candidate.amountCents !== "string" ||
          !CENTS.test(candidate.amountCents))
      )
        return failure(PdfOcrFailureCode.INVALID_AMOUNT_CENTS);
      const amount =
        candidate.amountCents === null ? null : Number(candidate.amountCents);
      if (
        amount !== null &&
        (!Number.isSafeInteger(amount) ||
          amount < IMPORT_SESSION_PRIMITIVES.minCents ||
          amount > IMPORT_SESSION_PRIMITIVES.maxCents)
      )
        return failure(PdfOcrFailureCode.INVALID_AMOUNT_CENTS);
      if (
        candidate.amountMeaning !== "LINE_AMOUNT" &&
        candidate.amountMeaning !== "UNKNOWN"
      )
        return failure(PdfOcrFailureCode.INVALID_AMOUNT_CENTS);
      if (
        strictV3 &&
        candidate.amountCents === null &&
        candidate.amountMeaning !== "UNKNOWN"
      )
        return failure(PdfOcrFailureCode.INVALID_AMOUNT_CENTS);
      let parsedDate: ParsedDate;
      let sign: "NEGATIVE" | "ZERO" | "POSITIVE" | "UNKNOWN";
      if (strictV3) {
        const strictDate = parseCandidateDate(candidate);
        if (!strictDate) return failure(PdfOcrFailureCode.INVALID_DATE);
        parsedDate = strictDate;
        const suppliedSign = candidate.sign;
        if (
          (suppliedSign !== "NEGATIVE" &&
            suppliedSign !== "ZERO" &&
            suppliedSign !== "POSITIVE" &&
            suppliedSign !== "UNKNOWN") ||
          suppliedSign !== signForCents(candidate.amountCents as string | null)
        )
          return failure(PdfOcrFailureCode.INVALID_AMOUNT_CENTS);
        sign = suppliedSign;
      } else {
        if (
          candidate.date !== null &&
          (typeof candidate.date !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(candidate.date) ||
            !parseInstallmentDateOnlyUtc(candidate.date))
        )
          return failure(PdfOcrFailureCode.INVALID_DATE);
        const legacyDate = candidate.date as string | null;
        parsedDate = {
          dateText: legacyDate,
          normalizedDate: legacyDate,
          dateExplicitness: legacyDate === null ? "MISSING" : "FULL",
          dateOnly: legacyDate,
        };
        sign = signForCents(candidate.amountCents as string | null);
      }
      if (candidate.installment !== null) {
        if (
          !exact(candidate.installment, INSTALLMENT_KEYS) ||
          !Number.isSafeInteger(candidate.installment.index) ||
          !Number.isSafeInteger(candidate.installment.total) ||
          (candidate.installment.index as number) < 1 ||
          (candidate.installment.total as number) < 1 ||
          (candidate.installment.index as number) >
            (candidate.installment.total as number) ||
          (candidate.installment.total as number) >
            PDF_OCR_LIMITS.installmentsPerPurchase
        )
          return failure(PdfOcrFailureCode.INVALID_INSTALLMENT);
      }
      const pageNumber = candidate.pageNumber as number;
      parsed.push({
        pageNumber,
        pageOccurrenceIndex: candidate.pageOccurrenceIndex as number,
        description: candidate.description as string | null,
        amountCents: candidate.amountCents as string | null,
        sign,
        amountMeaning: candidate.amountMeaning as "LINE_AMOUNT" | "UNKNOWN",
        dateText: parsedDate.dateText,
        normalizedDate: parsedDate.normalizedDate,
        dateExplicitness: parsedDate.dateExplicitness,
        date: parsedDate.dateOnly,
        dateOnly: parsedDate.dateOnly,
        installment: candidate.installment as {
          index: number;
          total: number;
        } | null,
        evidenceText: candidate.evidenceText as string,
        evidence: { pageNumber, text: candidate.evidenceText as string },
        selected: false,
        verificationStatus: "UNVERIFIED",
      });
    }
  }
  if (candidateOffset !== payload.candidates.length)
    return failure(PdfOcrFailureCode.CANDIDATE_ACCOUNTING_MISMATCH);
  return {
    ok: true,
    value: {
      version: strictV3 ? PDF_OCR_DOCUMENT_VERSION : PDF_OCR_VERSION,
      artifactSha256: context.artifactSha256,
      pageCount: context.pageCount,
      provenance: providerProvenance,
      candidates: parsed,
    },
  };
}

/** Compatibility parser for already-deployed V2 provider fixtures. */
export function parsePdfOcrV2(
  payload: unknown,
  context: PdfOcrParseContext,
): PdfOcrParseResultV2 {
  return parsePdfOcr(payload, context, false);
}

/** Strict provider-response parser. V2 request/consent naming remains separate. */
export function parsePdfOcrV3(
  payload: unknown,
  context: PdfOcrParseContext,
): PdfOcrParseResultV2 {
  return parsePdfOcr(payload, context, true);
}
