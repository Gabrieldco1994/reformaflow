import { createHash } from "node:crypto";
import {
  PdfOcrProviderError,
  VertexPdfOcrProvider,
  type VertexAccessTokenPort,
} from "./vertex-pdf-ocr.provider";
import * as pdfOcrParser from "./pdf-ocr-parser";

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

afterEach(() => jest.restoreAllMocks());

function response(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return responseBytes(bytes);
}

function responseBytes(bytes: Buffer) {
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

type QualificationNetworkEvent = Readonly<Record<string, unknown>> & {
  readonly kind:
    | "COUNT_TOKENS_REQUEST"
    | "COUNT_TOKENS_RESPONSE"
    | "ADMISSION_DECISION"
    | "GENERATION_REQUEST"
    | "GENERATION_RESPONSE"
    | "SPEND_RECONCILED";
  readonly requestPlanSha256: string;
};

function qualificationRequest(
  recordEvent: (event: QualificationNetworkEvent) => void,
) {
  return {
    ...REQUEST,
    qualificationEvidence: {
      runId: "band-3-run-001",
      attempt: 1,
      caseId: "scan-001",
      tenantId: "tenant-synthetic-a",
      spentKnownBeforeMicros: 0,
      hardLimitMicros: 500_000,
      recordEvent,
    },
  } as Parameters<VertexPdfOcrProvider["extractPdf"]>[0];
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

function strictGenerationWire(candidate: Record<string, unknown>) {
  return response({
    responseId: "response-strict-v3",
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
                candidates: [candidate],
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
}

async function qualificationExtraction(candidate: Record<string, unknown>) {
  const fetcher = jest
    .fn()
    .mockResolvedValueOnce(response({ totalTokens: 123 }))
    .mockResolvedValueOnce(strictGenerationWire(candidate));
  const legacyParser = jest.spyOn(pdfOcrParser, "parsePdfOcrV2");
  let result:
    | Awaited<ReturnType<VertexPdfOcrProvider["extractPdf"]>>
    | PdfOcrProviderError;
  try {
    result = await provider(fetcher).extractPdf({
      ...REQUEST,
      qualificationCapture: true,
    });
  } catch (error) {
    if (!(error instanceof PdfOcrProviderError)) throw error;
    result = error;
  }
  return { fetcher, legacyParser, result };
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

  it("qualificationCapture parses strict V3 without ever invoking the legacy V2 parser", async () => {
    const observed = await qualificationExtraction({
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
    });

    expect(observed.legacyParser).not.toHaveBeenCalled();
    expect(observed.fetcher).toHaveBeenCalledTimes(2);
    expect(observed.result).toMatchObject({
      candidates: [
        {
          dateText: "13/10/2026",
          normalizedDate: "2026-10-13",
          dateExplicitness: "FULL",
        },
      ],
    });
  });

  it("qualificationCapture rejects the legacy date key without falling back to V2", async () => {
    const observed = await qualificationExtraction({
      pageNumber: 1,
      pageOccurrenceIndex: 1,
      description: "MERCADO",
      amountCents: "20696",
      amountMeaning: "LINE_AMOUNT",
      date: "2026-10-13",
      installment: null,
      evidenceText: "13/10/2026 MERCADO 206,96",
    });

    expect(observed.legacyParser).not.toHaveBeenCalled();
    expect(observed.fetcher).toHaveBeenCalledTimes(2);
    expect(observed.result).toMatchObject({
      failure: "MALFORMED_RESPONSE",
      dispatchState: "DISPATCHED_OR_UNKNOWN",
    });
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

  it.each([
    [0, "SUCCESS", 2],
    [1, "SUCCESS", 2],
    [
      -1,
      {
        failure: "MALFORMED_RESPONSE",
        dispatchState: "DISPATCHED_OR_UNKNOWN",
      },
      1,
    ],
    [
      1.5,
      {
        failure: "MALFORMED_RESPONSE",
        dispatchState: "DISPATCHED_OR_UNKNOWN",
      },
      1,
    ],
    [
      Number.MAX_SAFE_INTEGER + 1,
      {
        failure: "MALFORMED_RESPONSE",
        dispatchState: "DISPATCHED_OR_UNKNOWN",
      },
      1,
    ],
  ] as const)(
    "[B3] pins CountTokens totalTokens=%p",
    async (totalTokens, expectedOutcome, expectedCalls) => {
      const observed = await observeExtraction({ totalTokens });

      expect(observed.outcome).toEqual(expectedOutcome);
      expect(observed.calls).toHaveLength(expectedCalls);
    },
  );

  it("[B3] rejects duplicate totalTokens before generation", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(
        responseBytes(Buffer.from('{"totalTokens":0,"totalTokens":1}')),
      )
      .mockResolvedValueOnce(generationWire);

    await expect(provider(fetcher).extractPdf(REQUEST)).rejects.toMatchObject({
      failure: "MALFORMED_RESPONSE",
      dispatchPhase: "COUNT_TOKENS",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("[B3] emits six admitted events at the actual fetch boundary", async () => {
    const order: string[] = [];
    const events: QualificationNetworkEvent[] = [];
    const fetchBodies: string[] = [];
    const fetcher = jest.fn(async (url: string, init: { body: string }) => {
      fetchBodies.push(init.body);
      order.push(
        url.endsWith(":countTokens") ? "FETCH_COUNT" : "FETCH_GENERATION",
      );
      return url.endsWith(":countTokens")
        ? response({
            totalTokens: 100,
            totalBillableCharacters: 912,
            promptTokensDetails: [{ modality: "DOCUMENT", tokenCount: 100 }],
          })
        : generationWire;
    });
    const recordEvent = (event: QualificationNetworkEvent) => {
      events.push(structuredClone(event));
      order.push(event.kind);
    };

    await provider(fetcher).extractPdf(qualificationRequest(recordEvent));

    expect(order).toEqual([
      "COUNT_TOKENS_REQUEST",
      "FETCH_COUNT",
      "COUNT_TOKENS_RESPONSE",
      "ADMISSION_DECISION",
      "GENERATION_REQUEST",
      "FETCH_GENERATION",
      "GENERATION_RESPONSE",
      "SPEND_RECONCILED",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.kind)).toEqual([
      "COUNT_TOKENS_REQUEST",
      "COUNT_TOKENS_RESPONSE",
      "ADMISSION_DECISION",
      "GENERATION_REQUEST",
      "GENERATION_RESPONSE",
      "SPEND_RECONCILED",
    ]);
    expect(new Set(events.map((event) => event.requestPlanSha256))).toEqual(
      new Set([expect.stringMatching(/^[a-f0-9]{64}$/)]),
    );
    expect(events[0]).toMatchObject({
      requestBodySha256: createHash("sha256")
        .update(fetchBodies[0]!)
        .digest("hex"),
    });
    expect(events[3]).toMatchObject({
      requestBodySha256: createHash("sha256")
        .update(fetchBodies[1]!)
        .digest("hex"),
    });
    for (const responseEvent of [events[1], events[4]]) {
      expect(responseEvent).toMatchObject({
        responseBytesBase64: expect.any(String),
        responseByteLength: expect.any(Number),
        responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const bytes = Buffer.from(
        String(responseEvent!.responseBytesBase64),
        "base64",
      );
      expect(bytes).toHaveLength(Number(responseEvent!.responseByteLength));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        responseEvent!.responseSha256,
      );
    }
  });

  it("[B3] emits no generation event or call after rejected admission", async () => {
    const order: string[] = [];
    const events: QualificationNetworkEvent[] = [];
    const fetcher = jest.fn(async () => {
      order.push("FETCH_COUNT");
      return response({ totalTokens: 1 });
    });
    const value = new VertexPdfOcrProvider(
      "qa-project-719",
      TOKENS,
      fetcher,
      Object.freeze({ now: () => 1_000 }),
      {
        maxSpendMicros: 0,
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 1_000_000,
      },
    );

    await expect(
      value.extractPdf(
        qualificationRequest((event) => {
          events.push(structuredClone(event));
          order.push(event.kind);
        }),
      ),
    ).rejects.toMatchObject({ failure: "HARD_SPEND_EXCEEDED" });

    expect(order).toEqual([
      "COUNT_TOKENS_REQUEST",
      "FETCH_COUNT",
      "COUNT_TOKENS_RESPONSE",
      "ADMISSION_DECISION",
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      "COUNT_TOKENS_REQUEST",
      "COUNT_TOKENS_RESPONSE",
      "ADMISSION_DECISION",
    ]);
    expect(events[2]).toMatchObject({ decision: "REJECTED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("detects PDF, prompt, model or endpoint drift after count", async () => {
    const observed = await observeExtraction({ totalTokens: 123 }, () => {
      PDF_BYTES[PDF_BYTES.length - 1] = 0x20;
    });

    expect(observed.outcome).toEqual({
      failure: "OCR_REQUEST_PLAN_DRIFT",
      dispatchState: "DISPATCHED_OR_UNKNOWN",
    });
    expect(observed.calls).toHaveLength(2);
    expect(
      observed.calls.filter(({ url }) => /:countTokens$/.test(String(url))),
    ).toHaveLength(1);
    expect(
      observed.calls.filter(({ url }) => /:generateContent$/.test(String(url))),
    ).toHaveLength(1);
  });
});
