import {
  PDF_OCR_USAGE_OUTCOME,
  reconcilePdfOcrBudget,
  reservePdfOcrBudget,
} from "../import-session/ocr/pdf-ocr-budget";
import * as pdfOcrParser from "../import-session/ocr/pdf-ocr-parser";

jest.setTimeout(120_000);

const ARTIFACT_SHA = "a".repeat(64);
const REQUEST_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-14T12:00:00.000Z");
const PDF_OCR_PROVIDER_ID = "GOOGLE_VERTEX_AI";
const PDF_OCR_MODEL_ID = "gemini-2.5-flash";
const PDF_OCR_REGION = "southamerica-east1";

const parseContext = {
  artifactSha256: ARTIFACT_SHA,
  pageCount: 1,
  requestId: REQUEST_ID,
  responseId: "corrected-red-response",
  modelVersion: "gemini-2.5-flash-corrected-red",
  usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  latencyMs: 25,
};

const correctedCandidate = (
  date: Readonly<{
    dateText: string | null;
    normalizedDate: string | null;
    dateExplicitness: "FULL" | "YEARLESS" | "MISSING" | "UNKNOWN";
  }>,
  overrides: Readonly<Record<string, unknown>> = {},
) => ({
  pageNumber: 1,
  pageOccurrenceIndex: 1,
  description: "MERCADO",
  amountCents: "20696",
  sign: "POSITIVE",
  amountMeaning: "LINE_AMOUNT",
  ...date,
  installment: null,
  evidenceText: "13/10/2026 MERCADO 206,96",
  ...overrides,
});

const correctedPayload = (candidate: unknown) => ({
  completionStatus: "COMPLETE",
  reportedPageCount: 1,
  pageAccounting: [
    { pageNumber: 1, status: "READABLE", visibleOccurrenceCount: 1 },
  ],
  candidates: [candidate],
});

function parseCorrectedV3(payload: unknown) {
  const parser = (pdfOcrParser as unknown as Record<string, unknown>)
    .parsePdfOcrV3;
  if (typeof parser !== "function")
    return {
      ok: false as const,
      error: { code: "PDF_OCR_V3_BOUNDARY_NOT_IMPLEMENTED" },
    };
  return (parser as (value: unknown, context: typeof parseContext) => unknown)(
    payload,
    parseContext,
  );
}

describe("corrected OCR date and review-only candidate contract", () => {
  it.each([
    [
      "FULL",
      {
        dateText: "13/10/2026",
        normalizedDate: "2026-10-13",
        dateExplicitness: "FULL",
      },
      "2026-10-13",
    ],
    [
      "YEARLESS",
      {
        dateText: "13/10",
        normalizedDate: null,
        dateExplicitness: "YEARLESS",
      },
      null,
    ],
    [
      "MISSING",
      {
        dateText: null,
        normalizedDate: null,
        dateExplicitness: "MISSING",
      },
      null,
    ],
    [
      "UNKNOWN",
      {
        dateText: null,
        normalizedDate: null,
        dateExplicitness: "UNKNOWN",
      },
      null,
    ],
  ] as const)(
    "accepts the %s triple and projects dateOnly only for FULL",
    (_label, date, expectedDateOnly) => {
      const result = parseCorrectedV3(
        correctedPayload(correctedCandidate(date)),
      );

      expect(result).toMatchObject({
        ok: true,
        value: {
          candidates: [
            {
              ...date,
              dateOnly: expectedDateOnly,
            },
          ],
        },
      });
    },
  );

  it.each([
    {
      dateText: "13/10",
      normalizedDate: "2026-10-13",
      dateExplicitness: "YEARLESS",
    },
    {
      dateText: null,
      normalizedDate: "2026-10-13",
      dateExplicitness: "MISSING",
    },
    {
      dateText: "13/10/2026",
      normalizedDate: null,
      dateExplicitness: "FULL",
    },
    {
      dateText: "13/10/2026",
      normalizedDate: "2026-10-14",
      dateExplicitness: "FULL",
    },
  ] as const)("rejects contradictory date triple %#", (date) => {
    expect(
      parseCorrectedV3(correctedPayload(correctedCandidate(date))),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_DATE" },
    });
  });

  it("retains unknown amount, sign, and date as an unverified review-only candidate", () => {
    const result = parseCorrectedV3(
      correctedPayload(
        correctedCandidate(
          {
            dateText: null,
            normalizedDate: null,
            dateExplicitness: "UNKNOWN",
          },
          {
            amountCents: null,
            sign: "UNKNOWN",
            amountMeaning: "UNKNOWN",
          },
        ),
      ),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        candidates: [
          {
            amountCents: null,
            sign: "UNKNOWN",
            amountMeaning: "UNKNOWN",
            dateText: null,
            normalizedDate: null,
            dateExplicitness: "UNKNOWN",
            dateOnly: null,
            selected: false,
            verificationStatus: "UNVERIFIED",
          },
        ],
      },
    });
  });

  it("positive control rejects an invalid legacy calendar date", () => {
    const legacy = correctedPayload({
      pageNumber: 1,
      pageOccurrenceIndex: 1,
      description: "MERCADO",
      amountCents: "20696",
      amountMeaning: "LINE_AMOUNT",
      date: "2026-02-30",
      installment: null,
      evidenceText: "30/02/2026 MERCADO 206,96",
    });
    expect(parseCorrectedV3(legacy)).toEqual({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });
  });
});

/* Architect-superseded: claim-based 45 evidence and provider-owned spend/count
   tests are replaced by boundary-observer.integration.spec.ts,
   vertex-pdf-ocr.provider.spec.ts and capture-live.spec.ts.
type RawBoundaryObservation = Readonly<{
  identity: string;
  boundary: string;
  raw: Readonly<Record<string, unknown>>;
}>;

function rawProbe(id: string, sourcePath: string): RawBoundaryObservation {
  const scenarios =
    id === "PARTIAL_RESPONSE"
      ? [...SAFETY_PROBE_SCENARIOS.PARTIAL_RESPONSE]
      : id === "MALFORMED_RESPONSE"
        ? [...SAFETY_PROBE_SCENARIOS.MALFORMED_RESPONSE]
        : undefined;
  const evidence: OcrSafetyProbeEvidence = {
    id,
    source: "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED",
    blocked: true,
    explicitError: true,
    errorCode: "BOUNDARY_REJECTED",
    providerCalls: OCR_PROVIDER_CALL_PROBE_IDS.has(id) ? 1 : 0,
    financialWrites: 0,
    durableStateVerified: OCR_DURABLE_PROBE_IDS.has(id),
    finishReasonsTested: [],
    ...(scenarios ? { scenarios } : {}),
    testFile: sourcePath,
  };
  return {
    identity: `[PROBE] ${id}`,
    boundary: "isValidLiveProbe",
    raw: {
      accepted: isValidLiveProbe(evidence),
      providerCalls: evidence.providerCalls,
      financialWrites: evidence.financialWrites,
      durableStateVerified: evidence.durableStateVerified,
      errorCode: evidence.errorCode,
    },
  };
}

async function rawRoute(
  identity: string,
  sourcePath: string,
): Promise<RawBoundaryObservation> {
  const caseId = identity.slice("[ROUTE] ".length);
  const testCase = OCR_SYNTH_ROUTING_CASES.find((item) => item.id === caseId);
  if (!testCase) throw new Error(`missing route fixture ${caseId}`);
  const bytes = await generateArtifact(testCase);
  const settled = await extractPdfDocument(bytes).then(
    (value) => ({
      kind: "RETURNED",
      documentKind: value.documentKind,
      rowCount: value.occurrences.length,
    }),
    (error: unknown) => ({
      kind: "THREW",
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : "NON_ERROR",
    }),
  );
  return {
    identity,
    boundary: sourcePath,
    raw: {
      artifactSha256: artifactSha256(bytes),
      byteLength: bytes.length,
      ...settled,
    },
  };
}

const QUALIFICATION_IDENTITIES = policy.qualificationTests.map(
  ({ name, sourcePath }) => ({ name, sourcePath }),
);

describe("exact 10 ROUTE + 35 PROBE raw boundary observation harness", () => {
  it("positive control owns exactly 45 ordered identities without PASS fields", () => {
    expect(QUALIFICATION_IDENTITIES).toHaveLength(45);
    expect(
      QUALIFICATION_IDENTITIES.filter(({ name }) =>
        name.startsWith("[ROUTE] "),
      ),
    ).toHaveLength(10);
    expect(
      QUALIFICATION_IDENTITIES.filter(({ name }) =>
        name.startsWith("[PROBE] "),
      ),
    ).toHaveLength(35);
    expect(new Set(QUALIFICATION_IDENTITIES.map(({ name }) => name)).size).toBe(
      45,
    );
  });

  it.each(QUALIFICATION_IDENTITIES)(
    "$name records a raw production-boundary observation",
    async ({ name, sourcePath }) => {
      const observation = name.startsWith("[ROUTE] ")
        ? await rawRoute(name, sourcePath)
        : rawProbe(name.slice("[PROBE] ".length), sourcePath);

      expect(observation.identity).toBe(name);
      expect(Object.keys(observation)).toEqual(["identity", "boundary", "raw"]);
      expect(observation).not.toHaveProperty("status");
      expect(observation).not.toHaveProperty("pass");
      expect(observation.raw).not.toHaveProperty("status");
      expect(observation.raw).not.toHaveProperty("pass");
      if (name.startsWith("[ROUTE] "))
        expect(observation.raw).toMatchObject({
          artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          byteLength: expect.any(Number),
          kind: expect.stringMatching(/^(?:RETURNED|THREW)$/),
        });
      else expect(observation.raw.accepted).toBe(true);
    },
  );

  it("rejects oracle/self-test route evidence merely relabeled as real service", async () => {
    const [oracle] = await buildOracleRoutingCases();
    expect(oracle).toBeDefined();
    expect(
      isValidLiveRoute({
        ...oracle,
        source: "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED",
      }),
    ).toBe(false);
  });

  it("rejects oracle/self-test probe evidence merely relabeled as real service", () => {
    const [oracle] = buildOracleSafetyProbes();
    expect(oracle).toBeDefined();
    expect(
      isValidLiveProbe({
        ...oracle,
        source: "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED",
      }),
    ).toBe(false);
  });

  it("rejects a correct identity observed at the wrong production boundary", async () => {
    const [oracle] = await buildOracleRoutingCases();
    expect(
      isValidLiveRoute({
        ...oracle,
        source: "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED",
        testFile:
          "apps/api/src/imports/ocr-synth-v1/direct-pdf-vertex-safety.spec.ts",
      }),
    ).toBe(false);
  });

  it("rejects raw evidence whose bound artifact bytes were altered", async () => {
    const [oracle] = await buildOracleRoutingCases();
    expect(
      isValidLiveRoute({
        ...oracle,
        source: "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED",
        artifactSha256: HASH("altered raw boundary bytes"),
      }),
    ).toBe(false);
  });
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

const providerRequest = () => ({
  artifactSha256: ARTIFACT_SHA,
  pageCount: 1,
  requestId: REQUEST_ID,
  pdfBytes: Buffer.from("%PDF-1.4 corrected-red"),
  signal: new AbortController().signal,
});

const generationResponse = response({
  responseId: "generation-response",
  modelVersion: "gemini-2.5-flash-corrected-red",
  candidates: [
    {
      finishReason: "STOP",
      content: {
        parts: [
          {
            text: JSON.stringify(
              correctedPayload(
                correctedCandidate({
                  dateText: "13/10/2026",
                  normalizedDate: "2026-10-13",
                  dateExplicitness: "FULL",
                }),
              ),
            ),
          },
        ],
      },
    },
  ],
  usageMetadata: {
    promptTokenCount: 24_000,
    candidatesTokenCount: 576,
    totalTokenCount: 24_576,
  },
});

function spendBoundProvider(fetcher: jest.Mock, limitMicros = 500_000) {
  const tokens: VertexAccessTokenPort = {
    authTrace: "LOCAL_ADC",
    accessToken: async () => "fixture-token",
  };
  return Reflect.construct(VertexPdfOcrProvider, [
    "corrected-red-project",
    tokens,
    fetcher,
    { now: () => 1_000 },
    {
      maxSpendMicros: limitMicros,
      inputMicrosPerMillionTokens: 500_000,
      reservedOutputTokens: 576,
    },
  ]) as VertexPdfOcrProvider;
}

function inputBoundProvider(fetcher: jest.Mock) {
  const tokens: VertexAccessTokenPort = {
    authTrace: "LOCAL_ADC",
    accessToken: async () => "fixture-token",
  };
  return Reflect.construct(VertexPdfOcrProvider, [
    "corrected-red-project",
    tokens,
    fetcher,
    { now: () => 1_000 },
    {
      maxInputTokens: 24_576,
      maxOutputTokens: 8_192,
      maxSpendMicros: Number.MAX_SAFE_INTEGER,
      inputMicrosPerMillionTokens: 1,
      outputMicrosPerMillionTokens: 1,
      reservedOutputTokens: 8_192,
    },
  ]) as VertexPdfOcrProvider;
}

describe("pre-dispatch countTokens hard-spend binding", () => {
  it("positive control performs no token or generation call for a pre-aborted request", async () => {
    const fetcher = jest.fn();
    const provider = spendBoundProvider(fetcher);
    const request = providerRequest();
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.extractPdf({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({
      failure: "TIMEOUT",
      dispatchState: "NOT_DISPATCHED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("admits an estimate equal to the hard micro boundary and binds identical bytes", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          totalTokens: 24_576,
          estimatedCostMicros: 500_000,
          requestBindingSha256: HASH(providerRequest().pdfBytes),
        }),
      )
      .mockResolvedValueOnce(generationResponse);
    const provider = spendBoundProvider(fetcher);

    await expect(provider.extractPdf(providerRequest())).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![0]).toMatch(/:countTokens$/);
    expect(fetcher.mock.calls[1]![0]).toMatch(/:generateContent$/);
    const counted = JSON.parse(fetcher.mock.calls[0]![1].body);
    const generated = JSON.parse(fetcher.mock.calls[1]![1].body);
    expect(counted.contents).toEqual(generated.contents);
    expect(HASH(counted.contents[0].parts[1].inlineData.data)).toBe(
      HASH(generated.contents[0].parts[1].inlineData.data),
    );
  });

  it("rejects one micro over before generation", async () => {
    const fetcher = jest.fn().mockResolvedValueOnce(
      response({
        totalTokens: 24_577,
        estimatedCostMicros: 500_001,
        requestBindingSha256: HASH(providerRequest().pdfBytes),
      }),
    );
    const provider = spendBoundProvider(fetcher);

    await expect(provider.extractPdf(providerRequest())).rejects.toMatchObject({
      failure: "HARD_SPEND_EXCEEDED",
      dispatchState: "NOT_DISPATCHED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toMatch(/:countTokens$/);
  });
});

describe("pre-dispatch countTokens input admission", () => {
  it("admits exactly 24576 input tokens before generation", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          totalTokens: 24_576,
          estimatedCostMicros: 1,
          requestBindingSha256: HASH(providerRequest().pdfBytes),
        }),
      )
      .mockResolvedValueOnce(generationResponse);
    const provider = inputBoundProvider(fetcher);

    await expect(provider.extractPdf(providerRequest())).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      expect.stringMatching(/:countTokens$/),
      expect.stringMatching(/:generateContent$/),
    ]);
  });

  it("rejects 24577 input tokens before generation", async () => {
    const fetcher = jest.fn().mockResolvedValueOnce(
      response({
        totalTokens: 24_577,
        estimatedCostMicros: 1,
        requestBindingSha256: HASH(providerRequest().pdfBytes),
      }),
    );
    const provider = inputBoundProvider(fetcher);

    await expect(provider.extractPdf(providerRequest())).rejects.toMatchObject({
      failure: "INPUT_TOKEN_LIMIT_EXCEEDED",
      dispatchState: "NOT_DISPATCHED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toMatch(/:countTokens$/);
  });
});
*/

function reservation(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "10000000-0000-4000-8000-000000000010",
    tenantId: "tenant-a",
    ownerProjectId: "project-a",
    actorId: "actor-a",
    sessionId: "session-a",
    attachmentId: "attachment-a",
    artifactId: "artifact-a",
    artifactSha256: ARTIFACT_SHA,
    requestId: REQUEST_ID,
    pageCount: 1,
    byteCount: 1_000,
    now: NOW,
    ...overrides,
  };
}

const budgetLimits = (costUnits: number) => ({
  calls: { user: 10, tenant: 10, global: 10 },
  pages: { user: 10, tenant: 10, global: 10 },
  bytes: { user: 10_000, tenant: 10_000, global: 10_000 },
  costUnits: {
    user: costUnits,
    tenant: costUnits,
    global: costUnits,
  },
});

function emptyBudgetTx() {
  return {
    importOcrUsage: {
      aggregate: jest.fn(async () => ({
        _sum: {
          reservedCalls: null,
          reservedPages: null,
          reservedBytes: null,
          reservedCostUnits: null,
        },
      })),
      create: jest.fn(async () => undefined),
    },
  };
}

describe("runtime 32768 reserved liability and scope budgets", () => {
  it.each([
    [32_767, false],
    [32_768, true],
    [32_769, true],
  ] as const)(
    "applies the 32768 reservation at cost-unit limit %i",
    async (limit, admitted) => {
      const tx = emptyBudgetTx();
      const operation = reservePdfOcrBudget(
        tx as never,
        reservation(),
        budgetLimits(limit),
      );
      if (admitted) await expect(operation).resolves.toBeUndefined();
      else
        await expect(operation).rejects.toMatchObject({
          code: "OCR_BUDGET_EXHAUSTED",
        });
      expect(tx.importOcrUsage.create).toHaveBeenCalledTimes(admitted ? 1 : 0);
      if (admitted)
        expect(tx.importOcrUsage.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ reservedCostUnits: 32_768 }),
        });
    },
  );

  it("reconciles known usage but retains the full UNKNOWN liability", async () => {
    const updateMany = jest.fn(async (_input: unknown) => ({ count: 1 }));
    const tx = { importOcrUsage: { updateMany } };

    await reconcilePdfOcrBudget(
      tx as never,
      "known",
      PDF_OCR_USAGE_OUTCOME.SUCCEEDED,
      NOW,
      { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      "response-known",
      {
        provider: PDF_OCR_PROVIDER_ID,
        model: PDF_OCR_MODEL_ID,
        modelVersion: "corrected-red",
        region: PDF_OCR_REGION,
        requestId: REQUEST_ID,
        responseId: "response-known",
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        latencyMs: 1,
        requestTrace: {
          authTrace: "LOCAL_ADC",
        },
      } as never,
    );
    await reconcilePdfOcrBudget(
      tx as never,
      "unknown",
      PDF_OCR_USAGE_OUTCOME.UNKNOWN,
      NOW,
      null,
    );

    expect(updateMany.mock.calls[0]![0]).toMatchObject({
      data: { reservedCostUnits: 120, totalTokens: 120 },
    });
    expect(updateMany.mock.calls[1]![0]).toMatchObject({
      data: { reservedCostUnits: 32_768, totalTokens: null },
    });
  });

  it("positive control isolates identical bytes by tenant while retaining a global cap", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const tx = {
      importOcrUsage: {
        aggregate: jest.fn(
          async ({ where }: { where: Record<string, unknown> }) => {
            const matching = rows.filter((row) =>
              Object.entries(where).every(([key, value]) => row[key] === value),
            );
            const sum = (key: string) =>
              matching.reduce((total, row) => total + Number(row[key] ?? 0), 0);
            return {
              _sum: {
                reservedCalls: sum("reservedCalls"),
                reservedPages: sum("reservedPages"),
                reservedBytes: sum("reservedBytes"),
                reservedCostUnits: sum("reservedCostUnits"),
              },
            };
          },
        ),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          rows.push(data);
        }),
      },
    };
    const limits = {
      calls: { user: 1, tenant: 1, global: 2 },
      pages: { user: 10, tenant: 10, global: 20 },
      bytes: { user: 10_000, tenant: 10_000, global: 20_000 },
      costUnits: { user: 100_000, tenant: 100_000, global: 200_000 },
    };

    await reservePdfOcrBudget(tx as never, reservation(), limits);
    await reservePdfOcrBudget(
      tx as never,
      reservation({
        id: "10000000-0000-4000-8000-000000000011",
        tenantId: "tenant-b",
        ownerProjectId: "project-b",
        actorId: "actor-b",
        sessionId: "session-b",
        attachmentId: "attachment-b",
        artifactId: "artifact-b",
        requestId: "10000000-0000-4000-8000-000000000002",
      }),
      limits,
    );
    await expect(
      reservePdfOcrBudget(
        tx as never,
        reservation({
          id: "10000000-0000-4000-8000-000000000012",
          tenantId: "tenant-c",
          ownerProjectId: "project-c",
          actorId: "actor-c",
          sessionId: "session-c",
          attachmentId: "attachment-c",
          artifactId: "artifact-c",
          requestId: "10000000-0000-4000-8000-000000000003",
        }),
        limits,
      ),
    ).rejects.toMatchObject({ code: "OCR_BUDGET_EXHAUSTED" });
    expect(rows.map((row) => row.tenantId)).toEqual(["tenant-a", "tenant-b"]);
    expect(new Set(rows.map((row) => row.artifactSha256))).toEqual(
      new Set([ARTIFACT_SHA]),
    );
  });
});

/* Architect-superseded: local closure/review/env authority is replaced by the
   signed runtime envelope verifier and remains external to backend reviews.
function unsignedClosure() {
  return {
    version: 2,
    policyVersion: policy.policyVersion,
    snapshot: {
      headSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      clean: true,
      policySha256: "1".repeat(64),
      corpusSha256: "2".repeat(64),
      configurationSha256: "3".repeat(64),
      adapterSha256: "4".repeat(64),
      runtimeSha256: "5".repeat(64),
      suiteSha256: "6".repeat(64),
    },
    tests: policy.qualificationTests.map((test) => ({
      ...test,
      status: "PASS",
    })),
  };
}

describe("external qualification authority", () => {
  it("rejects an unsigned, self-hashed perfect 45-row closure", () => {
    expect(isCanonicalQualityClosure(unsignedClosure())).toBe(false);
  });

  it("accepts authority only through an injected verifier fixture", () => {
    const closure = unsignedClosure();
    const signed = {
      ...closure,
      authority: {
        keyId: "test-key-719",
        signature: "fixture-signature",
        evidenceSha256: HASH(JSON.stringify(closure)),
      },
    };
    const verifier = {
      verify: jest.fn(
        (input: { evidenceSha256: string }) =>
          input.evidenceSha256 === signed.authority.evidenceSha256,
      ),
    };
    const verify = isCanonicalQualityClosure as unknown as (
      value: unknown,
      dependencies: { verifier: typeof verifier },
    ) => boolean;

    expect(verify(signed, { verifier })).toBe(true);
    expect(verifier.verify).toHaveBeenCalledTimes(1);
  });

  it("rejects altered and replayed candidate bindings through the verifier", () => {
    const verifier = {
      verify: jest.fn(
        (value: {
          candidateSha: string;
          evidenceSha256: string;
          signature: string;
        }) =>
          value.candidateSha === "a".repeat(40) &&
          value.evidenceSha256 === "e".repeat(64) &&
          value.signature === "valid-fixture-signature",
      ),
    };
    const verify = isCanonicalQualityClosure as unknown as (
      value: unknown,
      dependencies: { verifier: typeof verifier },
    ) => boolean;
    const signed = {
      ...unsignedClosure(),
      authority: {
        keyId: "test-key-719",
        candidateSha: "a".repeat(40),
        evidenceSha256: "e".repeat(64),
        signature: "valid-fixture-signature",
      },
    };

    expect(
      verify(
        {
          ...signed,
          authority: {
            ...signed.authority,
            evidenceSha256: "f".repeat(64),
          },
        },
        { verifier },
      ),
    ).toBe(false);
    expect(
      verify(
        {
          ...signed,
          authority: {
            ...signed.authority,
            candidateSha: "b".repeat(40),
          },
        },
        { verifier },
      ),
    ).toBe(false);
  });
});

describe("review artifacts fail closed before any provider construction", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rf-ocr-reviews-red-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["missing", null],
    ["malformed", "not a signed review artifact"],
    [
      "expired",
      JSON.stringify({
        version: 1,
        validThroughUtc: "2026-10-13",
        decision: "APPROVED",
      }),
    ],
  ] as const)(
    "rejects %s review artifacts before factory/countTokens/generation",
    async (_label, content) => {
      const reviewPath = "reviews/security.json";
      if (content !== null) {
        await mkdir(join(root, "reviews"), { recursive: true });
        await writeFile(join(root, reviewPath), content, { mode: 0o600 });
      }
      const testPolicy = {
        ...policy,
        reviewArtifacts: {
          residualRiskAcceptance: reviewPath,
          securityReview: reviewPath,
          privacyReview: reviewPath,
          dataOwnerReview: reviewPath,
        },
      } as unknown as QualityClosurePolicy;
      const providerFactory = jest.fn();
      const countTokens = jest.fn();
      const generate = jest.fn();

      const qualifyThenDispatch = async () => {
        await readFinalReviewHashes(testPolicy, {
          root,
          now: NOW,
          exec: async (_file, args) => ({
            error: null,
            stdout:
              content !== null && args.includes(reviewPath)
                ? `${reviewPath}\n`
                : "",
            stderr: "",
          }),
        });
        providerFactory();
        countTokens();
        generate();
      };
      const settled = await qualifyThenDispatch().then(
        () => ({ kind: "RESOLVED" as const, error: null }),
        (error: unknown) => ({
          kind: "REJECTED" as const,
          error: error instanceof Error ? error.message : "NON_ERROR",
        }),
      );

      expect({
        settled,
        providerFactoryCalls: providerFactory.mock.calls.length,
        countTokensCalls: countTokens.mock.calls.length,
        generationCalls: generate.mock.calls.length,
      }).toEqual({
        settled: {
          kind: "REJECTED",
          error:
            content === null
              ? "QUALITY_REVIEW_MISSING"
              : "QUALITY_REVIEW_INVALID",
        },
        providerFactoryCalls: 0,
        countTokensCalls: 0,
        generationCalls: 0,
      });
    },
  );

  it("positive control hashes four present review artifacts deterministically", async () => {
    const reviewPath = "reviews/approved.json";
    const content = JSON.stringify({
      version: 1,
      validThroughUtc: "2026-10-21",
      decision: "APPROVED",
      authority: {
        keyId: "fixture-key-719",
        signature: "fixture-signature",
      },
    });
    await mkdir(join(root, "reviews"), { recursive: true });
    await writeFile(join(root, reviewPath), content, { mode: 0o600 });
    const testPolicy = {
      ...policy,
      reviewArtifacts: {
        residualRiskAcceptance: reviewPath,
        securityReview: reviewPath,
        privacyReview: reviewPath,
        dataOwnerReview: reviewPath,
      },
    } as unknown as QualityClosurePolicy;

    await expect(
      readFinalReviewHashes(testPolicy, {
        root,
        now: NOW,
        exec: async () => ({
          error: null,
          stdout: `${reviewPath}\n`,
          stderr: "",
        }),
      }),
    ).resolves.toEqual({
      residualRiskAcceptance: HASH(content),
      securityReview: HASH(content),
      privacyReview: HASH(content),
      dataOwnerReview: HASH(content),
    });
  });
});

describe("OCR activation attestation gate", () => {
  const enabledEnvironment = {
    IMPORT_OCR_ENABLED: "true",
    NODE_ENV: "development",
    VERTEX_AUTH_MODE: "local-adc",
    GOOGLE_CLOUD_PROJECT: "project-719",
  };

  it.each([
    ["missing", undefined],
    ["invalid", "not-an-attestation"],
    [
      "candidate-mismatched",
      JSON.stringify({
        candidateSha: "f".repeat(40),
        evidenceSha256: "e".repeat(64),
        signature: "fixture-signature",
      }),
    ],
  ])(
    "stays OFF for %s attestation and never constructs auth/provider",
    (_label, attestation) => {
      const constructProvider = jest.fn();
      const config = parseVertexAuthConfig({
        ...enabledEnvironment,
        OCR_QUALIFICATION_ATTESTATION: attestation,
        OCR_CANDIDATE_SHA: "a".repeat(40),
      });
      if (config.state !== "OCR_DISABLED") constructProvider(config);

      expect(config).toEqual({ state: "OCR_DISABLED" });
      expect(constructProvider).not.toHaveBeenCalled();
    },
  );

  it("positive control keeps explicit OCR OFF inert", () => {
    const constructProvider = jest.fn();
    const config = parseVertexAuthConfig({
      ...enabledEnvironment,
      IMPORT_OCR_ENABLED: "false",
    });
    if (config.state !== "OCR_DISABLED") constructProvider(config);

    expect(config).toEqual({ state: "OCR_DISABLED" });
    expect(constructProvider).not.toHaveBeenCalled();
  });
});
*/
