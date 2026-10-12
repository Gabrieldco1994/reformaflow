const FAILURE_CODE = {
  INVALID_MANIFEST: "INVALID_MANIFEST",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  PAGE_ACCOUNTING_MISMATCH: "PAGE_ACCOUNTING_MISMATCH",
  REGION_ACCOUNTING_MISMATCH: "REGION_ACCOUNTING_MISMATCH",
  REGION_FAILED: "REGION_FAILED",
  INVALID_AMOUNT_CENTS: "INVALID_AMOUNT_CENTS",
  INVALID_DATE: "INVALID_DATE",
  TOO_MANY_CANDIDATES: "TOO_MANY_CANDIDATES",
  NO_CANDIDATES: "NO_CANDIDATES",
} as const;

export type OcrFailureCodeV1 = (typeof FAILURE_CODE)[keyof typeof FAILURE_CODE];

const REGION_STATUS = {
  COMPLETE: "COMPLETE",
  FAILED: "FAILED",
} as const;

const VERIFICATION_STATUS_UNVERIFIED = "UNVERIFIED" as const;
const SELECTED_BY_DEFAULT = false as const;
const VERSION_V1 = 1 as const;
const MIN_PAGE_COUNT = 1;
const MAX_PAGE_COUNT = 30;
const FIRST_REGION_INDEX = 1;
const MAX_CANDIDATE_COUNT = 1000;
const MAX_AMOUNT_CENTS = "2147483647";
const MIN_DATE_YEAR = 1900;
const MAX_DATE_YEAR = 2199;
const MIN_DATE_MONTH = 1;
const MAX_DATE_MONTH = 12;
const MIN_DATE_DAY = 1;
const FEBRUARY_MONTH = 2;
const COMMON_FEBRUARY_DAYS = 28;
const LEAP_FEBRUARY_DAYS = 29;
const DAYS_IN_30_DAY_MONTH = 30;
const DAYS_IN_31_DAY_MONTH = 31;
const LEAP_YEAR_DIVISOR = 4;
const CENTURY_YEAR_DIVISOR = 100;
const GREGORIAN_CYCLE_YEARS = 400;
const ISO_YEAR_DIGITS = 4;
const DATE_COMPONENT_DIGITS = 2;
const ZERO_DIGIT = "0";

const KEY_VERSION = "version";
const KEY_PAGE_COUNT = "pageCount";
const KEY_REGIONS = "regions";
const KEY_PAGE_NUMBER = "pageNumber";
const KEY_REGION_INDEX = "regionIndex";
const KEY_STATUS = "status";
const KEY_CANDIDATES = "candidates";
const KEY_AMOUNT_CENTS = "amountCents";
const KEY_DATE_TEXT = "dateText";

const MANIFEST_KEYS = [KEY_VERSION, KEY_PAGE_COUNT, KEY_REGIONS] as const;
const REGION_REF_KEYS = [KEY_PAGE_NUMBER, KEY_REGION_INDEX] as const;
const PAYLOAD_KEYS = [KEY_VERSION, KEY_REGIONS] as const;
const REGION_RESULT_KEYS = [
  KEY_PAGE_NUMBER,
  KEY_REGION_INDEX,
  KEY_STATUS,
  KEY_CANDIDATES,
] as const;
const RAW_CANDIDATE_KEYS = [KEY_AMOUNT_CENTS, KEY_DATE_TEXT] as const;
const AMOUNT_CENTS_PATTERN = /^[1-9][0-9]*$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PT_BR_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const YEARLESS_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})$/;
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

export interface OcrRegionRefV1 {
  readonly pageNumber: number;
  readonly regionIndex: number;
}

export interface OcrManifestV1 {
  readonly version: 1;
  readonly pageCount: number;
  readonly regions: readonly OcrRegionRefV1[];
}

export interface OcrRawCandidateV1 {
  readonly amountCents: string;
  readonly dateText: string | null;
}

export interface OcrRegionResultV1 extends OcrRegionRefV1 {
  readonly status: "COMPLETE" | "FAILED";
  readonly candidates: readonly OcrRawCandidateV1[];
}

export interface OcrPayloadV1 {
  readonly version: 1;
  readonly regions: readonly OcrRegionResultV1[];
}

export interface OcrCandidateV1 {
  readonly amountCents: string;
  readonly date: string | null;
  readonly verificationStatus: "UNVERIFIED";
  readonly selected: false;
}

export interface OcrParsedRegionV1 extends OcrRegionRefV1 {
  readonly candidates: readonly OcrCandidateV1[];
}

export interface OcrDocumentV1 {
  readonly version: 1;
  readonly accounting: {
    pageCount: number;
    regionCount: number;
    candidateCount: number;
  };
  readonly regions: readonly OcrParsedRegionV1[];
}

export type OcrParseResultV1 =
  | { ok: true; value: OcrDocumentV1 }
  | { ok: false; error: { code: OcrFailureCodeV1 } };

type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: OcrFailureCodeV1 };

type CandidateInput = {
  readonly amountCents: unknown;
  readonly dateText: unknown;
};

type RegionInput = OcrRegionRefV1 & {
  readonly status: OcrRegionResultV1["status"];
  readonly candidates: readonly CandidateInput[];
};

type ParsedPayloadInput = {
  readonly regions: readonly RegionInput[];
};

type DateValidation =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly code: typeof FAILURE_CODE.INVALID_DATE };

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

const isExactObject = (
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === expectedKeys.length &&
    expectedKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) &&
    ownKeys.every((key) => typeof key === "string")
  );
};

const validateVersion = (
  value: Record<string, unknown>,
  invalidCode: OcrFailureCodeV1,
): OcrFailureCodeV1 | null => {
  const version = value[KEY_VERSION];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return invalidCode;
  }
  return version === VERSION_V1 ? null : FAILURE_CODE.UNSUPPORTED_VERSION;
};

const validateManifest = (value: unknown): Validation<OcrManifestV1> => {
  if (!isExactObject(value, MANIFEST_KEYS)) {
    return { ok: false, code: FAILURE_CODE.INVALID_MANIFEST };
  }

  const versionError = validateVersion(value, FAILURE_CODE.INVALID_MANIFEST);
  if (versionError !== null) {
    return { ok: false, code: versionError };
  }

  const pageCount = value[KEY_PAGE_COUNT];
  if (!isInteger(pageCount)) {
    return { ok: false, code: FAILURE_CODE.INVALID_MANIFEST };
  }
  if (pageCount < MIN_PAGE_COUNT || pageCount > MAX_PAGE_COUNT) {
    return { ok: false, code: FAILURE_CODE.PAGE_ACCOUNTING_MISMATCH };
  }

  const rawRegions = value[KEY_REGIONS];
  if (!Array.isArray(rawRegions)) {
    return { ok: false, code: FAILURE_CODE.INVALID_MANIFEST };
  }

  const regions: OcrRegionRefV1[] = [];
  const representedPages = new Set<number>();
  const nextRegionIndexByPage = new Map<number, number>();
  let previousPageNumber = MIN_PAGE_COUNT;
  let previousRegionIndex = 0;

  for (const rawRegion of rawRegions) {
    if (!isExactObject(rawRegion, REGION_REF_KEYS)) {
      return { ok: false, code: FAILURE_CODE.INVALID_MANIFEST };
    }

    const pageNumber = rawRegion[KEY_PAGE_NUMBER];
    const regionIndex = rawRegion[KEY_REGION_INDEX];
    if (!isInteger(pageNumber) || !isInteger(regionIndex)) {
      return { ok: false, code: FAILURE_CODE.INVALID_MANIFEST };
    }
    if (pageNumber < MIN_PAGE_COUNT || pageNumber > pageCount) {
      return { ok: false, code: FAILURE_CODE.PAGE_ACCOUNTING_MISMATCH };
    }
    if (regionIndex < FIRST_REGION_INDEX) {
      return { ok: false, code: FAILURE_CODE.REGION_ACCOUNTING_MISMATCH };
    }

    const expectedRegionIndex =
      nextRegionIndexByPage.get(pageNumber) ?? FIRST_REGION_INDEX;
    if (
      regionIndex !== expectedRegionIndex ||
      pageNumber < previousPageNumber ||
      (pageNumber === previousPageNumber && regionIndex <= previousRegionIndex)
    ) {
      return { ok: false, code: FAILURE_CODE.REGION_ACCOUNTING_MISMATCH };
    }

    regions.push({ pageNumber, regionIndex });
    representedPages.add(pageNumber);
    nextRegionIndexByPage.set(pageNumber, expectedRegionIndex + 1);
    previousPageNumber = pageNumber;
    previousRegionIndex = regionIndex;
  }

  for (
    let pageNumber = MIN_PAGE_COUNT;
    pageNumber <= pageCount;
    pageNumber += 1
  ) {
    if (!representedPages.has(pageNumber)) {
      return { ok: false, code: FAILURE_CODE.PAGE_ACCOUNTING_MISMATCH };
    }
  }

  return {
    ok: true,
    value: { version: VERSION_V1, pageCount, regions },
  };
};

const validatePayload = (value: unknown): Validation<ParsedPayloadInput> => {
  if (!isExactObject(value, PAYLOAD_KEYS)) {
    return { ok: false, code: FAILURE_CODE.INVALID_PAYLOAD };
  }

  const versionError = validateVersion(value, FAILURE_CODE.INVALID_PAYLOAD);
  if (versionError !== null) {
    return { ok: false, code: versionError };
  }

  const rawRegions = value[KEY_REGIONS];
  if (!Array.isArray(rawRegions)) {
    return { ok: false, code: FAILURE_CODE.INVALID_PAYLOAD };
  }

  const regions: RegionInput[] = [];
  for (const rawRegion of rawRegions) {
    if (!isExactObject(rawRegion, REGION_RESULT_KEYS)) {
      return { ok: false, code: FAILURE_CODE.INVALID_PAYLOAD };
    }

    const pageNumber = rawRegion[KEY_PAGE_NUMBER];
    const regionIndex = rawRegion[KEY_REGION_INDEX];
    const status = rawRegion[KEY_STATUS];
    const rawCandidates = rawRegion[KEY_CANDIDATES];
    if (
      !isInteger(pageNumber) ||
      !isInteger(regionIndex) ||
      (status !== REGION_STATUS.COMPLETE && status !== REGION_STATUS.FAILED) ||
      !Array.isArray(rawCandidates)
    ) {
      return { ok: false, code: FAILURE_CODE.INVALID_PAYLOAD };
    }

    const candidates: CandidateInput[] = [];
    for (const rawCandidate of rawCandidates) {
      if (!isExactObject(rawCandidate, RAW_CANDIDATE_KEYS)) {
        return { ok: false, code: FAILURE_CODE.INVALID_PAYLOAD };
      }
      candidates.push({
        amountCents: rawCandidate[KEY_AMOUNT_CENTS],
        dateText: rawCandidate[KEY_DATE_TEXT],
      });
    }

    regions.push({ pageNumber, regionIndex, status, candidates });
  }

  return { ok: true, value: { regions } };
};

const hasValidAmountCents = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }

  const match = AMOUNT_CENTS_PATTERN.exec(value);
  if (match === null || match[0] !== value) {
    return false;
  }

  return (
    value.length < MAX_AMOUNT_CENTS.length ||
    (value.length === MAX_AMOUNT_CENTS.length && value <= MAX_AMOUNT_CENTS)
  );
};

const isLeapYear = (year: number): boolean =>
  year % GREGORIAN_CYCLE_YEARS === 0 ||
  (year % LEAP_YEAR_DIVISOR === 0 && year % CENTURY_YEAR_DIVISOR !== 0);

const isValidMonthDay = (
  month: number,
  day: number,
  year?: number,
): boolean => {
  if (month < MIN_DATE_MONTH || month > MAX_DATE_MONTH || day < MIN_DATE_DAY) {
    return false;
  }

  if (month === FEBRUARY_MONTH) {
    const maximumDay =
      year === undefined || isLeapYear(year)
        ? LEAP_FEBRUARY_DAYS
        : COMMON_FEBRUARY_DAYS;
    return day <= maximumDay;
  }

  const maximumDay = DAYS_BY_MONTH[month - MIN_DATE_MONTH];
  return maximumDay !== null && day <= maximumDay;
};

const matchEntire = (
  pattern: RegExp,
  value: string,
): RegExpExecArray | null => {
  const match = pattern.exec(value);
  return match !== null && match[0] === value ? match : null;
};

const formatIsoDate = (year: number, month: number, day: number): string =>
  `${String(year).padStart(ISO_YEAR_DIGITS, ZERO_DIGIT)}-${String(
    month,
  ).padStart(
    DATE_COMPONENT_DIGITS,
    ZERO_DIGIT,
  )}-${String(day).padStart(DATE_COMPONENT_DIGITS, ZERO_DIGIT)}`;

const validateExplicitDate = (
  yearText: string | undefined,
  monthText: string | undefined,
  dayText: string | undefined,
): DateValidation => {
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined
  ) {
    return { ok: false, code: FAILURE_CODE.INVALID_DATE };
  }

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (
    year < MIN_DATE_YEAR ||
    year > MAX_DATE_YEAR ||
    !isValidMonthDay(month, day, year)
  ) {
    return { ok: false, code: FAILURE_CODE.INVALID_DATE };
  }

  return { ok: true, value: formatIsoDate(year, month, day) };
};

const validateDate = (value: unknown): DateValidation => {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return { ok: false, code: FAILURE_CODE.INVALID_DATE };
  }

  const isoDate = matchEntire(ISO_DATE_PATTERN, value);
  if (isoDate !== null) {
    return validateExplicitDate(isoDate[1], isoDate[2], isoDate[3]);
  }

  const ptBrDate = matchEntire(PT_BR_DATE_PATTERN, value);
  if (ptBrDate !== null) {
    return validateExplicitDate(ptBrDate[3], ptBrDate[2], ptBrDate[1]);
  }

  const yearlessDate = matchEntire(YEARLESS_DATE_PATTERN, value);
  if (yearlessDate !== null) {
    const dayText = yearlessDate[1];
    const monthText = yearlessDate[2];
    if (dayText === undefined || monthText === undefined) {
      return { ok: false, code: FAILURE_CODE.INVALID_DATE };
    }

    const day = Number(dayText);
    const month = Number(monthText);
    return isValidMonthDay(month, day)
      ? { ok: true, value: null }
      : { ok: false, code: FAILURE_CODE.INVALID_DATE };
  }

  return { ok: false, code: FAILURE_CODE.INVALID_DATE };
};

const failure = (code: OcrFailureCodeV1): OcrParseResultV1 => ({
  ok: false,
  error: { code },
});

export function parseOcrV1(
  payload: unknown,
  manifest: unknown,
): OcrParseResultV1 {
  const manifestValidation = validateManifest(manifest);
  if (!manifestValidation.ok) {
    return failure(manifestValidation.code);
  }

  const payloadValidation = validatePayload(payload);
  if (!payloadValidation.ok) {
    return failure(payloadValidation.code);
  }

  const payloadRegionsByPage = new Map<number, Map<number, RegionInput>>();
  for (const region of payloadValidation.value.regions) {
    const regionsOnPage =
      payloadRegionsByPage.get(region.pageNumber) ??
      new Map<number, RegionInput>();
    if (regionsOnPage.has(region.regionIndex)) {
      return failure(FAILURE_CODE.REGION_ACCOUNTING_MISMATCH);
    }
    regionsOnPage.set(region.regionIndex, region);
    payloadRegionsByPage.set(region.pageNumber, regionsOnPage);
  }

  if (
    payloadValidation.value.regions.length !==
    manifestValidation.value.regions.length
  ) {
    return failure(FAILURE_CODE.REGION_ACCOUNTING_MISMATCH);
  }

  const matchedRegions: RegionInput[] = [];
  for (const manifestRegion of manifestValidation.value.regions) {
    const payloadRegion = payloadRegionsByPage
      .get(manifestRegion.pageNumber)
      ?.get(manifestRegion.regionIndex);
    if (payloadRegion === undefined) {
      return failure(FAILURE_CODE.REGION_ACCOUNTING_MISMATCH);
    }
    if (payloadRegion.status === REGION_STATUS.FAILED) {
      return failure(FAILURE_CODE.REGION_FAILED);
    }
    matchedRegions.push(payloadRegion);
  }

  let candidateCount = 0;
  for (const region of matchedRegions) {
    candidateCount += region.candidates.length;
    if (candidateCount > MAX_CANDIDATE_COUNT) {
      return failure(FAILURE_CODE.TOO_MANY_CANDIDATES);
    }
  }
  if (candidateCount === 0) {
    return failure(FAILURE_CODE.NO_CANDIDATES);
  }

  const regions: OcrParsedRegionV1[] = [];
  for (
    let regionOffset = 0;
    regionOffset < matchedRegions.length;
    regionOffset += 1
  ) {
    const manifestRegion = manifestValidation.value.regions[regionOffset];
    const payloadRegion = matchedRegions[regionOffset];
    if (manifestRegion === undefined || payloadRegion === undefined) {
      return failure(FAILURE_CODE.REGION_ACCOUNTING_MISMATCH);
    }

    const candidates: OcrCandidateV1[] = [];
    for (const rawCandidate of payloadRegion.candidates) {
      if (!hasValidAmountCents(rawCandidate.amountCents)) {
        return failure(FAILURE_CODE.INVALID_AMOUNT_CENTS);
      }

      const dateValidation = validateDate(rawCandidate.dateText);
      if (!dateValidation.ok) {
        return failure(dateValidation.code);
      }

      candidates.push({
        amountCents: rawCandidate.amountCents,
        date: dateValidation.value,
        verificationStatus: VERIFICATION_STATUS_UNVERIFIED,
        selected: SELECTED_BY_DEFAULT,
      });
    }

    regions.push({
      pageNumber: manifestRegion.pageNumber,
      regionIndex: manifestRegion.regionIndex,
      candidates,
    });
  }

  return {
    ok: true,
    value: {
      version: VERSION_V1,
      accounting: {
        pageCount: manifestValidation.value.pageCount,
        regionCount: manifestValidation.value.regions.length,
        candidateCount,
      },
      regions,
    },
  };
}
