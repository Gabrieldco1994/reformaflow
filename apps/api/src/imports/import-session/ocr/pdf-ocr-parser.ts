import {
  IMPORT_SESSION_PRIMITIVES,
  PDF_OCR_LIMITS,
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
  PDF_OCR_VERSION,
  parseInstallmentDateOnlyUtc,
  type PdfOcrDocumentV2,
  type PdfOcrProviderProvenanceV2,
} from "@reformaflow/domain";

export const PdfOcrFailureCode = {
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  PAGE_ACCOUNTING_MISMATCH: "PAGE_ACCOUNTING_MISMATCH",
  INVALID_AMOUNT_CENTS: "INVALID_AMOUNT_CENTS",
  INVALID_DATE: "INVALID_DATE",
  INVALID_INSTALLMENT: "INVALID_INSTALLMENT",
  INVALID_EVIDENCE: "INVALID_EVIDENCE",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
} as const;
export type PdfOcrFailureCode =
  (typeof PdfOcrFailureCode)[keyof typeof PdfOcrFailureCode];

export type PdfOcrParseResultV2 =
  | { readonly ok: true; readonly value: PdfOcrDocumentV2 }
  | {
      readonly ok: false;
      readonly error: Readonly<{ code: PdfOcrFailureCode }>;
    };

export interface PdfOcrParseContext {
  readonly artifactSha256: string;
  readonly pageCount: number;
  readonly requestId: string;
  readonly responseId: string;
  readonly usage: Readonly<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
  readonly latencyMs: number;
}

const ROOT_KEYS = ["candidates"] as const;
const CANDIDATE_KEYS = [
  "pageNumber",
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
const CENTS = /^(?:0|-?[1-9][0-9]*)$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const failure = (code: PdfOcrFailureCode): PdfOcrParseResultV2 => ({
  ok: false,
  error: { code },
});
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
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
    boundedCounter(value.usage.inputTokens) &&
    boundedCounter(value.usage.outputTokens) &&
    boundedCounter(value.usage.totalTokens) &&
    value.usage.inputTokens + value.usage.outputTokens ===
      value.usage.totalTokens &&
    boundedCounter(value.latencyMs)
  );
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
  if (!exact(payload, ROOT_KEYS) || !Array.isArray(payload.candidates))
    return failure(PdfOcrFailureCode.INVALID_PAYLOAD);
  if (payload.candidates.length > PDF_OCR_LIMITS.candidatesPerFile)
    return failure(PdfOcrFailureCode.LIMIT_EXCEEDED);

  const parsed: PdfOcrDocumentV2["candidates"][number][] = [];
  for (const raw of payload.candidates) {
    if (
      !exact(raw, CANDIDATE_KEYS) ||
      !Number.isSafeInteger(raw.pageNumber) ||
      (raw.pageNumber as number) < 1 ||
      (raw.pageNumber as number) > context.pageCount
    )
      return failure(PdfOcrFailureCode.PAGE_ACCOUNTING_MISMATCH);
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
    if (raw.amountMeaning !== "LINE_AMOUNT" && raw.amountMeaning !== "UNKNOWN")
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
        (raw.installment.index as number) > (raw.installment.total as number) ||
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
      installment: raw.installment as { index: number; total: number } | null,
      evidence: { pageNumber, text: raw.evidenceText as string },
    });
  }
  const provenance: PdfOcrProviderProvenanceV2 = {
    provider: PDF_OCR_PROVIDER_ID,
    model: PDF_OCR_MODEL_ID,
    region: PDF_OCR_REGION,
    requestId: context.requestId,
    responseId: context.responseId,
    usage: { ...context.usage },
    latencyMs: context.latencyMs,
  };
  return {
    ok: true,
    value: {
      version: PDF_OCR_VERSION,
      artifactSha256: context.artifactSha256,
      pageCount: context.pageCount,
      provenance,
      candidates: parsed,
    },
  };
}
