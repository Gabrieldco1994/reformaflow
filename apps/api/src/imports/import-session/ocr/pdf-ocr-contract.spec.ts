import {
  PDF_OCR_LIMITS,
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
} from "@reformaflow/domain";
import { PdfOcrFailureCode, parsePdfOcrV2 } from "./pdf-ocr-parser";
import * as pdfOcrParser from "./pdf-ocr-parser";
import { isPdfOcrEnabled } from "./pdf-ocr-capability";

const ARTIFACT_SHA = "a".repeat(64);
const context = {
  artifactSha256: ARTIFACT_SHA,
  pageCount: 2,
  requestId: "10000000-0000-4000-8000-000000000001",
  responseId: "vertex-response-719",
  modelVersion: "gemini-2.5-flash-001",
  usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  latencyMs: 25,
};
const candidate = {
  pageNumber: 2,
  pageOccurrenceIndex: 1,
  description: "MERCADO",
  amountCents: "-1001",
  amountMeaning: "LINE_AMOUNT",
  date: "2026-10-13",
  installment: { index: 1, total: 2 },
  evidenceText: "13/10/2026 MERCADO 10,01",
};
const payload = (overrides: Record<string, unknown> = {}) => ({
  completionStatus: "COMPLETE",
  reportedPageCount: 2,
  pageAccounting: [
    { pageNumber: 1, status: "EMPTY", visibleOccurrenceCount: 0 },
    { pageNumber: 2, status: "READABLE", visibleOccurrenceCount: 1 },
  ],
  candidates: [candidate],
  ...overrides,
});

describe("strict review-only OCR parser", () => {
  it.each([
    ["empty", ""],
    ["193 printable bytes", "v".repeat(193)],
    ["control", "version\n2"],
    ["wrong type", 2],
  ])("rejects an invalid %s model version", (_label, modelVersion) => {
    expect(parsePdfOcrV2(payload(), { ...context, modelVersion })).toEqual({
      ok: false,
      error: { code: PdfOcrFailureCode.INVALID_PAYLOAD },
    });
  });

  type V3Parser = (
    payload: unknown,
    parseContext: typeof context,
  ) =>
    | { readonly ok: true; readonly value: Record<string, unknown> }
    | {
        readonly ok: false;
        readonly error: Readonly<{ code: string }>;
      };

  const parseV3: V3Parser = (payload, parseContext) => {
    const parser = (pdfOcrParser as unknown as Record<string, unknown>)
      .parsePdfOcrV3;
    if (typeof parser !== "function")
      return {
        ok: false,
        error: { code: "PDF_OCR_V3_BOUNDARY_NOT_IMPLEMENTED" },
      };
    return (parser as V3Parser)(payload, parseContext);
  };

  const v3Candidate = {
    pageNumber: 2,
    pageOccurrenceIndex: 1,
    description: "MERCADO",
    amountCents: "-1001",
    sign: "NEGATIVE",
    amountMeaning: "LINE_AMOUNT",
    dateText: "13/10/2026",
    normalizedDate: "2026-10-13",
    dateExplicitness: "FULL",
    installment: { index: 1, total: 2 },
    evidenceText: "13/10/2026 MERCADO -10,01",
  };
  const v3Payload = (candidateOverride: Record<string, unknown> = {}) =>
    payload({ candidates: [{ ...v3Candidate, ...candidateOverride }] });

  describe("strict provider document V3", () => {
    it("accepts only the exact V3 candidate keys", () => {
      expect(parseV3(v3Payload(), context)).toMatchObject({
        ok: true,
        value: {
          version: 3,
          candidates: [
            {
              ...v3Candidate,
              dateOnly: "2026-10-13",
              selected: false,
              verificationStatus: "UNVERIFIED",
            },
          ],
        },
      });
    });

    it("rejects the legacy provider date shape instead of promoting it", () => {
      const {
        dateText: _dateText,
        normalizedDate: _normalizedDate,
        ...legacy
      } = v3Candidate;

      expect(
        parseV3(
          payload({
            candidates: [{ ...legacy, date: "2026-10-13" }],
          }),
          context,
        ),
      ).toEqual({
        ok: false,
        error: { code: "INVALID_PAYLOAD" },
      });
    });

    it.each([
      [null, "UNKNOWN", "UNKNOWN", true],
      [null, "POSITIVE", "UNKNOWN", false],
      [null, "UNKNOWN", "LINE_AMOUNT", false],
      ["-1", "NEGATIVE", "LINE_AMOUNT", true],
      ["-1", "POSITIVE", "LINE_AMOUNT", false],
      ["0", "ZERO", "LINE_AMOUNT", true],
      ["0", "POSITIVE", "LINE_AMOUNT", false],
      ["1", "POSITIVE", "UNKNOWN", true],
      ["1", "NEGATIVE", "UNKNOWN", false],
    ] as const)(
      "enforces amount/sign invariant for %s %s %s",
      (amountCents, sign, amountMeaning, accepted) => {
        const result = parseV3(
          v3Payload({ amountCents, sign, amountMeaning }),
          context,
        );

        expect(result.ok).toBe(accepted);
        if (!accepted)
          expect(result).toEqual({
            ok: false,
            error: { code: "INVALID_AMOUNT_CENTS" },
          });
      },
    );

    it.each([
      ["FULL", "13/10/2026", "2026-10-13", "2026-10-13", true],
      ["YEARLESS", "13/10", null, null, true],
      ["MISSING", null, null, null, true],
      ["UNKNOWN", "13 ou 18/10", null, null, true],
      ["FULL", "13/10/2026", null, null, false],
      ["YEARLESS", "13/10", "2026-10-13", null, false],
      ["MISSING", "13/10", null, null, false],
      ["UNKNOWN", "13/10", "2026-10-13", null, false],
    ] as const)(
      "enforces %s date triple without current-year inference",
      (
        dateExplicitness,
        dateText,
        normalizedDate,
        expectedDateOnly,
        accepted,
      ) => {
        const result = parseV3(
          v3Payload({ dateExplicitness, dateText, normalizedDate }),
          context,
        );

        expect(result.ok).toBe(accepted);
        if (accepted)
          expect(result).toMatchObject({
            value: { candidates: [{ dateOnly: expectedDateOnly }] },
          });
        else
          expect(result).toEqual({
            ok: false,
            error: { code: "INVALID_DATE" },
          });
      },
    );
  });

  it.each(["v", "v".repeat(192)])(
    "accepts an opaque printable model version at its bounds",
    (modelVersion) => {
      expect(
        parsePdfOcrV2(payload(), { ...context, modelVersion }),
      ).toMatchObject({
        ok: true,
        value: { provenance: { modelVersion } },
      });
    },
  );

  it("keeps signed visible evidence without financial classification", () => {
    expect(parsePdfOcrV2(payload(), context)).toMatchObject({
      ok: true,
      value: {
        artifactSha256: ARTIFACT_SHA,
        pageCount: 2,
        candidates: [
          {
            pageNumber: 2,
            amountCents: "-1001",
            evidence: {
              pageNumber: 2,
              text: candidate.evidenceText,
            },
          },
        ],
      },
    });
  });

  it("accepts zero candidates, signed zero, and uncertainty without inference", () => {
    expect(
      parsePdfOcrV2(
        payload({
          pageAccounting: [
            { pageNumber: 1, status: "EMPTY", visibleOccurrenceCount: 0 },
            { pageNumber: 2, status: "EMPTY", visibleOccurrenceCount: 0 },
          ],
          candidates: [],
        }),
        context,
      ),
    ).toMatchObject({
      ok: true,
      value: { candidates: [] },
    });

    expect(
      parsePdfOcrV2(
        payload({
          candidates: [
            {
              ...candidate,
              description: null,
              amountCents: null,
              amountMeaning: "UNKNOWN",
              date: null,
              installment: null,
            },
          ],
        }),
        context,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        candidates: [
          {
            description: null,
            amountCents: null,
            amountMeaning: "UNKNOWN",
            date: null,
            installment: null,
          },
        ],
      },
    });
    expect(
      parsePdfOcrV2(
        payload({
          candidates: [{ ...candidate, amountCents: "0" }],
        }),
        context,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        candidates: [{ amountCents: "0", amountMeaning: "LINE_AMOUNT" }],
      },
    });
  });

  describe("direct OCR release gate", () => {
    const ready = {
      providerReady: true,
      consentV2Ready: true,
      vaultReady: true,
    };

    it("is OFF by default and requires the exact opt-in value", () => {
      expect(isPdfOcrEnabled({}, ready)).toBe(false);
      expect(isPdfOcrEnabled({ IMPORT_OCR_ENABLED: "TRUE" }, ready)).toBe(
        false,
      );
      expect(isPdfOcrEnabled({ IMPORT_OCR_ENABLED: "true" }, ready)).toBe(true);
    });

    it.each(Object.keys(ready))("fails closed when %s is not ready", (key) => {
      expect(
        isPdfOcrEnabled(
          { IMPORT_OCR_ENABLED: "true" },
          { ...ready, [key]: false },
        ),
      ).toBe(false);
    });
  });

  it("admits the measured dense bound and rejects one more candidate", () => {
    const denseCandidates = Array.from(
      { length: PDF_OCR_LIMITS.candidatesPerFile },
      (_, index) => ({ ...candidate, pageOccurrenceIndex: index + 1 }),
    );
    expect(
      parsePdfOcrV2(
        payload({
          pageAccounting: [
            { pageNumber: 1, status: "EMPTY", visibleOccurrenceCount: 0 },
            {
              pageNumber: 2,
              status: "READABLE",
              visibleOccurrenceCount: PDF_OCR_LIMITS.candidatesPerFile,
            },
          ],
          candidates: denseCandidates,
        }),
        context,
      ).ok,
    ).toBe(true);
    expect(
      parsePdfOcrV2(
        {
          completionStatus: "OCCURRENCE_LIMIT_EXCEEDED",
          reportedPageCount: 2,
          pageAccounting: [
            { pageNumber: 1, status: "EMPTY", visibleOccurrenceCount: 0 },
            {
              pageNumber: 2,
              status: "READABLE",
              visibleOccurrenceCount: PDF_OCR_LIMITS.candidatesPerFile + 1,
            },
          ],
          candidates: [],
        },
        context,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: PdfOcrFailureCode.LIMIT_EXCEEDED,
        provenance: {
          provider: PDF_OCR_PROVIDER_ID,
          model: PDF_OCR_MODEL_ID,
          modelVersion: context.modelVersion,
          region: PDF_OCR_REGION,
          requestId: context.requestId,
          responseId: context.responseId,
          usage: context.usage,
          latencyMs: context.latencyMs,
        },
      },
    });
  });

  it.each([
    ["model echo", { ...payload(), version: 2 }, "INVALID_PAYLOAD"],
    [
      "artifact echo",
      { ...payload(), artifactSha256: ARTIFACT_SHA },
      "INVALID_PAYLOAD",
    ],
    [
      "partial candidate",
      payload({ candidates: [{ ...candidate, date: undefined }] }),
      "INVALID_DATE",
    ],
    [
      "extra candidate field",
      payload({ candidates: [{ ...candidate, providerSaysSafe: true }] }),
      "PAGE_ACCOUNTING_MISMATCH",
    ],
    [
      "non-canonical cents",
      payload({ candidates: [{ ...candidate, amountCents: "01001" }] }),
      "INVALID_AMOUNT_CENTS",
    ],
    [
      "financial classification",
      payload({
        candidates: [{ ...candidate, amountMeaning: "INSTALLMENT_CHARGE" }],
      }),
      "INVALID_AMOUNT_CENTS",
    ],
    [
      "invalid date",
      payload({ candidates: [{ ...candidate, date: "2026-02-30" }] }),
      "INVALID_DATE",
    ],
    [
      "invalid installment",
      payload({
        candidates: [{ ...candidate, installment: { index: 3, total: 2 } }],
      }),
      "INVALID_INSTALLMENT",
    ],
  ])("rejects %s fail closed", (_label, wire, code) => {
    expect(parsePdfOcrV2(wire, context)).toEqual({
      ok: false,
      error: { code: code as PdfOcrFailureCode },
    });
  });
});
