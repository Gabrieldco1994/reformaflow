import { PDF_OCR_LIMITS } from "@reformaflow/domain";
import { parsePdfOcrV2 } from "./pdf-ocr-parser";
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
const candidate = (candidateIndex: number, pageNumber = 1) => ({
  candidateIndex,
  pageNumber,
  description: `LINHA ${candidateIndex}`,
  amountCents: String(candidateIndex * 100),
  amountMeaning: "LINE_AMOUNT",
  date: "2026-10-14",
  installment: null,
  evidenceText: `${String(candidateIndex).padStart(2, "0")} LINHA ${candidateIndex}`,
});
const completePage = (
  pageNumber: number,
  candidates: Array<ReturnType<typeof candidate>>,
) => ({
  pageNumber,
  status: candidates.length === 0 ? "EMPTY" : "COMPLETE",
  candidateCount: candidates.length,
  candidates,
});
const complete = (
  pages: Array<ReturnType<typeof completePage>> = [
    completePage(1, [candidate(1)]),
    completePage(2, []),
  ],
) => ({
  outcome: "COMPLETE",
  pageCount: pages.length,
  pages,
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

const request = () => ({
  artifactSha256: ARTIFACT_SHA,
  pageCount: 2,
  requestId: REQUEST_ID,
  pdfBytes: Buffer.from("%PDF-1.4 quality-closure"),
  signal: new AbortController().signal,
});

describe("OCR quality-closure exact accounting contract", () => {
  it("accepts COMPLETE only with exact ordered accounting for every page", () => {
    expect(
      parsePdfOcrV2(
        complete([
          completePage(1, [candidate(1, 1)]),
          completePage(2, [candidate(2, 2)]),
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
            description: "LINHA 1",
            amountCents: "100",
          },
          {
            pageNumber: 2,
            description: "LINHA 2",
            amountCents: "200",
          },
        ],
      },
    });
  });

  it("accepts a legitimate all-EMPTY COMPLETE document with zero candidates", () => {
    expect(
      parsePdfOcrV2(
        complete([completePage(1, []), completePage(2, [])]),
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
      complete([completePage(1, [candidate(1)]), completePage(2, [])]),
      (wire: any) => {
        wire.pages[0].status = "EMPTY";
      },
      "PAGE_ACCOUNTING_MISMATCH",
    ],
    [
      "omitted page",
      complete([completePage(1, [candidate(1)])]),
      () => undefined,
      "PAGE_ACCOUNTING_MISMATCH",
    ],
    [
      "duplicate page",
      complete([completePage(1, []), completePage(1, [])]),
      () => undefined,
      "PAGE_ACCOUNTING_MISMATCH",
    ],
    [
      "decreasing pages",
      complete([completePage(2, []), completePage(1, [])]),
      () => undefined,
      "PAGE_ACCOUNTING_MISMATCH",
    ],
    [
      "page count mismatch",
      complete(),
      (wire: any) => {
        wire.pageCount = 1;
      },
      "PAGE_ACCOUNTING_MISMATCH",
    ],
    [
      "candidate count mismatch",
      complete(),
      (wire: any) => {
        wire.pages[0].candidateCount = 2;
      },
      "PAGE_ACCOUNTING_MISMATCH",
    ],
    [
      "candidate index gap",
      complete([
        completePage(1, [candidate(1), candidate(3)]),
        completePage(2, []),
      ]),
      () => undefined,
      "CANDIDATE_ACCOUNTING_MISMATCH",
    ],
    [
      "candidate index out of order",
      complete([
        completePage(1, [candidate(2), candidate(1)]),
        completePage(2, []),
      ]),
      () => undefined,
      "CANDIDATE_ACCOUNTING_MISMATCH",
    ],
  ])(
    "rejects %s without publishing partial candidates",
    (_label, input, mutate, code) => {
      const wire = structuredClone(input);
      mutate(wire);
      expect(parsePdfOcrV2(wire, context())).toEqual({
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
    const accepted = parsePdfOcrV2(
      complete([completePage(1, dense24), completePage(2, [])]),
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
        `LINHA ${index + 1}`,
        String((index + 1) * 100),
      ]),
    );
    expect(
      parsePdfOcrV2(
        complete([
          completePage(1, [...dense24, candidate(25)]),
          completePage(2, []),
        ]),
        context(),
      ),
    ).toEqual({
      ok: false,
      error: { code: "OVERFLOW" },
    });
  });

  it("rejects an unreadable page as document-level INCOMPLETE", () => {
    expect(
      parsePdfOcrV2(
        {
          outcome: "INCOMPLETE",
          pageCount: 2,
          pages: [
            completePage(1, [candidate(1)]),
            {
              pageNumber: 2,
              status: "UNREADABLE",
              candidateCount: 0,
              candidates: [],
            },
          ],
        },
        context(),
      ),
    ).toEqual({
      ok: false,
      error: { code: "INCOMPLETE" },
    });
  });
});

describe("OCR quality-closure Vertex wire contract", () => {
  it("pins the exact accounting schema, prompt, and 8192-token bound", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValue(
        responseFromRaw(JSON.stringify(vertexWire(JSON.stringify(complete())))),
      );
    const provider = new VertexPdfOcrProvider(
      "quality-closure-project",
      { authTrace: "LOCAL_ADC", accessToken: async () => "token" },
      fetcher,
    );

    const settled = await provider
      .extractPdf(request())
      .catch((error) => error);
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    const schema = body.generationConfig.responseSchema;
    expect(body.generationConfig.maxOutputTokens).toBe(8192);
    expect(schema).toEqual({
      type: "OBJECT",
      additionalProperties: false,
      required: ["outcome", "pageCount", "pages"],
      properties: {
        outcome: {
          type: "STRING",
          enum: ["COMPLETE", "INCOMPLETE"],
        },
        pageCount: {
          type: "INTEGER",
          minimum: 1,
          maximum: 10,
        },
        pages: {
          type: "ARRAY",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "OBJECT",
            additionalProperties: false,
            required: ["pageNumber", "status", "candidateCount", "candidates"],
            properties: {
              pageNumber: {
                type: "INTEGER",
                minimum: 1,
                maximum: 10,
              },
              status: {
                type: "STRING",
                enum: ["COMPLETE", "EMPTY", "UNREADABLE"],
              },
              candidateCount: {
                type: "INTEGER",
                minimum: 0,
                maximum: 24,
              },
              candidates: {
                type: "ARRAY",
                minItems: 0,
                maxItems: 24,
                items: {
                  type: "OBJECT",
                  additionalProperties: false,
                  required: [
                    "candidateIndex",
                    "pageNumber",
                    "description",
                    "amountCents",
                    "amountMeaning",
                    "date",
                    "installment",
                    "evidenceText",
                  ],
                  properties: {
                    candidateIndex: {
                      type: "INTEGER",
                      minimum: 1,
                      maximum: 24,
                    },
                    pageNumber: {
                      type: "INTEGER",
                      minimum: 1,
                      maximum: 10,
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
                    date: {
                      type: "STRING",
                      nullable: true,
                      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
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
          },
        },
      },
    });
    const prompt = body.contents[0].parts[0].text;
    for (const term of [
      "COMPLETE",
      "INCOMPLETE",
      "EMPTY",
      "UNREADABLE",
      "candidateIndex",
      "candidateCount",
    ])
      expect(prompt).toContain(term);
    expect(settled).not.toBeInstanceOf(Error);
  });

  it.each(["outer", "embedded"] as const)(
    "rejects duplicate JSON keys in the %s envelope",
    async (target) => {
      const legacyPayload =
        '{"candidates":[{"pageNumber":1,"description":"LOJA","amountCents":"100","amountMeaning":"LINE_AMOUNT","date":"2026-10-14","installment":null,"evidenceText":"LOJA 1,00"}]}';
      const embedded =
        target === "embedded"
          ? '{"candidates":[{"pageNumber":1,"description":"LOJA","description":"LOJA","amountCents":"100","amountMeaning":"LINE_AMOUNT","date":"2026-10-14","installment":null,"evidenceText":"LOJA 1,00"}]}'
          : legacyPayload;
      const wire = JSON.stringify(vertexWire(embedded));
      const raw =
        target === "outer"
          ? wire.replace(
              '"responseId":"vertex-quality-closure-719",',
              '"responseId":"vertex-quality-closure-719","responseId":"vertex-quality-closure-719",',
            )
          : wire;
      const provider = new VertexPdfOcrProvider(
        "quality-closure-project",
        { authTrace: "LOCAL_ADC", accessToken: async () => "token" },
        jest.fn().mockResolvedValue(responseFromRaw(raw)),
      );

      await expect(provider.extractPdf(request())).rejects.toMatchObject({
        failure: "MALFORMED_RESPONSE",
        dispatchState: "DISPATCHED_OR_UNKNOWN",
      });
    },
  );
});
