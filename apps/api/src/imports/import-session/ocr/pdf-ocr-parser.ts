import { createHash } from "node:crypto";
import {
  IMPORT_SESSION_PRIMITIVES,
  PDF_OCR_LIMITS,
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_VERSION,
  PdfOcrDiagnostic,
  PdfOcrRegionStatus,
  PdfOcrVerificationStatus,
  type PdfOcrBoundsV2,
  type PdfOcrCandidateV2,
  type PdfOcrDocumentV2,
  type PdfOcrInstallmentV2,
  type PdfOcrManifestPageV2,
  type PdfOcrManifestRegionV2,
  type PdfOcrManifestV2,
  type PdfOcrProviderProvenanceV2,
} from "@reformaflow/domain";

export const PdfOcrFailureCode = {
  INVALID_MANIFEST: "INVALID_MANIFEST",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  ARTIFACT_MISMATCH: "ARTIFACT_MISMATCH",
  PAGE_ACCOUNTING_MISMATCH: "PAGE_ACCOUNTING_MISMATCH",
  REGION_ACCOUNTING_MISMATCH: "REGION_ACCOUNTING_MISMATCH",
  REGION_FAILED: "REGION_FAILED",
  INVALID_PROVENANCE: "INVALID_PROVENANCE",
  INVALID_AMOUNT_CENTS: "INVALID_AMOUNT_CENTS",
  INVALID_DATE: "INVALID_DATE",
  INVALID_INSTALLMENT: "INVALID_INSTALLMENT",
  INVALID_EVIDENCE: "INVALID_EVIDENCE",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  NO_CANDIDATES: "NO_CANDIDATES",
} as const;

export type PdfOcrFailureCode =
  (typeof PdfOcrFailureCode)[keyof typeof PdfOcrFailureCode];

export type PdfOcrParseResultV2 =
  | { readonly ok: true; readonly value: PdfOcrDocumentV2 }
  | {
      readonly ok: false;
      readonly error: Readonly<{ code: PdfOcrFailureCode }>;
    };

type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: PdfOcrFailureCode };

type UnknownRecord = Record<string, unknown>;
type ManifestIndex = Readonly<{
  manifest: PdfOcrManifestV2;
  pages: ReadonlyMap<number, PdfOcrManifestPageV2>;
  regionCount: number;
}>;
type RawCandidate = Readonly<{
  description: unknown;
  amountCents: unknown;
  dateText: unknown;
  installment: unknown;
  evidence: unknown;
}>;
type RawRegion = Readonly<{
  regionIndex: number;
  regionSha256: string;
  status: string;
  candidates: readonly RawCandidate[];
}>;
type RawPage = Readonly<{
  pageNumber: number;
  pageSha256: string;
  regions: readonly RawRegion[];
}>;
type RawEnvelope = Readonly<{
  artifactSha256: string;
  provenance: UnknownRecord;
  pages: readonly RawPage[];
}>;

const ROOT_MANIFEST_KEYS = [
  "version",
  "artifactSha256",
  "pageCount",
  "request",
  "pages",
] as const;
const REQUEST_KEYS = ["provider", "model", "region", "requestId"] as const;
const MANIFEST_PAGE_KEYS = [
  "pageNumber",
  "pageSha256",
  "widthPx",
  "heightPx",
  "regions",
] as const;
const MANIFEST_REGION_KEYS = ["regionIndex", "regionSha256", "bounds"] as const;
const BOUNDS_KEYS = ["x", "y", "width", "height"] as const;
const ROOT_PAYLOAD_KEYS = [
  "version",
  "artifactSha256",
  "provenance",
  "pages",
] as const;
const PROVENANCE_KEYS = [
  "provider",
  "model",
  "region",
  "requestId",
  "usage",
  "latencyMs",
] as const;
const USAGE_KEYS = ["inputTokens", "outputTokens", "totalTokens"] as const;
const PAYLOAD_PAGE_KEYS = ["pageNumber", "pageSha256", "regions"] as const;
const PAYLOAD_REGION_KEYS = [
  "regionIndex",
  "regionSha256",
  "status",
  "candidates",
] as const;
const CANDIDATE_KEYS = [
  "description",
  "amountCents",
  "dateText",
  "installment",
  "evidence",
] as const;
const INSTALLMENT_KEYS = ["index", "total"] as const;
const EVIDENCE_KEYS = [
  "pageNumber",
  "regionIndex",
  "regionSha256",
  "text",
  "textSha256",
] as const;

const FIRST_INDEX = 1;
const MIN_PIXEL_SIZE = 1;
const MIN_DATE_MONTH = 1;
const MAX_DATE_MONTH = 12;
const MIN_DATE_DAY = 1;
const FEBRUARY = 2;
const COMMON_FEBRUARY_DAYS = 28;
const LEAP_FEBRUARY_DAYS = 29;
const DAYS_IN_30_DAY_MONTH = 30;
const DAYS_IN_31_DAY_MONTH = 31;
const LEAP_DIVISOR = 4;
const CENTURY_DIVISOR = 100;
const GREGORIAN_DIVISOR = 400;
const DATE_COMPONENT_WIDTH = 2;
const ZERO_CHARACTER = "0";
const MAX_COUNTER = IMPORT_SESSION_PRIMITIVES.maxRevision;
const MIN_CENTS_TEXT = String(IMPORT_SESSION_PRIMITIVES.minCents);
const MAX_CENTS_TEXT = String(IMPORT_SESSION_PRIMITIVES.maxCents);

const HASH_PATTERN = new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern);
const PROVIDER_REGION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const PROVIDER_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const CANONICAL_CENTS_PATTERN = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PT_BR_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const YEARLESS_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})$/;
const FORBIDDEN_TEXT_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DAYS_BY_MONTH = [
  DAYS_IN_31_DAY_MONTH,
  null,
  DAYS_IN_31_DAY_MONTH,
  DAYS_IN_30_DAY_MONTH,
  DAYS_IN_31_DAY_MONTH,
  DAYS_IN_30_DAY_MONTH,
  DAYS_IN_31_DAY_MONTH,
  DAYS_IN_31_DAY_MONTH,
  DAYS_IN_30_DAY_MONTH,
  DAYS_IN_31_DAY_MONTH,
  DAYS_IN_30_DAY_MONTH,
  DAYS_IN_31_DAY_MONTH,
] as const;

const failure = (code: PdfOcrFailureCode): PdfOcrParseResultV2 => ({
  ok: false,
  error: { code },
});

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

const isBoundedCounter = (value: unknown): value is number =>
  isInteger(value) && value >= 0 && value <= MAX_COUNTER;

const isHash = (value: unknown): value is string =>
  typeof value === "string" && HASH_PATTERN.test(value);

const isObjectRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isExactObject = (
  value: unknown,
  keys: readonly string[],
): value is UnknownRecord => {
  if (!isObjectRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === "string") &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
};

const versionFailure = (
  record: UnknownRecord,
  malformed: PdfOcrFailureCode,
): PdfOcrFailureCode | null => {
  const version = record.version;
  if (!isInteger(version)) return malformed;
  return version === PDF_OCR_VERSION
    ? null
    : PdfOcrFailureCode.UNSUPPORTED_VERSION;
};

const validateRequest = (
  value: unknown,
): value is PdfOcrManifestV2["request"] =>
  isExactObject(value, REQUEST_KEYS) &&
  value.provider === PDF_OCR_PROVIDER_ID &&
  value.model === PDF_OCR_MODEL_ID &&
  typeof value.region === "string" &&
  PROVIDER_REGION_PATTERN.test(value.region) &&
  typeof value.requestId === "string" &&
  value.requestId.length >= FIRST_INDEX &&
  value.requestId.length <= PDF_OCR_LIMITS.providerRequestIdLength &&
  PROVIDER_REQUEST_ID_PATTERN.test(value.requestId);

const validateBounds = (
  value: unknown,
  widthPx: number,
  heightPx: number,
): value is PdfOcrBoundsV2 => {
  if (!isExactObject(value, BOUNDS_KEYS)) return false;
  const { x, y, width, height } = value;
  return (
    isInteger(x) &&
    isInteger(y) &&
    isInteger(width) &&
    isInteger(height) &&
    x >= 0 &&
    y >= 0 &&
    width >= MIN_PIXEL_SIZE &&
    height >= MIN_PIXEL_SIZE &&
    x + width <= widthPx &&
    y + height <= heightPx
  );
};

const validateManifest = (value: unknown): Validation<ManifestIndex> => {
  if (!isExactObject(value, ROOT_MANIFEST_KEYS))
    return { ok: false, code: PdfOcrFailureCode.INVALID_MANIFEST };
  const invalidVersion = versionFailure(
    value,
    PdfOcrFailureCode.INVALID_MANIFEST,
  );
  if (invalidVersion !== null) return { ok: false, code: invalidVersion };
  if (
    !isHash(value.artifactSha256) ||
    !isInteger(value.pageCount) ||
    value.pageCount < FIRST_INDEX ||
    value.pageCount > PDF_OCR_LIMITS.pagesPerFile ||
    !validateRequest(value.request) ||
    !Array.isArray(value.pages) ||
    value.pages.length !== value.pageCount
  )
    return { ok: false, code: PdfOcrFailureCode.INVALID_MANIFEST };

  const pages = new Map<number, PdfOcrManifestPageV2>();
  let regionCount = 0;
  for (let pageOffset = 0; pageOffset < value.pages.length; pageOffset += 1) {
    const rawPage = value.pages[pageOffset];
    if (!isExactObject(rawPage, MANIFEST_PAGE_KEYS))
      return { ok: false, code: PdfOcrFailureCode.INVALID_MANIFEST };
    const { pageNumber, widthPx, heightPx } = rawPage;
    if (
      !isInteger(pageNumber) ||
      pageNumber !== pageOffset + FIRST_INDEX ||
      !isHash(rawPage.pageSha256) ||
      !isInteger(widthPx) ||
      !isInteger(heightPx) ||
      widthPx < MIN_PIXEL_SIZE ||
      heightPx < MIN_PIXEL_SIZE ||
      widthPx * heightPx > PDF_OCR_LIMITS.pixelsPerPage ||
      !Array.isArray(rawPage.regions)
    )
      return { ok: false, code: PdfOcrFailureCode.INVALID_MANIFEST };

    const regions: PdfOcrManifestRegionV2[] = [];
    for (
      let regionOffset = 0;
      regionOffset < rawPage.regions.length;
      regionOffset += 1
    ) {
      const rawRegion = rawPage.regions[regionOffset];
      if (
        !isExactObject(rawRegion, MANIFEST_REGION_KEYS) ||
        rawRegion.regionIndex !== regionOffset + FIRST_INDEX ||
        !isHash(rawRegion.regionSha256) ||
        !validateBounds(rawRegion.bounds, widthPx, heightPx)
      )
        return { ok: false, code: PdfOcrFailureCode.INVALID_MANIFEST };
      regions.push({
        regionIndex: rawRegion.regionIndex,
        regionSha256: rawRegion.regionSha256,
        bounds: rawRegion.bounds,
      });
      regionCount += 1;
      if (regionCount > PDF_OCR_LIMITS.candidatesPerFile)
        return { ok: false, code: PdfOcrFailureCode.LIMIT_EXCEEDED };
    }
    pages.set(pageNumber, {
      pageNumber,
      pageSha256: rawPage.pageSha256,
      widthPx,
      heightPx,
      regions,
    });
  }
  if (regionCount === 0)
    return { ok: false, code: PdfOcrFailureCode.INVALID_MANIFEST };

  return {
    ok: true,
    value: {
      manifest: {
        version: PDF_OCR_VERSION,
        artifactSha256: value.artifactSha256,
        pageCount: value.pageCount,
        request: value.request,
        pages: [...pages.values()],
      },
      pages,
      regionCount,
    },
  };
};

const validateRawCandidate = (value: unknown): Validation<RawCandidate> => {
  if (!isExactObject(value, CANDIDATE_KEYS))
    return { ok: false, code: PdfOcrFailureCode.INVALID_PAYLOAD };
  return {
    ok: true,
    value: {
      description: value.description,
      amountCents: value.amountCents,
      dateText: value.dateText,
      installment: value.installment,
      evidence: value.evidence,
    },
  };
};

const validateRawEnvelope = (value: unknown): Validation<RawEnvelope> => {
  if (!isExactObject(value, ROOT_PAYLOAD_KEYS))
    return { ok: false, code: PdfOcrFailureCode.INVALID_PAYLOAD };
  const invalidVersion = versionFailure(
    value,
    PdfOcrFailureCode.INVALID_PAYLOAD,
  );
  if (invalidVersion !== null) return { ok: false, code: invalidVersion };
  if (
    !isHash(value.artifactSha256) ||
    !isObjectRecord(value.provenance) ||
    !Array.isArray(value.pages)
  )
    return { ok: false, code: PdfOcrFailureCode.INVALID_PAYLOAD };
  if (value.pages.length > PDF_OCR_LIMITS.pagesPerFile)
    return { ok: false, code: PdfOcrFailureCode.LIMIT_EXCEEDED };

  const pages: RawPage[] = [];
  let regionCount = 0;
  let candidateCount = 0;
  for (const rawPage of value.pages) {
    if (
      !isExactObject(rawPage, PAYLOAD_PAGE_KEYS) ||
      !isInteger(rawPage.pageNumber) ||
      !isHash(rawPage.pageSha256) ||
      !Array.isArray(rawPage.regions)
    )
      return { ok: false, code: PdfOcrFailureCode.INVALID_PAYLOAD };
    const regions: RawRegion[] = [];
    for (const rawRegion of rawPage.regions) {
      if (
        !isExactObject(rawRegion, PAYLOAD_REGION_KEYS) ||
        !isInteger(rawRegion.regionIndex) ||
        !isHash(rawRegion.regionSha256) ||
        (rawRegion.status !== PdfOcrRegionStatus.COMPLETE &&
          rawRegion.status !== PdfOcrRegionStatus.FAILED) ||
        !Array.isArray(rawRegion.candidates)
      )
        return { ok: false, code: PdfOcrFailureCode.INVALID_PAYLOAD };
      regionCount += 1;
      if (regionCount > PDF_OCR_LIMITS.candidatesPerFile)
        return { ok: false, code: PdfOcrFailureCode.LIMIT_EXCEEDED };
      const candidates: RawCandidate[] = [];
      for (const rawCandidate of rawRegion.candidates) {
        candidateCount += 1;
        if (candidateCount > PDF_OCR_LIMITS.candidatesPerFile)
          return { ok: false, code: PdfOcrFailureCode.LIMIT_EXCEEDED };
        const candidate = validateRawCandidate(rawCandidate);
        if (!candidate.ok) return candidate;
        candidates.push(candidate.value);
      }
      if (
        rawRegion.status === PdfOcrRegionStatus.FAILED &&
        candidates.length !== 0
      )
        return { ok: false, code: PdfOcrFailureCode.INVALID_PAYLOAD };
      regions.push({
        regionIndex: rawRegion.regionIndex,
        regionSha256: rawRegion.regionSha256,
        status: rawRegion.status,
        candidates,
      });
    }
    pages.push({
      pageNumber: rawPage.pageNumber,
      pageSha256: rawPage.pageSha256,
      regions,
    });
  }
  return {
    ok: true,
    value: {
      artifactSha256: value.artifactSha256,
      provenance: value.provenance,
      pages,
    },
  };
};

const validateProvenance = (
  value: UnknownRecord,
  expected: PdfOcrManifestV2["request"],
): Validation<PdfOcrProviderProvenanceV2> => {
  if (
    !isExactObject(value, PROVENANCE_KEYS) ||
    value.provider !== expected.provider ||
    value.model !== expected.model ||
    value.region !== expected.region ||
    value.requestId !== expected.requestId ||
    !isExactObject(value.usage, USAGE_KEYS) ||
    !isBoundedCounter(value.usage.inputTokens) ||
    !isBoundedCounter(value.usage.outputTokens) ||
    !isBoundedCounter(value.usage.totalTokens) ||
    value.usage.inputTokens + value.usage.outputTokens !==
      value.usage.totalTokens ||
    !isInteger(value.latencyMs) ||
    value.latencyMs < 0 ||
    value.latencyMs > PDF_OCR_LIMITS.providerLatencyMs
  )
    return { ok: false, code: PdfOcrFailureCode.INVALID_PROVENANCE };
  return {
    ok: true,
    value: {
      provider: expected.provider,
      model: expected.model,
      region: expected.region,
      requestId: expected.requestId,
      usage: {
        inputTokens: value.usage.inputTokens,
        outputTokens: value.usage.outputTokens,
        totalTokens: value.usage.totalTokens,
      },
      latencyMs: value.latencyMs,
    },
  };
};

const absoluteWithinBound = (digits: string, bound: string): boolean =>
  digits.length < bound.length ||
  (digits.length === bound.length && digits <= bound);

const isCanonicalCents = (value: unknown): value is string => {
  if (typeof value !== "string" || !CANONICAL_CENTS_PATTERN.test(value))
    return false;
  if (value.startsWith("-"))
    return absoluteWithinBound(value.slice(1), MIN_CENTS_TEXT.slice(1));
  return absoluteWithinBound(value, MAX_CENTS_TEXT);
};

const isLeapYear = (year: number): boolean =>
  year % GREGORIAN_DIVISOR === 0 ||
  (year % LEAP_DIVISOR === 0 && year % CENTURY_DIVISOR !== 0);

const validMonthDay = (month: number, day: number, year?: number): boolean => {
  if (month < MIN_DATE_MONTH || month > MAX_DATE_MONTH || day < MIN_DATE_DAY)
    return false;
  if (month === FEBRUARY)
    return (
      day <=
      (year === undefined || isLeapYear(year)
        ? LEAP_FEBRUARY_DAYS
        : COMMON_FEBRUARY_DAYS)
    );
  const maximum = DAYS_BY_MONTH[month - MIN_DATE_MONTH];
  return maximum !== null && day <= maximum;
};

const isoDate = (year: number, month: number, day: number): string =>
  `${year}-${String(month).padStart(
    DATE_COMPONENT_WIDTH,
    ZERO_CHARACTER,
  )}-${String(day).padStart(DATE_COMPONENT_WIDTH, ZERO_CHARACTER)}`;

type ParsedDate = Readonly<{
  date: string | null;
  diagnostics: readonly (typeof PdfOcrDiagnostic.MISSING_YEAR)[];
}>;

const parseDate = (value: unknown): Validation<ParsedDate> => {
  if (value === null)
    return { ok: true, value: { date: null, diagnostics: [] } };
  if (typeof value !== "string")
    return { ok: false, code: PdfOcrFailureCode.INVALID_DATE };

  const iso = ISO_DATE_PATTERN.exec(value);
  const br = PT_BR_DATE_PATTERN.exec(value);
  const explicit = iso
    ? { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }
    : br
      ? { year: Number(br[3]), month: Number(br[2]), day: Number(br[1]) }
      : null;
  if (explicit !== null) {
    if (
      explicit.year < IMPORT_SESSION_PRIMITIVES.minYear ||
      explicit.year > IMPORT_SESSION_PRIMITIVES.maxYear ||
      !validMonthDay(explicit.month, explicit.day, explicit.year)
    )
      return { ok: false, code: PdfOcrFailureCode.INVALID_DATE };
    return {
      ok: true,
      value: {
        date: isoDate(explicit.year, explicit.month, explicit.day),
        diagnostics: [],
      },
    };
  }

  const yearless = YEARLESS_DATE_PATTERN.exec(value);
  if (yearless && validMonthDay(Number(yearless[2]), Number(yearless[1])))
    return {
      ok: true,
      value: {
        date: null,
        diagnostics: [PdfOcrDiagnostic.MISSING_YEAR],
      },
    };
  return { ok: false, code: PdfOcrFailureCode.INVALID_DATE };
};

const parseInstallment = (
  value: unknown,
): Validation<PdfOcrInstallmentV2 | null> => {
  if (value === null) return { ok: true, value: null };
  if (!isExactObject(value, INSTALLMENT_KEYS))
    return { ok: false, code: PdfOcrFailureCode.INVALID_INSTALLMENT };
  const { index, total } = value;
  if (
    !isInteger(index) ||
    !isInteger(total) ||
    index < FIRST_INDEX ||
    total < FIRST_INDEX ||
    index > total ||
    total > PDF_OCR_LIMITS.installmentsPerPurchase
  )
    return { ok: false, code: PdfOcrFailureCode.INVALID_INSTALLMENT };
  return { ok: true, value: { index, total } };
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const validDescription = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= FIRST_INDEX &&
  value.length <= PDF_OCR_LIMITS.descriptionLength &&
  value.trim() === value &&
  !FORBIDDEN_TEXT_PATTERN.test(value);

const parseCandidate = (
  candidate: RawCandidate,
  artifactSha256: string,
  page: PdfOcrManifestPageV2,
  region: PdfOcrManifestRegionV2,
): Validation<PdfOcrCandidateV2> => {
  if (!isCanonicalCents(candidate.amountCents))
    return { ok: false, code: PdfOcrFailureCode.INVALID_AMOUNT_CENTS };
  const date = parseDate(candidate.dateText);
  if (!date.ok) return date;
  const installment = parseInstallment(candidate.installment);
  if (!installment.ok) return installment;
  if (
    !validDescription(candidate.description) ||
    !isExactObject(candidate.evidence, EVIDENCE_KEYS) ||
    candidate.evidence.pageNumber !== page.pageNumber ||
    candidate.evidence.regionIndex !== region.regionIndex ||
    candidate.evidence.regionSha256 !== region.regionSha256 ||
    candidate.evidence.text !== candidate.description ||
    !isHash(candidate.evidence.textSha256) ||
    candidate.evidence.textSha256 !== sha256(candidate.evidence.text)
  )
    return { ok: false, code: PdfOcrFailureCode.INVALID_EVIDENCE };

  return {
    ok: true,
    value: {
      description: candidate.description,
      amountCents: candidate.amountCents,
      dateText: candidate.dateText as string | null,
      date: date.value.date,
      diagnostics: date.value.diagnostics,
      installment: installment.value,
      verificationStatus: PdfOcrVerificationStatus.UNVERIFIED,
      selected: false,
      evidence: {
        artifactSha256,
        pageNumber: page.pageNumber,
        pageSha256: page.pageSha256,
        regionIndex: region.regionIndex,
        regionSha256: region.regionSha256,
        bounds: region.bounds,
        text: candidate.evidence.text,
        textSha256: candidate.evidence.textSha256,
      },
    },
  };
};

export function parsePdfOcrV2(
  payload: unknown,
  manifest: unknown,
): PdfOcrParseResultV2 {
  const checkedManifest = validateManifest(manifest);
  if (!checkedManifest.ok) return failure(checkedManifest.code);
  const envelope = validateRawEnvelope(payload);
  if (!envelope.ok) return failure(envelope.code);
  if (
    envelope.value.artifactSha256 !==
    checkedManifest.value.manifest.artifactSha256
  )
    return failure(PdfOcrFailureCode.ARTIFACT_MISMATCH);
  const provenance = validateProvenance(
    envelope.value.provenance,
    checkedManifest.value.manifest.request,
  );
  if (!provenance.ok) return failure(provenance.code);

  if (envelope.value.pages.length !== checkedManifest.value.manifest.pageCount)
    return failure(PdfOcrFailureCode.PAGE_ACCOUNTING_MISMATCH);
  const payloadPages = new Map<number, RawPage>();
  for (const page of envelope.value.pages) {
    if (payloadPages.has(page.pageNumber))
      return failure(PdfOcrFailureCode.PAGE_ACCOUNTING_MISMATCH);
    payloadPages.set(page.pageNumber, page);
  }

  let candidateCount = 0;
  const parsedPages: PdfOcrDocumentV2["pages"][number][] = [];
  for (const manifestPage of checkedManifest.value.manifest.pages) {
    const payloadPage = payloadPages.get(manifestPage.pageNumber);
    if (
      payloadPage === undefined ||
      payloadPage.pageSha256 !== manifestPage.pageSha256
    )
      return failure(PdfOcrFailureCode.PAGE_ACCOUNTING_MISMATCH);
    if (payloadPage.regions.length !== manifestPage.regions.length)
      return failure(PdfOcrFailureCode.REGION_ACCOUNTING_MISMATCH);
    const payloadRegions = new Map<number, RawRegion>();
    for (const region of payloadPage.regions) {
      if (payloadRegions.has(region.regionIndex))
        return failure(PdfOcrFailureCode.REGION_ACCOUNTING_MISMATCH);
      payloadRegions.set(region.regionIndex, region);
    }

    const parsedRegions: PdfOcrDocumentV2["pages"][number]["regions"][number][] =
      [];
    for (const manifestRegion of manifestPage.regions) {
      const payloadRegion = payloadRegions.get(manifestRegion.regionIndex);
      if (
        payloadRegion === undefined ||
        payloadRegion.regionSha256 !== manifestRegion.regionSha256
      )
        return failure(PdfOcrFailureCode.REGION_ACCOUNTING_MISMATCH);
      if (payloadRegion.status === PdfOcrRegionStatus.FAILED)
        return failure(PdfOcrFailureCode.REGION_FAILED);
      candidateCount += payloadRegion.candidates.length;
      if (candidateCount > PDF_OCR_LIMITS.candidatesPerFile)
        return failure(PdfOcrFailureCode.LIMIT_EXCEEDED);
      const candidates: PdfOcrCandidateV2[] = [];
      for (const candidate of payloadRegion.candidates) {
        const parsed = parseCandidate(
          candidate,
          checkedManifest.value.manifest.artifactSha256,
          manifestPage,
          manifestRegion,
        );
        if (!parsed.ok) return failure(parsed.code);
        candidates.push(parsed.value);
      }
      parsedRegions.push({
        regionIndex: manifestRegion.regionIndex,
        regionSha256: manifestRegion.regionSha256,
        bounds: manifestRegion.bounds,
        candidates,
      });
    }
    parsedPages.push({
      pageNumber: manifestPage.pageNumber,
      pageSha256: manifestPage.pageSha256,
      regions: parsedRegions,
    });
  }
  if (candidateCount === 0) return failure(PdfOcrFailureCode.NO_CANDIDATES);

  return {
    ok: true,
    value: {
      version: PDF_OCR_VERSION,
      artifactSha256: checkedManifest.value.manifest.artifactSha256,
      provenance: provenance.value,
      accounting: {
        pageCount: checkedManifest.value.manifest.pageCount,
        regionCount: checkedManifest.value.regionCount,
        candidateCount,
      },
      pages: parsedPages,
    },
  };
}
