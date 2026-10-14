import { PDF_OCR_LIMITS } from "@reformaflow/domain";
import { parsePdfOcrV3 } from "./pdf-ocr-parser";
import { VertexPdfOcrProvider } from "./vertex-pdf-ocr.provider";

const ARTIFACT_SHA = "a".repeat(64);
const REQUEST_ID = "10000000-0000-4000-8000-000000000001";
const context = (pageCount = 2) => ({
  artifactSha256: ARTIFACT_SHA,
  pageCount,
  requestId: REQUEST_ID,
  responseId: "vertex-quality-closure-719",
  modelVersion: "gemini-2.5-flash-quality-closure",
  usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  latencyMs: 25,
});
const candidate = (pageOccurrenceIndex: number, pageNumber = 1) => ({
  pageOccurrenceIndex,
  pageNumber,
  description: `LINHA ${pageNumber}-${pageOccurrenceIndex}`,
  amountCents: String((pageNumber * 10 + pageOccurrenceIndex) * 100),
  sign: "POSITIVE",
  amountMeaning: "LINE_AMOUNT",
  dateText: "14/10/2026",
  normalizedDate: "2026-10-14",
  dateExplicitness: "FULL",
  installment: null,
  evidenceText: `${pageNumber}.${pageOccurrenceIndex} LINHA`,
});
const accountedPage = (
  pageNumber: number,
  candidates: Array<ReturnType<typeof candidate>>,
) => ({
  pageNumber,
  status: candidates.length === 0 ? "EMPTY" : "READABLE",
  visibleOccurrenceCount: candidates.length,
});
const complete = (
  candidates: Array<ReturnType<typeof candidate>> = [candidate(1)],
  pageAccounting: Array<ReturnType<typeof accountedPage>> = [
    accountedPage(
      1,
      candidates.filter((item) => item.pageNumber === 1),
    ),
    accountedPage(
      2,
      candidates.filter((item) => item.pageNumber === 2),
    ),
  ],
) => ({
  completionStatus: "COMPLETE",
  reportedPageCount: 2,
  pageAccounting,
  candidates,
});

function vertexWire(embedded: string) {
  return {
    responseId: "vertex-quality-closure-719",
    modelVersion: "gemini-2.5-flash-quality-closure",
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: embedded }] },
      },
    ],
    usageMetadata: {
      promptTokenCount: 20,
      candidatesTokenCount: 10,
      totalTokenCount: 30,
    },
  };
}

function responseFromRaw(raw: string) {
  const bytes = Buffer.from(raw);
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

function fetchGeneration(raw: string) {
  return jest
    .fn()
    .mockResolvedValueOnce(responseFromRaw(JSON.stringify({ totalTokens: 20 })))
    .mockResolvedValueOnce(responseFromRaw(raw));
}

const request = () => ({
  artifactSha256: ARTIFACT_SHA,
  pageCount: 2,
  requestId: REQUEST_ID,
  pdfBytes: Buffer.from("%PDF-1.4 quality-closure"),
  signal: new AbortController().signal,
});

describe("OCR quality-closure exact accounting contract", () => {
  it("accepts COMPLETE only with exact ordered accounting for every page", () => {
    const candidates = [candidate(1, 1), candidate(1, 2)];
    expect(
      parsePdfOcrV3(
        complete(candidates, [
          accountedPage(1, [candidates[0]!]),
          accountedPage(2, [candidates[1]!]),
        ]),
        context(),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        pageCount: 2,
        candidates: [
          {
            pageNumber: 1,
            description: "LINHA 1-1",
            amountCents: "1100",
            sign: "POSITIVE",
            dateText: "14/10/2026",
            normalizedDate: "2026-10-14",
            dateExplicitness: "FULL",
          },
          {
            pageNumber: 2,
            description: "LINHA 2-1",
            amountCents: "2100",
            sign: "POSITIVE",
            dateText: "14/10/2026",
            normalizedDate: "2026-10-14",
            dateExplicitness: "FULL",
          },
        ],
      },
    });
  });

  it("accepts a legitimate all-EMPTY COMPLETE document with zero candidates", () => {
    expect(
      parsePdfOcrV3(
        complete([], [accountedPage(1, []), accountedPage(2, [])]),
        context(),
      ),
    ).toMatchObject({
      ok: true,
      value: { pageCount: 2, candidates: [] },
    });
  });

  it.each([
    [
      "empty deception",
      complete(),
      (wire: any) => {
        wire.pageAccounting[0].status = "EMPTY";
      },
      "PAGE_ACCOUNTING_MISMATCH",
    ],
    [
      "omitted page",
      complete([candidate(1)], [accountedPage(1, [candidate(1)])]),
      () => undefined,
      "INVALID_PAYLOAD",
    ],
    [
      "duplicate page",
      complete([], [accountedPage(1, []), accountedPage(1, [])]),
      () => undefined,
      "PAGE_ACCOUNTING_MISMATCH",
    ],
    [
      "decreasing pages",
      complete([], [accountedPage(2, []), accountedPage(1, [])]),
      () => undefined,
      "PAGE_ACCOUNTING_MISMATCH",
    ],
    [
      "reported page count mismatch",
      complete(),
      (wire: any) => {
        wire.reportedPageCount = 1;
      },
      "INVALID_PAYLOAD",
    ],
    [
      "visible occurrence count mismatch",
      complete(),
      (wire: any) => {
        wire.pageAccounting[0].visibleOccurrenceCount = 2;
      },
      "PAGE_ACCOUNTING_MISMATCH",
    ],
    [
      "page occurrence index gap",
      complete(
        [candidate(1), candidate(3)],
        [accountedPage(1, [candidate(1), candidate(3)]), accountedPage(2, [])],
      ),
      () => undefined,
      "CANDIDATE_ACCOUNTING_MISMATCH",
    ],
    [
      "page occurrence index out of order",
      complete(
        [candidate(2), candidate(1)],
        [accountedPage(1, [candidate(2), candidate(1)]), accountedPage(2, [])],
      ),
      () => undefined,
      "CANDIDATE_ACCOUNTING_MISMATCH",
    ],
  ])(
    "rejects %s without publishing partial candidates",
    (_label, input, mutate, code) => {
      const wire = structuredClone(input);
      mutate(wire);
      expect(parsePdfOcrV3(wire, context())).toEqual({
        ok: false,
        error: { code },
      });
    },
  );

  it("accepts dense 24 and rejects 25 as one typed terminal overflow", () => {
    expect(PDF_OCR_LIMITS.candidatesPerFile).toBe(24);
    const dense24 = Array.from({ length: 24 }, (_, index) =>
      candidate(index + 1),
    );
    const accepted = parsePdfOcrV3(
      complete(dense24, [accountedPage(1, dense24), accountedPage(2, [])]),
      context(),
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("dense24 must be accepted");
    expect(accepted.value.candidates).toHaveLength(24);
    expect(
      accepted.value.candidates.map((item) => [
        item.pageNumber,
        item.description,
        item.amountCents,
      ]),
    ).toEqual(
      Array.from({ length: 24 }, (_, index) => [
        1,
        `LINHA 1-${index + 1}`,
        String((index + 11) * 100),
      ]),
    );
    expect(
      parsePdfOcrV3(
        {
          completionStatus: "OCCURRENCE_LIMIT_EXCEEDED",
          reportedPageCount: 2,
          pageAccounting: [
            {
              pageNumber: 1,
              status: "READABLE",
              visibleOccurrenceCount: 25,
            },
            accountedPage(2, []),
          ],
          candidates: [],
        },
        context(),
      ),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "LIMIT_EXCEEDED" }),
    });
  });

  it("rejects an unreadable page as document-level INCOMPLETE", () => {
    const result = parsePdfOcrV3(
      {
        completionStatus: "INCOMPLETE",
        reportedPageCount: 2,
        pageAccounting: [
          accountedPage(1, []),
          {
            pageNumber: 2,
            status: "UNREADABLE",
            visibleOccurrenceCount: 0,
          },
        ],
        candidates: [],
      },
      context(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "DOCUMENT_UNREADABLE" },
    });
    expect(Reflect.ownKeys(result)).toEqual(["ok", "error"]);
  });
});

describe("OCR quality-closure Vertex wire contract", () => {
  it("pins the exact accounting schema, prompt, and 8192-token bound", async () => {
    const fetcher = fetchGeneration(
      JSON.stringify(vertexWire(JSON.stringify(complete()))),
    );
    const provider = new VertexPdfOcrProvider(
      "quality-closure-project",
      { authTrace: "LOCAL_ADC", accessToken: async () => "token" },
      fetcher,
    );

    const settled = await provider
      .extractPdf(request())
      .catch((error) => error);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      expect.stringMatching(/:countTokens$/),
      expect.stringMatching(/:generateContent$/),
    ]);
    const body = JSON.parse(fetcher.mock.calls[1]![1].body);
    const schema = body.generationConfig.responseSchema;
    expect(body.generationConfig.maxOutputTokens).toBe(8192);
    expect(schema).toEqual({
      type: "OBJECT",
      additionalProperties: false,
      required: [
        "completionStatus",
        "reportedPageCount",
        "pageAccounting",
        "candidates",
      ],
      properties: {
        completionStatus: {
          type: "STRING",
          enum: ["COMPLETE", "OCCURRENCE_LIMIT_EXCEEDED", "INCOMPLETE"],
        },
        reportedPageCount: {
          type: "INTEGER",
          minimum: 1,
          maximum: 10,
        },
        pageAccounting: {
          type: "ARRAY",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "OBJECT",
            additionalProperties: false,
            required: ["pageNumber", "status", "visibleOccurrenceCount"],
            properties: {
              pageNumber: {
                type: "INTEGER",
                minimum: 1,
                maximum: 10,
              },
              status: {
                type: "STRING",
                enum: ["READABLE", "EMPTY", "UNREADABLE"],
              },
              visibleOccurrenceCount: {
                type: "INTEGER",
                minimum: 0,
                maximum: 2147483647,
              },
            },
          },
        },
        candidates: {
          type: "ARRAY",
          minItems: 0,
          maxItems: 24,
          items: {
            type: "OBJECT",
            additionalProperties: false,
            required: [
              "pageNumber",
              "pageOccurrenceIndex",
              "description",
              "amountCents",
              "amountMeaning",
              "sign",
              "dateText",
              "normalizedDate",
              "dateExplicitness",
              "installment",
              "evidenceText",
            ],
            properties: {
              pageNumber: {
                type: "INTEGER",
                minimum: 1,
                maximum: 10,
              },
              pageOccurrenceIndex: {
                type: "INTEGER",
                minimum: 1,
                maximum: 24,
              },
              description: {
                type: "STRING",
                nullable: true,
                minLength: 1,
                maxLength: 1000,
              },
              amountCents: {
                type: "STRING",
                nullable: true,
                pattern: "^(?:0|-?[1-9][0-9]*)$",
              },
              amountMeaning: {
                type: "STRING",
                enum: ["LINE_AMOUNT", "UNKNOWN"],
              },
              sign: {
                type: "STRING",
                enum: ["NEGATIVE", "ZERO", "POSITIVE", "UNKNOWN"],
              },
              dateText: {
                type: "STRING",
                nullable: true,
                minLength: 1,
                maxLength: 10,
              },
              normalizedDate: {
                type: "STRING",
                nullable: true,
                pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
              },
              dateExplicitness: {
                type: "STRING",
                enum: ["FULL", "YEARLESS", "MISSING", "UNKNOWN"],
              },
              installment: {
                anyOf: [
                  { type: "NULL" },
                  {
                    type: "OBJECT",
                    additionalProperties: false,
                    required: ["index", "total"],
                    properties: {
                      index: { type: "INTEGER", minimum: 1 },
                      total: {
                        type: "INTEGER",
                        minimum: 1,
                        maximum: 24,
                      },
                    },
                  },
                ],
              },
              evidenceText: {
                type: "STRING",
                minLength: 1,
                maxLength: 1000,
              },
            },
          },
        },
      },
    });
    const prompt = body.contents[0].parts[0].text;
    for (const term of [
      "COMPLETE",
      "INCOMPLETE",
      "OCCURRENCE_LIMIT_EXCEEDED",
      "READABLE",
      "EMPTY",
      "UNREADABLE",
      "pageOccurrenceIndex",
      "visibleOccurrenceCount",
    ])
      expect(prompt).toContain(term);
    expect(settled).not.toBeInstanceOf(Error);
  });

  it("maps structural accounting divergence to MALFORMED_RESPONSE", async () => {
    const validPayload = complete();
    const baselineFetcher = fetchGeneration(
      JSON.stringify(vertexWire(JSON.stringify(validPayload))),
    );
    const baselineProvider = new VertexPdfOcrProvider(
      "quality-closure-project",
      { authTrace: "LOCAL_ADC", accessToken: async () => "token" },
      baselineFetcher,
    );
    await expect(baselineProvider.extractPdf(request())).resolves.toEqual(
      expect.objectContaining({ pageCount: 2 }),
    );
    expect(baselineFetcher).toHaveBeenCalledTimes(2);

    const divergent = structuredClone(validPayload);
    divergent.pageAccounting[0]!.visibleOccurrenceCount = 2;
    const fetcher = fetchGeneration(
      JSON.stringify(vertexWire(JSON.stringify(divergent))),
    );
    const provider = new VertexPdfOcrProvider(
      "quality-closure-project",
      { authTrace: "LOCAL_ADC", accessToken: async () => "token" },
      fetcher,
    );
    await expect(provider.extractPdf(request())).rejects.toMatchObject({
      failure: "MALFORMED_RESPONSE",
      dispatchState: "DISPATCHED_OR_UNKNOWN",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["outer", "embedded"] as const)(
    "rejects duplicate JSON keys in the %s envelope",
    async (target) => {
      const canonicalPayload = JSON.stringify(complete());
      const baselineFetcher = fetchGeneration(
        JSON.stringify(vertexWire(canonicalPayload)),
      );
      const baselineProvider = new VertexPdfOcrProvider(
        "quality-closure-project",
        { authTrace: "LOCAL_ADC", accessToken: async () => "token" },
        baselineFetcher,
      );
      await expect(baselineProvider.extractPdf(request())).resolves.toEqual(
        expect.objectContaining({ pageCount: 2 }),
      );
      expect(baselineFetcher).toHaveBeenCalledTimes(2);
      const embedded =
        target === "embedded"
          ? canonicalPayload.replace(
              '"description":"LINHA 1-1",',
              '"description":"LINHA 1-1","description":"LINHA 1-1",',
            )
          : canonicalPayload;
      const wire = JSON.stringify(vertexWire(embedded));
      const raw =
        target === "outer"
          ? wire.replace(
              '"responseId":"vertex-quality-closure-719",',
              '"responseId":"vertex-quality-closure-719","responseId":"vertex-quality-closure-719",',
            )
          : wire;
      const fetcher = fetchGeneration(raw);
      const provider = new VertexPdfOcrProvider(
        "quality-closure-project",
        { authTrace: "LOCAL_ADC", accessToken: async () => "token" },
        fetcher,
      );

      await expect(provider.extractPdf(request())).rejects.toMatchObject({
        failure: "MALFORMED_RESPONSE",
        dispatchState: "DISPATCHED_OR_UNKNOWN",
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
});
