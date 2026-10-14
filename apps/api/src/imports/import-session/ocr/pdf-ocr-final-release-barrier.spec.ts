import {
  PDF_OCR_CONSENT_POLICY_VERSION,
  PDF_OCR_CONSENT_PURPOSE,
  PDF_OCR_LIMITS,
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
  PDF_OCR_RETENTION_DAYS,
} from "@reformaflow/domain";
import { inspectPdfDocument } from "../../../credit-card/parsers/pdf-document";
import { PdfOcrFailureCode, parsePdfOcrV2 } from "./pdf-ocr-parser";
import {
  PDF_OCR_CONSENT_DECISION,
  parseStoredPdfOcrState,
  pdfOcrRequestPayloadHash,
  serializePdfOcrState,
  type StoredPdfOcrConsentV2,
} from "./pdf-ocr-state";
import { isAdmittedPdfOcrRequest } from "./pdf-ocr.ports";

const REQUEST = {
  version: 2 as const,
  expectedRevision: 3,
  requestId: "10000000-0000-4000-8000-000000000001",
  consentExternalProcessing: true as const,
};
const ARTIFACT_SHA = "a".repeat(64);
const COMPLETE_CONSENT: StoredPdfOcrConsentV2 = {
  attachmentId: "20000000-0000-4000-8000-000000000002",
  artifactSha256: ARTIFACT_SHA,
  requestId: REQUEST.requestId,
  requestPayloadHash: pdfOcrRequestPayloadHash(REQUEST),
  expectedRevision: REQUEST.expectedRevision,
  actorId: "30000000-0000-4000-8000-000000000003",
  consentPolicyVersion: PDF_OCR_CONSENT_POLICY_VERSION,
  consentDecision: PDF_OCR_CONSENT_DECISION,
  consentedAt: "2026-10-13T20:00:00.000Z",
  provider: PDF_OCR_PROVIDER_ID,
  model: PDF_OCR_MODEL_ID,
  purpose: PDF_OCR_CONSENT_PURPOSE,
  region: PDF_OCR_REGION,
  retentionDays: PDF_OCR_RETENTION_DAYS,
  sendsFullOriginal: true,
  includesMetadataAndEmbeddedContent: true,
  includesPotentiallyNonVisibleContent: true,
  usageId: null,
};

const CONTEXT = {
  artifactSha256: ARTIFACT_SHA,
  pageCount: PDF_OCR_LIMITS.pagesPerFile,
  requestId: REQUEST.requestId,
  responseId: "vertex-response-final-719",
  modelVersion: "release-barrier-fixture-v1",
  usage: { inputTokens: 30, outputTokens: 18, totalTokens: 48 },
  latencyMs: 25,
};

function rasterPdf(pages: number, text = false): Buffer {
  const body = [
    ...(text ? ["BT /F1 12 Tf 50 750 Td (01/10/2026 LOJA 10,01) Tj ET"] : []),
    "q 120 0 0 120 50 500 cm /Im1 Do Q",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${6 + index} 0 R`).join(" ")}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nX\nendstream",
    ...Array.from(
      { length: pages },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    ),
  ];
  let value = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  value += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}

describe("final #719 release barriers", () => {
  it("accepts only the complete exact external-processing declaration", () => {
    expect(
      parseStoredPdfOcrState(
        serializePdfOcrState({
          version: 2,
          consents: [COMPLETE_CONSENT],
        }),
      ).consents,
    ).toEqual([COMPLETE_CONSENT]);

    for (const key of [
      "sendsFullOriginal",
      "includesMetadataAndEmbeddedContent",
      "includesPotentiallyNonVisibleContent",
    ] as const) {
      const missing = { ...COMPLETE_CONSENT } as Record<string, unknown>;
      delete missing[key];
      expect(() =>
        parseStoredPdfOcrState(
          JSON.stringify({ version: 2, consents: [missing] }),
        ),
      ).toThrow();
      expect(() =>
        parseStoredPdfOcrState(
          JSON.stringify({
            version: 2,
            consents: [{ ...COMPLETE_CONSENT, [key]: false }],
          }),
        ),
      ).toThrow();
    }

    expect(() =>
      parseStoredPdfOcrState(
        JSON.stringify({
          version: 2,
          consents: [{ ...COMPLETE_CONSENT, hiddenContentMayBeOmitted: true }],
        }),
      ),
    ).toThrow();
  });

  it("derives scan eligibility from real local inspection, never from fixture labels", async () => {
    await expect(inspectPdfDocument(rasterPdf(1))).resolves.toEqual({
      kind: "OCR_ELIGIBLE",
      pageCount: 1,
    });
    await expect(inspectPdfDocument(rasterPdf(1, true))).resolves.toMatchObject(
      {
        kind: "LOCAL",
        document: {
          occurrences: [{ merchant: "LOJA", amountCents: 1001 }],
        },
      },
    );
  });

  it("admits an observed ten-page request and rejects eleven before dispatch", () => {
    const request = {
      artifactSha256: ARTIFACT_SHA,
      requestId: REQUEST.requestId,
      pdfBytes: rasterPdf(PDF_OCR_LIMITS.pagesPerFile),
      signal: new AbortController().signal,
    };
    expect(
      isAdmittedPdfOcrRequest({
        ...request,
        pageCount: PDF_OCR_LIMITS.pagesPerFile,
      }),
    ).toBe(true);
    expect(
      isAdmittedPdfOcrRequest({
        ...request,
        pageCount: PDF_OCR_LIMITS.pagesPerFile + 1,
      }),
    ).toBe(false);
  });

  it("preserves all 24 dense lines, signed cents, zero, and UNKNOWN without inference", () => {
    const candidates = Array.from(
      { length: PDF_OCR_LIMITS.candidatesPerFile },
      (_, index) => ({
        pageNumber: Math.floor(index / 3) + 1,
        pageOccurrenceIndex: (index % 3) + 1,
        description: index === 2 ? null : `LINHA ${index + 1}`,
        amountCents:
          index === 0 ? "-20696" : index === 1 ? "0" : index === 2 ? null : "1",
        amountMeaning: index === 2 ? "UNKNOWN" : "LINE_AMOUNT",
        date: index === 2 ? null : "2026-10-13",
        installment: index === 2 ? null : { index: 1, total: 1 },
        evidenceText: `evidencia ${index + 1}`,
      }),
    );
    const pageAccounting = Array.from(
      { length: PDF_OCR_LIMITS.pagesPerFile },
      (_, pageIndex) => {
        const visibleOccurrenceCount = candidates.filter(
          (candidate) => candidate.pageNumber === pageIndex + 1,
        ).length;
        return {
          pageNumber: pageIndex + 1,
          status: visibleOccurrenceCount === 0 ? "EMPTY" : "READABLE",
          visibleOccurrenceCount,
        };
      },
    );
    const parsed = parsePdfOcrV2(
      {
        completionStatus: "COMPLETE",
        reportedPageCount: PDF_OCR_LIMITS.pagesPerFile,
        pageAccounting,
        candidates,
      },
      CONTEXT,
    );

    if (!parsed.ok) throw new Error(parsed.error.code);
    expect(parsed.value).toMatchObject({
      artifactSha256: ARTIFACT_SHA,
      pageCount: PDF_OCR_LIMITS.pagesPerFile,
      provenance: {
        provider: PDF_OCR_PROVIDER_ID,
        model: PDF_OCR_MODEL_ID,
        region: PDF_OCR_REGION,
        requestId: REQUEST.requestId,
        responseId: CONTEXT.responseId,
        usage: CONTEXT.usage,
        latencyMs: CONTEXT.latencyMs,
      },
    });
    expect(parsed.value.candidates).toHaveLength(
      PDF_OCR_LIMITS.candidatesPerFile,
    );
    expect(parsed.value.candidates.slice(0, 3)).toMatchObject([
      { amountCents: "-20696", amountMeaning: "LINE_AMOUNT" },
      { amountCents: "0", amountMeaning: "LINE_AMOUNT" },
      {
        description: null,
        amountCents: null,
        amountMeaning: "UNKNOWN",
        date: null,
        installment: null,
      },
    ]);

    expect(
      parsePdfOcrV2(
        {
          completionStatus: "OCCURRENCE_LIMIT_EXCEEDED",
          reportedPageCount: PDF_OCR_LIMITS.pagesPerFile,
          pageAccounting: pageAccounting.map((page) =>
            page.pageNumber === 1
              ? {
                  ...page,
                  visibleOccurrenceCount: page.visibleOccurrenceCount + 1,
                }
              : page,
          ),
          candidates: [],
        },
        CONTEXT,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: PdfOcrFailureCode.LIMIT_EXCEEDED,
        provenance: {
          provider: PDF_OCR_PROVIDER_ID,
          model: PDF_OCR_MODEL_ID,
          modelVersion: CONTEXT.modelVersion,
          region: PDF_OCR_REGION,
          requestId: CONTEXT.requestId,
          responseId: CONTEXT.responseId,
          usage: CONTEXT.usage,
          latencyMs: CONTEXT.latencyMs,
        },
      },
    });
  });
});
