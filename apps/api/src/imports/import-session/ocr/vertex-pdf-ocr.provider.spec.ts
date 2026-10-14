import { createHash } from "node:crypto";
import {
  PdfOcrProviderError,
  VertexPdfOcrProvider,
  type VertexAccessTokenPort,
} from "./vertex-pdf-ocr.provider";

const PDF_BYTES = Buffer.from("%PDF-1.4\nfixed-request-plan\n%%EOF");
const REQUEST = Object.freeze({
  artifactSha256: createHash("sha256").update(PDF_BYTES).digest("hex"),
  pageCount: 1,
  requestId: "10000000-0000-4000-8000-000000000001",
  pdfBytes: PDF_BYTES,
  signal: new AbortController().signal,
});
const TOKENS: VertexAccessTokenPort = Object.freeze({
  authTrace: "LOCAL_ADC",
  accessToken: async () => "test-only-token",
});

function response(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type"
          ? "application/json"
          : name.toLowerCase() === "content-length"
            ? String(bytes.length)
            : null,
    },
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
}

const generationWire = response({
  responseId: "response-719",
  modelVersion: "gemini-2.5-flash-001",
  candidates: [
    {
      finishReason: "STOP",
      content: {
        parts: [
          {
            text: JSON.stringify({
              completionStatus: "COMPLETE",
              reportedPageCount: 1,
              pageAccounting: [
                {
                  pageNumber: 1,
                  status: "READABLE",
                  visibleOccurrenceCount: 1,
                },
              ],
              candidates: [
                {
                  pageNumber: 1,
                  pageOccurrenceIndex: 1,
                  description: "MERCADO",
                  amountCents: "20696",
                  sign: "POSITIVE",
                  amountMeaning: "LINE_AMOUNT",
                  dateText: "13/10/2026",
                  normalizedDate: "2026-10-13",
                  dateExplicitness: "FULL",
                  installment: null,
                  evidenceText: "13/10/2026 MERCADO 206,96",
                },
              ],
            }),
          },
        ],
      },
    },
  ],
  usageMetadata: {
    promptTokenCount: 123,
    candidatesTokenCount: 10,
    totalTokenCount: 133,
  },
});

function provider(fetcher: jest.Mock) {
  return new VertexPdfOcrProvider(
    "qa-project-719",
    TOKENS,
    fetcher,
    Object.freeze({ now: () => 1_000 }),
  );
}

async function observeExtraction(
  countWire: unknown,
  mutateBetweenCalls?: (calls: jest.Mock["mock"]["calls"]) => void,
) {
  const fetcher = jest.fn(async (...args: unknown[]) => {
    const callNumber = fetcher.mock.calls.length;
    if (callNumber === 1) return response(countWire);
    mutateBetweenCalls?.(fetcher.mock.calls);
    return generationWire;
  });
  let outcome: unknown = "SUCCESS";
  try {
    await provider(fetcher).extractPdf(REQUEST);
  } catch (error) {
    outcome =
      error instanceof PdfOcrProviderError
        ? {
            failure: error.failure,
            dispatchState: error.dispatchState,
          }
        : { failure: error instanceof Error ? error.message : "NON_ERROR" };
  }
  return {
    calls: fetcher.mock.calls.map(([url, init]) => ({
      url,
      body: (init as { body: string }).body,
    })),
    outcome,
  };
}

describe("Vertex countTokens request plan", () => {
  it("creates one immutable plan and sends its stored bodies unchanged", async () => {
    const observed = await observeExtraction({ totalTokens: 123 });

    expect(observed.outcome).toBe("SUCCESS");
    expect(observed.calls).toHaveLength(2);
    expect(observed.calls[0]!.url).toMatch(/:countTokens$/);
    expect(observed.calls[1]!.url).toMatch(/:generateContent$/);
    const countBody = JSON.parse(observed.calls[0]!.body) as {
      contents: unknown;
    };
    const generationBody = JSON.parse(observed.calls[1]!.body) as {
      contents: unknown;
    };
    expect(countBody.contents).toEqual(generationBody.contents);
    expect(observed.calls[0]!.body).toContain(PDF_BYTES.toString("base64"));
    expect(observed.calls[1]!.body).toContain(PDF_BYTES.toString("base64"));
  });

  it("accepts a real CountTokensResponse containing totalTokens only", async () => {
    const observed = await observeExtraction({ totalTokens: 123 });

    expect(observed.outcome).toBe("SUCCESS");
    expect(observed.calls).toHaveLength(2);
  });

  it("ignores bounded provider metadata but never treats it as authority", async () => {
    const observed = await observeExtraction({
      totalTokens: 123,
      totalBillableCharacters: 912,
      promptTokensDetails: [{ modality: "DOCUMENT", tokenCount: 123 }],
    });

    expect(observed.outcome).toBe("SUCCESS");
    expect(observed.calls).toHaveLength(2);
  });

  it("does not expect estimatedCostMicros or requestBindingSha256", async () => {
    const observed = await observeExtraction({ totalTokens: 123 });

    expect(observed.outcome).toBe("SUCCESS");
    expect(observed.calls).toHaveLength(2);
    expect(JSON.parse(observed.calls[0]!.body)).not.toHaveProperty(
      "requestBindingSha256",
    );
  });

  it.each([
    ["missing", {}],
    ["string", { totalTokens: "123" }],
    ["negative", { totalTokens: -1 }],
    ["fractional", { totalTokens: 1.5 }],
    ["unsafe integer", { totalTokens: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const)(
    "rejects %s totalTokens before generation",
    async (_label, wire) => {
      const observed = await observeExtraction(wire);

      expect(observed.outcome).toEqual({
        failure: "MALFORMED_RESPONSE",
        dispatchState: "DISPATCHED_OR_UNKNOWN",
      });
      expect(observed.calls).toHaveLength(1);
      expect(observed.calls[0]!.url).toMatch(/:countTokens$/);
    },
  );

  it.each([
    [24_575, 2, "SUCCESS"],
    [24_576, 2, "SUCCESS"],
    [
      24_577,
      1,
      {
        failure: "LIMIT_EXCEEDED",
        dispatchState: "DISPATCHED_OR_UNKNOWN",
      },
    ],
  ] as const)(
    "enforces input boundary %i",
    async (totalTokens, expectedCalls, expectedOutcome) => {
      const observed = await observeExtraction({ totalTokens });

      expect(observed.outcome).toEqual(expectedOutcome);
      expect(observed.calls).toHaveLength(expectedCalls);
    },
  );

  it("detects PDF, prompt, model or endpoint drift after count", async () => {
    const observed = await observeExtraction({ totalTokens: 123 }, () => {
      PDF_BYTES[PDF_BYTES.length - 1] = 0x20;
    });

    expect(observed.outcome).toEqual({
      failure: "OCR_REQUEST_PLAN_DRIFT",
      dispatchState: "DISPATCHED_OR_UNKNOWN",
    });
    expect(observed.calls).toHaveLength(1);
  });
});
