import { createHash } from "node:crypto";
import {
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_VERSION,
  type PdfOcrManifestV2,
} from "@reformaflow/domain";
import {
  IMPORT_OCR_ENV_KEY,
  isPdfOcrEnabled,
  type PdfOcrPrerequisiteReadiness,
} from "./pdf-ocr-capability";
import { parsePdfOcrV2 } from "./pdf-ocr-parser";
import type {
  FixedPdfOcrProviderPort,
  PdfOcrHumanAttestationPort,
} from "./pdf-ocr.ports";

const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const ARTIFACT_SHA = sha("artifact");
const PAGE_ONE_SHA = sha("page-one");
const PAGE_TWO_SHA = sha("page-two");
const REGION_SHA = sha("region-one");
const PROVIDER_REGION = "southamerica-east1";
const PROVIDER_REQUEST_ID = "request-ocr-719";
const BOUNDS = { x: 10, y: 20, width: 300, height: 80 };

const manifest = (): PdfOcrManifestV2 => ({
  version: PDF_OCR_VERSION,
  artifactSha256: ARTIFACT_SHA,
  pageCount: 2,
  request: {
    provider: PDF_OCR_PROVIDER_ID,
    model: PDF_OCR_MODEL_ID,
    region: PROVIDER_REGION,
    requestId: PROVIDER_REQUEST_ID,
  },
  pages: [
    {
      pageNumber: 1,
      pageSha256: PAGE_ONE_SHA,
      widthPx: 1200,
      heightPx: 1600,
      regions: [
        {
          regionIndex: 1,
          regionSha256: REGION_SHA,
          bounds: BOUNDS,
        },
      ],
    },
    {
      pageNumber: 2,
      pageSha256: PAGE_TWO_SHA,
      widthPx: 1200,
      heightPx: 1600,
      regions: [],
    },
  ],
});

const rawCandidate = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => {
  const description = "PADARIA CENTRAL";
  return {
    description,
    amountCents: "-1250",
    dateText: "13/10/2026",
    installment: { index: 2, total: 12 },
    evidence: {
      pageNumber: 1,
      regionIndex: 1,
      regionSha256: REGION_SHA,
      text: description,
      textSha256: sha(description),
    },
    ...overrides,
  };
};

const payload = (
  candidates: readonly unknown[] = [rawCandidate()],
): Record<string, unknown> => ({
  version: PDF_OCR_VERSION,
  artifactSha256: ARTIFACT_SHA,
  provenance: {
    provider: PDF_OCR_PROVIDER_ID,
    model: PDF_OCR_MODEL_ID,
    region: PROVIDER_REGION,
    requestId: PROVIDER_REQUEST_ID,
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    },
    latencyMs: 900,
  },
  pages: [
    {
      pageNumber: 2,
      pageSha256: PAGE_TWO_SHA,
      regions: [],
    },
    {
      pageNumber: 1,
      pageSha256: PAGE_ONE_SHA,
      regions: [
        {
          regionIndex: 1,
          regionSha256: REGION_SHA,
          status: "COMPLETE",
          candidates: [...candidates],
        },
      ],
    },
  ],
});

const expectFailure = (result: unknown, code: string): void => {
  expect(result).toEqual({ ok: false, error: { code } });
};

const parseOne = (overrides: Record<string, unknown> = {}) =>
  parsePdfOcrV2(payload([rawCandidate(overrides)]), manifest());

const oneParsedCandidate = (overrides: Record<string, unknown> = {}) => {
  const result = parseOne(overrides);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value.pages[0]!.regions[0]!.candidates[0]!;
};

describe("parsePdfOcrV2", () => {
  it("returns manifest-ordered, hash-bound candidates forced to human review", () => {
    const yearlessDescription = "MERCADO BAIRRO";
    const result = parsePdfOcrV2(
      payload([
        rawCandidate(),
        rawCandidate({
          description: yearlessDescription,
          amountCents: "0",
          dateText: "9/10",
          installment: null,
          evidence: {
            pageNumber: 1,
            regionIndex: 1,
            regionSha256: REGION_SHA,
            text: yearlessDescription,
            textSha256: sha(yearlessDescription),
          },
        }),
      ]),
      manifest(),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        version: PDF_OCR_VERSION,
        artifactSha256: ARTIFACT_SHA,
        provenance: {
          provider: PDF_OCR_PROVIDER_ID,
          model: PDF_OCR_MODEL_ID,
          region: PROVIDER_REGION,
          requestId: PROVIDER_REQUEST_ID,
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            totalTokens: 150,
          },
          latencyMs: 900,
        },
        accounting: {
          pageCount: 2,
          regionCount: 1,
          candidateCount: 2,
        },
        pages: [
          {
            pageNumber: 1,
            pageSha256: PAGE_ONE_SHA,
            regions: [
              {
                regionIndex: 1,
                regionSha256: REGION_SHA,
                bounds: BOUNDS,
                candidates: [
                  {
                    description: "PADARIA CENTRAL",
                    amountCents: "-1250",
                    dateText: "13/10/2026",
                    date: "2026-10-13",
                    diagnostics: [],
                    installment: { index: 2, total: 12 },
                    verificationStatus: "UNVERIFIED",
                    selected: false,
                    evidence: {
                      artifactSha256: ARTIFACT_SHA,
                      pageNumber: 1,
                      pageSha256: PAGE_ONE_SHA,
                      regionIndex: 1,
                      regionSha256: REGION_SHA,
                      bounds: BOUNDS,
                      text: "PADARIA CENTRAL",
                      textSha256: sha("PADARIA CENTRAL"),
                    },
                  },
                  {
                    description: yearlessDescription,
                    amountCents: "0",
                    dateText: "9/10",
                    date: null,
                    diagnostics: ["MISSING_YEAR"],
                    installment: null,
                    verificationStatus: "UNVERIFIED",
                    selected: false,
                    evidence: {
                      artifactSha256: ARTIFACT_SHA,
                      pageNumber: 1,
                      pageSha256: PAGE_ONE_SHA,
                      regionIndex: 1,
                      regionSha256: REGION_SHA,
                      bounds: BOUNDS,
                      text: yearlessDescription,
                      textSha256: sha(yearlessDescription),
                    },
                  },
                ],
              },
            ],
          },
          {
            pageNumber: 2,
            pageSha256: PAGE_TWO_SHA,
            regions: [],
          },
        ],
      },
    });
  });

  it.each([
    { selected: true },
    { selected: false },
    { verificationStatus: "VERIFIED" },
    { verificationStatus: "UNVERIFIED" },
  ])("rejects provider-owned review state %#", (providerState) => {
    expectFailure(
      parsePdfOcrV2(
        payload([{ ...rawCandidate(), ...providerState }]),
        manifest(),
      ),
      "INVALID_PAYLOAD",
    );
  });

  it.each(["-2147483647", "0", "2147483647"])(
    "accepts canonical signed cents at safe bounds: %s",
    (amountCents) => {
      expect(oneParsedCandidate({ amountCents }).amountCents).toBe(amountCents);
    },
  );

  it.each([
    "-2147483648",
    "2147483648",
    "-0",
    "+1",
    "01",
    "-01",
    "1.00",
    "1e2",
    "",
    " 1",
    "1 ",
    0,
    -1,
  ])("rejects noncanonical or unsafe cents mutation %p", (amountCents) => {
    expectFailure(parseOne({ amountCents }), "INVALID_AMOUNT_CENTS");
  });

  it.each([
    ["2024-02-29", "2024-02-29"],
    ["29/2/2024", "2024-02-29"],
    ["01/01/1900", "1900-01-01"],
    ["31/12/2199", "2199-12-31"],
  ])("accepts only explicit calendar date %s", (dateText, date) => {
    expect(oneParsedCandidate({ dateText })).toMatchObject({
      dateText,
      date,
      diagnostics: [],
    });
  });

  it.each(["1/2", "29/2"])(
    "keeps valid yearless date %s null with MISSING_YEAR",
    (dateText) => {
      expect(oneParsedCandidate({ dateText })).toMatchObject({
        dateText,
        date: null,
        diagnostics: ["MISSING_YEAR"],
      });
    },
  );

  it.each([
    "2023-02-29",
    "31/04/2024",
    "29/02/1900",
    "1/2/24",
    "2024-2-01",
    "hoje",
    "",
    " 1/2/2024",
    20241013,
  ])("rejects invalid or inferred-date mutation %p", (dateText) => {
    expectFailure(parseOne({ dateText }), "INVALID_DATE");
  });

  it.each([
    { index: 1, total: 1 },
    { index: 1, total: 24 },
    { index: 24, total: 24 },
  ])("accepts exact installment pair %#", (installment) => {
    expect(oneParsedCandidate({ installment }).installment).toEqual(
      installment,
    );
  });

  it.each([
    {},
    { index: 1 },
    { total: 2 },
    { index: 0, total: 1 },
    { index: 2, total: 1 },
    { index: 1, total: 25 },
    { index: 1.5, total: 2 },
    { index: 1, total: 2, label: "1/2" },
    "1/2",
  ])("rejects malformed installment mutation %#", (installment) => {
    expectFailure(parseOne({ installment }), "INVALID_INSTALLMENT");
  });

  it.each([
    ["provider", "OTHER_PROVIDER"],
    ["model", "fallback-model"],
    ["region", "us-central1"],
    ["requestId", "other-request"],
  ])("rejects mutated provenance binding %s", (key, value) => {
    const mutated = payload();
    mutated.provenance = {
      ...(mutated.provenance as Record<string, unknown>),
      [key]: value,
    };
    expectFailure(parsePdfOcrV2(mutated, manifest()), "INVALID_PROVENANCE");
  });

  it("rejects malformed usage, latency, and provenance extra keys", () => {
    for (const provenance of [
      {
        ...(payload().provenance as Record<string, unknown>),
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 149 },
      },
      {
        ...(payload().provenance as Record<string, unknown>),
        latencyMs: -1,
      },
      {
        ...(payload().provenance as Record<string, unknown>),
        fallbackProvider: "OTHER_PROVIDER",
      },
    ]) {
      const mutated = payload();
      mutated.provenance = provenance;
      expectFailure(parsePdfOcrV2(mutated, manifest()), "INVALID_PROVENANCE");
    }
  });

  it("rejects omitted, duplicated, failed, empty, or extra page/region output", () => {
    const missingPage = payload();
    missingPage.pages = (missingPage.pages as unknown[]).slice(1);
    expectFailure(
      parsePdfOcrV2(missingPage, manifest()),
      "PAGE_ACCOUNTING_MISMATCH",
    );

    const duplicatePage = payload();
    duplicatePage.pages = [
      ...(duplicatePage.pages as unknown[]),
      (duplicatePage.pages as unknown[])[0],
    ];
    expectFailure(
      parsePdfOcrV2(duplicatePage, manifest()),
      "PAGE_ACCOUNTING_MISMATCH",
    );

    const missingRegion = payload();
    const pages = missingRegion.pages as Array<Record<string, unknown>>;
    pages[1] = { ...pages[1], regions: [] };
    expectFailure(
      parsePdfOcrV2(missingRegion, manifest()),
      "REGION_ACCOUNTING_MISMATCH",
    );

    const failedRegion = payload();
    const failedPages = failedRegion.pages as Array<Record<string, unknown>>;
    const failedRegions = failedPages[1].regions as Array<
      Record<string, unknown>
    >;
    failedRegions[0] = {
      ...failedRegions[0],
      status: "FAILED",
      candidates: [],
    };
    expectFailure(parsePdfOcrV2(failedRegion, manifest()), "REGION_FAILED");

    expectFailure(parsePdfOcrV2(payload([]), manifest()), "NO_CANDIDATES");

    const extraKey = payload();
    extraKey.debug = "must not be accepted";
    expectFailure(parsePdfOcrV2(extraKey, manifest()), "INVALID_PAYLOAD");
  });

  it("accepts the candidate bound and fails closed immediately above it", () => {
    const maximum = Array.from({ length: 1000 }, () => rawCandidate());
    const accepted = parsePdfOcrV2(payload(maximum), manifest());
    expect(accepted).toMatchObject({
      ok: true,
      value: { accounting: { candidateCount: 1000 } },
    });

    expectFailure(
      parsePdfOcrV2(payload([...maximum, rawCandidate()]), manifest()),
      "LIMIT_EXCEEDED",
    );
  });

  it("rejects hash, bounds, description, and text-digest evidence mutations", () => {
    expectFailure(
      parseOne({
        evidence: {
          pageNumber: 1,
          regionIndex: 1,
          regionSha256: sha("other-region"),
          text: "PADARIA CENTRAL",
          textSha256: sha("PADARIA CENTRAL"),
        },
      }),
      "INVALID_EVIDENCE",
    );
    expectFailure(
      parseOne({
        description: "INVENTED",
      }),
      "INVALID_EVIDENCE",
    );
    expectFailure(
      parseOne({
        evidence: {
          pageNumber: 1,
          regionIndex: 1,
          regionSha256: REGION_SHA,
          text: "PADARIA CENTRAL",
          textSha256: sha("different"),
        },
      }),
      "INVALID_EVIDENCE",
    );

    const invalidBounds = JSON.parse(JSON.stringify(manifest())) as Record<
      string,
      unknown
    >;
    const invalidPages = invalidBounds.pages as Array<Record<string, unknown>>;
    const invalidRegions = invalidPages[0].regions as Array<
      Record<string, unknown>
    >;
    invalidRegions[0].bounds = { ...BOUNDS, width: 2000 };
    expectFailure(parsePdfOcrV2(payload(), invalidBounds), "INVALID_MANIFEST");
  });

  it("returns bounded typed failures without echoing provider content", () => {
    const secretMarker = "private-provider-content-must-not-escape";
    const result = parseOne({
      description: secretMarker,
      amountCents: "not-cents",
      evidence: {
        pageNumber: 1,
        regionIndex: 1,
        regionSha256: REGION_SHA,
        text: secretMarker,
        textSha256: sha(secretMarker),
      },
    });

    expectFailure(result, "INVALID_AMOUNT_CENTS");
    expect(JSON.stringify(result)).not.toContain(secretMarker);
  });

  it("is pure: it neither mutates inputs nor receives provider/writer ports", () => {
    const inputManifest = manifest();
    const inputPayload = payload();
    const before = JSON.stringify({ inputManifest, inputPayload });
    const provider = { extractPdf: jest.fn() };
    const writer = { write: jest.fn() };

    expect(parsePdfOcrV2(inputPayload, inputManifest)).toMatchObject({
      ok: true,
    });
    expect(JSON.stringify({ inputManifest, inputPayload })).toBe(before);
    expect(provider.extractPdf).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
  });
});

describe("PDF OCR capability and ports", () => {
  const ready: PdfOcrPrerequisiteReadiness = {
    providerReady: true,
    consentV2Ready: true,
    vaultReady: true,
  };

  it("defaults OFF and requires the flag plus every prerequisite", () => {
    expect(isPdfOcrEnabled({}, ready)).toBe(false);
    expect(isPdfOcrEnabled({ [IMPORT_OCR_ENV_KEY]: "false" }, ready)).toBe(
      false,
    );
    expect(isPdfOcrEnabled({ [IMPORT_OCR_ENV_KEY]: "true" }, ready)).toBe(true);

    for (const missing of Object.keys(ready) as Array<
      keyof PdfOcrPrerequisiteReadiness
    >) {
      expect(
        isPdfOcrEnabled(
          { [IMPORT_OCR_ENV_KEY]: "true" },
          { ...ready, [missing]: false },
        ),
      ).toBe(false);
    }
  });

  it("exposes one fixed provider and a separate human-attestation seam", async () => {
    const provider: FixedPdfOcrProviderPort = {
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      extractPdf: jest.fn().mockResolvedValue(payload()),
    };
    const attestation: PdfOcrHumanAttestationPort = {
      attest: jest.fn().mockResolvedValue(undefined),
    };

    expect(provider.provider).toBe(PDF_OCR_PROVIDER_ID);
    expect(provider.model).toBe(PDF_OCR_MODEL_ID);
    expect(provider.extractPdf).not.toHaveBeenCalled();
    expect(attestation.attest).not.toHaveBeenCalled();
  });
});
