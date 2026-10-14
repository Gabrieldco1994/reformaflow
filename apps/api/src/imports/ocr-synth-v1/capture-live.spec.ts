import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { PDF_OCR_MODEL_ID, PDF_OCR_PROVIDER_ID } from "@reformaflow/domain";
import * as ts from "typescript";
import { VertexPdfOcrProvider } from "../import-session/ocr/vertex-pdf-ocr.provider";
import { captureLiveEvidence } from "./capture-live-core";
import * as captureLiveCore from "./capture-live-core";
import { writeLiveEvidenceExclusive } from "./capture-live-file";
import {
  getOcrSynthCase,
  OCR_SYNTH_ROUTING_CASES,
  OCR_SYNTH_SCANNED_RELEASE_CASES,
  successfulRows,
} from "./corpus";
import { evaluateOcrSynth, type OcrEvalInput } from "./evaluator";
import {
  parseLiveEvidence,
  parseLiveEvidenceJson,
} from "./live-evidence-parser";
import policy from "./quality-closure-policy.json";

jest.setTimeout(120_000);

const SHA = "c".repeat(40);
const VERSION = "gemini-2.5-flash-001";

function response(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name === "content-type"
          ? "application/json"
          : name === "content-length"
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

function provider(
  versions: readonly string[] = [VERSION],
  responseIds?: readonly string[],
  terminalOutcomes: Readonly<
    Record<string, "DOCUMENT_UNREADABLE" | "LIMIT_EXCEEDED">
  > = {},
) {
  let index = 0;
  const fetcher = jest.fn(async (url: string) => {
    if (url.endsWith(":countTokens")) return response({ totalTokens: 20 });
    const testCase = OCR_SYNTH_SCANNED_RELEASE_CASES[index]!;
    const rows = successfulRows(testCase);
    const current = index++;
    const terminalOutcome = terminalOutcomes[testCase.id];
    const pageOccurrenceCounts = new Map<number, number>();
    const candidates = rows.map((row) => {
      const pageOccurrenceIndex = (pageOccurrenceCounts.get(row.page) ?? 0) + 1;
      pageOccurrenceCounts.set(row.page, pageOccurrenceIndex);
      return {
        pageNumber: row.page,
        pageOccurrenceIndex,
        description: row.description,
        amountCents: row.amountCents,
        sign: row.sign,
        amountMeaning: row.amountMeaning,
        dateText: row.dateText,
        normalizedDate:
          row.dateExplicitness === "FULL" ? row.normalizedDate : null,
        dateExplicitness: row.dateExplicitness,
        installment:
          row.installmentCurrent !== null && row.installmentTotal !== null
            ? {
                index: row.installmentCurrent,
                total: row.installmentTotal,
              }
            : null,
        evidenceText: row.evidenceText,
      };
    });
    const payload =
      terminalOutcome === undefined
        ? {
            completionStatus: "COMPLETE",
            reportedPageCount: testCase.artifact.pageCount,
            pageAccounting: Array.from(
              { length: testCase.artifact.pageCount },
              (_, pageIndex) => {
                const visibleOccurrenceCount =
                  pageOccurrenceCounts.get(pageIndex + 1) ?? 0;
                return {
                  pageNumber: pageIndex + 1,
                  status: visibleOccurrenceCount === 0 ? "EMPTY" : "READABLE",
                  visibleOccurrenceCount,
                };
              },
            ),
            candidates,
          }
        : {
            completionStatus:
              terminalOutcome === "DOCUMENT_UNREADABLE"
                ? "INCOMPLETE"
                : "OCCURRENCE_LIMIT_EXCEEDED",
            reportedPageCount: testCase.artifact.pageCount,
            pageAccounting: Array.from(
              { length: testCase.artifact.pageCount },
              (_, pageIndex) => ({
                pageNumber: pageIndex + 1,
                status:
                  terminalOutcome === "DOCUMENT_UNREADABLE" && pageIndex === 1
                    ? "UNREADABLE"
                    : terminalOutcome === "LIMIT_EXCEEDED" && pageIndex === 0
                      ? "READABLE"
                      : "EMPTY",
                visibleOccurrenceCount:
                  terminalOutcome === "LIMIT_EXCEEDED" && pageIndex === 0
                    ? 25
                    : 0,
              }),
            ),
            candidates: [],
          };
    return response({
      responseId: responseIds?.[current] ?? `response-${testCase.id}`,
      modelVersion: versions[current] ?? versions[0],
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              {
                text: JSON.stringify(payload),
              },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 10,
        totalTokenCount: 30,
      },
    });
  });
  const value = new VertexPdfOcrProvider(
    "synthetic-eval-project",
    {
      authTrace: "SERVICE_ACCOUNT_FILE_ADC",
      accessToken: async () => "test-only-adc-token",
    },
    fetcher,
  );
  const executeFullV3Attempt = value.extractPdf.bind(value);
  value.extractPdf = ((request) => {
    // Qualification-mode selection is mutation-locked independently in
    // vertex-pdf-ocr.provider.spec.ts. This fixture always exercises the
    // complete countTokens + generateContent strict-V3 provider phase.
    const { qualificationCapture: _qualificationCapture, ...providerRequest } =
      request;
    return executeFullV3Attempt(providerRequest);
  }) as typeof value.extractPdf;
  return {
    fetcher,
    value,
  };
}

type CaptureOptions = Parameters<typeof captureLiveEvidence>[0];

function canonicalQualityClosure() {
  const canonicalPolicy = policy as unknown as {
    policyVersion: string;
    qualificationTests: Array<{ name: string; sourcePath: string }>;
  };
  return {
    version: 2,
    policyVersion: canonicalPolicy.policyVersion,
    snapshot: {
      headSha: SHA,
      treeSha: SHA,
      clean: true,
      policySha256: "d".repeat(64),
      corpusSha256: "a".repeat(64),
      configurationSha256: "a".repeat(64),
      adapterSha256: "b".repeat(64),
      runtimeSha256: "b".repeat(64),
      suiteSha256: "f".repeat(64),
    },
    tests: canonicalPolicy.qualificationTests.map((item) => ({
      ...item,
      status: "PASS",
    })),
  };
}

function canonicalCaptureOptions(
  value: VertexPdfOcrProvider,
  overrides: Record<string, unknown> = {},
): CaptureOptions {
  return {
    provider: value,
    mechanical: {
      policy,
      qualityClosure: canonicalQualityClosure(),
      finalReviewHashes: {
        residualRiskAcceptance: "e".repeat(64),
        securityReview: "1".repeat(64),
        privacyReview: "2".repeat(64),
        dataOwnerReview: "3".repeat(64),
      },
      verifySnapshot: jest.fn(async () => undefined),
    },
    readProcSelfStatus: async () => "Name:\tnode\nVmHWM:\t100 kB\n",
    ...overrides,
  } as unknown as CaptureOptions;
}

type CaptureSpendAdmission = (
  input: Readonly<{
    spentKnownMicros: number;
    countedInputTokens: number;
    reservedOutputTokens: 8192;
    inputMicrosPerMillionTokens: number;
    outputMicrosPerMillionTokens: number;
    limitMicros: 500000;
  }>,
  generation: () => Promise<void>,
) => Promise<Readonly<{ status: "ADMITTED" | "CAPTURE_SPEND_LIMIT" }>>;

async function observeCaptureSpend(
  spentKnownMicros: number,
  nextWorstCaseMicros: number,
) {
  const admission = (captureLiveCore as unknown as Record<string, unknown>)
    .admitCaptureGeneration as CaptureSpendAdmission | undefined;
  const generation = jest.fn(async () => undefined);
  if (!admission)
    return {
      status: "CAPTURE_SPEND_GUARD_NOT_IMPLEMENTED" as const,
      generationCalls: generation.mock.calls.length,
    };
  const countedInputTokens = Math.max(0, nextWorstCaseMicros - 8192);
  const result = await admission(
    {
      spentKnownMicros,
      countedInputTokens,
      reservedOutputTokens: 8192,
      inputMicrosPerMillionTokens: 1_000_000,
      outputMicrosPerMillionTokens: 1_000_000,
      limitMicros: 500_000,
    },
    generation,
  );
  return {
    status: result.status,
    generationCalls: generation.mock.calls.length,
  };
}

describe("cumulative capture hard spend", () => {
  it.each([
    [0, 500_000, "ADMITTED", 1],
    [100_000, 400_000, "ADMITTED", 1],
    [100_000, 400_001, "CAPTURE_SPEND_LIMIT", 0],
  ] as const)(
    "admits generation only when cumulative worst case %i + %i remains within 500000 micros",
    async (spent, nextWorstCase, status, generationCalls) => {
      expect(await observeCaptureSpend(spent, nextWorstCase)).toEqual({
        status,
        generationCalls,
      });
    },
  );

  it("keeps a spend stop as GAPS rather than release PASS", async () => {
    const observation = await observeCaptureSpend(499_999, 2);

    expect(observation).toEqual({
      status: "CAPTURE_SPEND_LIMIT",
      generationCalls: 0,
    });
    expect(observation.status).not.toBe("PASS");
  });
});

describe("audited synthetic Vertex capture", () => {
  let evidence: Awaited<ReturnType<typeof captureLiveEvidence>>;
  let terminalEvidence: Awaited<ReturnType<typeof captureLiveEvidence>>;
  let dispatchedRequestIds: string[];
  let captureFetcher: jest.Mock;
  let platform: PropertyDescriptor;

  beforeAll(async () => {
    platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", {
      ...platform,
      value: "linux",
    });

    const adapter = provider();
    captureFetcher = adapter.fetcher;
    const extract = jest.spyOn(adapter.value, "extractPdf");
    evidence = await captureLiveEvidence(
      canonicalCaptureOptions(adapter.value, { memoryRss: () => 100 }),
    );
    const terminalAdapter = provider([VERSION], undefined, {
      "scan-012": "DOCUMENT_UNREADABLE",
      "scan-018": "LIMIT_EXCEEDED",
    });
    terminalEvidence = await captureLiveEvidence(
      canonicalCaptureOptions(terminalAdapter.value, {
        memoryRss: () => 100,
      }),
    );
    dispatchedRequestIds = extract.mock.calls.map(
      ([request]) => request.requestId,
    );
    expect(extract).toHaveBeenCalledTimes(18);
  });
  afterAll(() => Object.defineProperty(process, "platform", platform));

  it("calls the real adapter once for each literal scanned case only", () => {
    expect(captureFetcher).toHaveBeenCalledTimes(36);
    expect(evidence.predictions.map((item) => item.caseId)).toEqual(
      OCR_SYNTH_SCANNED_RELEASE_CASES.map((item) => item.id),
    );
    expect(evidence).not.toHaveProperty("routingCases");
    expect(evidence).not.toHaveProperty("safetyProbes");
    const dense = evidence.predictions.find(
      (item) => item.caseId === "scan-010",
    )!;
    expect(
      dense.outcome.kind === "SUCCESS" && "candidates" in dense.outcome
        ? dense.outcome.candidates
        : [],
    ).toHaveLength(24);
  });

  it("[B3] records one countTokens plus one generateContent call for every admitted case", async () => {
    const adapter = provider([VERSION], undefined, {
      "scan-012": "DOCUMENT_UNREADABLE",
      "scan-018": "LIMIT_EXCEEDED",
    });
    const captured = await captureLiveEvidence(
      canonicalCaptureOptions(adapter.value, {
        memoryRss: () => 256_000_000,
      }),
    );

    expect(captured.predictions).toHaveLength(18);
    expect(captured.predictions.map((item) => item.caseId)).toEqual(
      OCR_SYNTH_SCANNED_RELEASE_CASES.map((item) => item.id),
    );
    expect(
      captured.predictions.find((item) => item.caseId === "scan-012")!.outcome,
    ).toEqual({
      kind: "ERROR",
      errorCode: "DOCUMENT_UNREADABLE",
      retryable: false,
    });
    expect(
      captured.predictions.find((item) => item.caseId === "scan-018")!.outcome,
    ).toEqual({
      kind: "ERROR",
      errorCode: "LIMIT_EXCEEDED",
      retryable: false,
    });
    expect(adapter.fetcher).toHaveBeenCalledTimes(36);
    expect(
      captured.predictions.map((item) => item.adapterTrace?.providerCallCount),
    ).toEqual(Array.from({ length: 18 }, () => 2));
    expect(
      captured.predictions.map((item) => item.adapterTrace?.attempts),
    ).toEqual(Array.from({ length: 18 }, () => 1));
  });

  it("accepts exact provider-native terminal mappings and binds their raw response bytes", () => {
    expect(
      terminalEvidence.predictions.find((item) => item.caseId === "scan-012")!
        .outcome,
    ).toEqual({
      kind: "ERROR",
      errorCode: "DOCUMENT_UNREADABLE",
      retryable: false,
    });
    expect(
      terminalEvidence.predictions.find((item) => item.caseId === "scan-018")!
        .outcome,
    ).toEqual({
      kind: "ERROR",
      errorCode: "LIMIT_EXCEEDED",
      retryable: false,
    });
    expect(() =>
      parseLiveEvidenceJson(JSON.stringify(terminalEvidence)),
    ).not.toThrow();
  });

  it("[B3] capture output is directly consumable by the live parser and evaluator", async () => {
    const adapter = provider();
    const captured = (await captureLiveEvidence(
      canonicalCaptureOptions(adapter.value, {
        memoryRss: () => 256_000_000,
      }),
    )) as unknown as Record<string, any>;
    const serialized = JSON.stringify(captured);
    const parsed = parseLiveEvidenceJson(serialized) as unknown as Record<
      string,
      any
    >;
    const report = await evaluateOcrSynth(parsed as unknown as OcrEvalInput);

    expect(parsed).toEqual(captured);
    expect(captured).not.toHaveProperty("rawResponses");
    expect(captured).not.toHaveProperty("routingCases");
    expect(captured).not.toHaveProperty("safetyProbes");
    expect(captured.predictions).toHaveLength(18);
    expect(captured.attemptLedger).toHaveLength(18);
    expect(captured.attemptLedger.map((item: any) => item.caseId)).toEqual(
      OCR_SYNTH_SCANNED_RELEASE_CASES.map(({ id }) => id),
    );
    for (const item of captured.attemptLedger)
      expect(item.events.map((event: any) => event.kind)).toEqual([
        "COUNT_TOKENS_REQUEST",
        "COUNT_TOKENS_RESPONSE",
        "ADMISSION_DECISION",
        "GENERATION_REQUEST",
        "GENERATION_RESPONSE",
        "SPEND_RECONCILED",
      ]);
    expect(captured.qualityClosure.observations).toHaveLength(45);
    expect(report.functionalStatus).toBe("PASS");
    expect(report.releaseStatus).toBe("GAPS");
    expect(report.liveEvidenceGaps).toEqual([
      "VERIFIED_BASELINE_EXECUTION_MISSING",
    ]);
  });

  it("[B3] parser invokes ledger verification instead of accepting a detached valid shape", () => {
    const changed = structuredClone(evidence) as unknown as Record<string, any>;
    const ledgerGroups = changed.attemptLedger;
    const events = Array.isArray(ledgerGroups)
      ? ledgerGroups[0]?.events
      : ledgerGroups?.ledger;
    expect(Array.isArray(events)).toBe(true);
    const responseIndex = events.findIndex(
      (event: any) => event.kind === "COUNT_TOKENS_RESPONSE",
    );
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    events.splice(responseIndex, 1);

    expect(() => parseLiveEvidenceJson(JSON.stringify(changed))).toThrow(
      /^(?:LIVE_EVIDENCE_INVALID|LIVE_EVIDENCE_BINDING_INVALID)$/,
    );
  });

  it("[B3] parsed evidence is deeply immutable during asynchronous evaluation", async () => {
    const serialized = JSON.stringify(evidence);
    const parsed = parseLiveEvidenceJson(serialized) as unknown as Record<
      string,
      any
    >;
    const original = JSON.parse(serialized) as Record<string, any>;
    const pending = evaluateOcrSynth(parsed as unknown as OcrEvalInput);

    const mutations = [
      () => {
        parsed.predictions[0].outcome.candidates[0].amountCents = "999999";
      },
      () => {
        const groups = parsed.attemptLedger;
        const events = Array.isArray(groups) ? groups[0].events : groups.ledger;
        events[0].sequence = 999;
      },
      () => {
        parsed.qualityClosure.snapshot.headSha = "0".repeat(40);
      },
      () => {
        const observations =
          parsed.qualityClosure.observations ?? parsed.qualityClosure.tests;
        observations[0].sourcePath = "caller/changed.spec.ts";
      },
    ];
    for (const mutate of mutations) {
      try {
        mutate();
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
      }
    }

    await pending;
    expect(parsed).toEqual(original);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.predictions[0])).toBe(true);
    expect(Object.isFrozen(parsed.qualityClosure)).toBe(true);
  });

  const causalEvents = (value: Record<string, any>): any[] =>
    Array.isArray(value.attemptLedger)
      ? value.attemptLedger.flatMap((group: any) => group.events)
      : value.attemptLedger.ledger;
  const event = (
    value: Record<string, any>,
    kind: string,
    caseId = "scan-001",
  ): any => {
    const found = causalEvents(value).find(
      (item: any) => item.kind === kind && item.caseId === caseId,
    );
    if (!found) throw new Error(`missing ${kind} for ${caseId}`);
    return found;
  };
  const replaceResponseBytes = (
    target: Record<string, any>,
    mutate: (wire: Record<string, any>) => void,
  ) => {
    const bytes = Buffer.from(target.responseBytesBase64, "base64");
    const wire = JSON.parse(bytes.toString("utf8")) as Record<string, any>;
    mutate(wire);
    const changed = Buffer.from(JSON.stringify(wire));
    target.responseBytesBase64 = changed.toString("base64");
    target.responseByteLength = changed.length;
    target.responseSha256 = attemptHash(changed);
  };

  const mutateGenerationPayload = (
    value: Record<string, any>,
    caseId: string,
    mutate: (payload: Record<string, any>, wire: Record<string, any>) => void,
  ) => {
    replaceResponseBytes(
      event(value, "GENERATION_RESPONSE", caseId),
      (wire) => {
        const part = wire.candidates[0].content.parts[0];
        const payload = JSON.parse(part.text) as Record<string, any>;
        mutate(payload, wire);
        part.text = JSON.stringify(payload);
      },
    );
  };

  it.each([
    [
      "COMPLETE plus EMPTY cannot stand in for DOCUMENT_UNREADABLE",
      () => structuredClone(terminalEvidence) as Record<string, any>,
      (value: Record<string, any>) =>
        mutateGenerationPayload(value, "scan-012", (payload) => {
          payload.completionStatus = "COMPLETE";
          payload.pageAccounting = payload.pageAccounting.map(
            (page: Record<string, any>) => ({
              ...page,
              status: "EMPTY",
              visibleOccurrenceCount: 0,
            }),
          );
        }),
    ],
    [
      "swapped provider terminal code",
      () => structuredClone(terminalEvidence) as Record<string, any>,
      (value: Record<string, any>) => {
        value.predictions.find(
          (item: Record<string, any>) => item.caseId === "scan-012",
        ).outcome.errorCode = "LIMIT_EXCEEDED";
      },
    ],
    [
      "retryable terminal mutation",
      () => structuredClone(terminalEvidence) as Record<string, any>,
      (value: Record<string, any>) => {
        value.predictions.find(
          (item: Record<string, any>) => item.caseId === "scan-018",
        ).outcome.retryable = true;
      },
    ],
    [
      "oracle terminal projected over raw COMPLETE",
      () => structuredClone(evidence) as Record<string, any>,
      (value: Record<string, any>) => {
        value.predictions[0].outcome = {
          kind: "ERROR",
          errorCode: "DOCUMENT_UNREADABLE",
          retryable: false,
        };
      },
    ],
    [
      "SUCCESS projected over a raw terminal",
      () => structuredClone(terminalEvidence) as Record<string, any>,
      (value: Record<string, any>) => {
        value.predictions.find(
          (item: Record<string, any>) => item.caseId === "scan-018",
        ).outcome = { kind: "SUCCESS", candidates: [] };
      },
    ],
    [
      "raw terminal payload changed without prediction",
      () => structuredClone(terminalEvidence) as Record<string, any>,
      (value: Record<string, any>) =>
        mutateGenerationPayload(value, "scan-018", (payload) => {
          payload.completionStatus = "INCOMPLETE";
          payload.pageAccounting[0].status = "UNREADABLE";
          payload.pageAccounting[0].visibleOccurrenceCount = 0;
        }),
    ],
  ] as const)(
    "rejects terminal/raw causal mutation: %s",
    (_label, arrange, mutate) => {
      const changed = arrange();
      expect(() =>
        parseLiveEvidenceJson(JSON.stringify(changed)),
      ).not.toThrow();

      mutate(changed);

      expect(() => parseLiveEvidenceJson(JSON.stringify(changed))).toThrow(
        "LIVE_EVIDENCE_INVALID",
      );
    },
  );

  it("serializes qualityClosure v2 with tests only and seven mechanical proof fields per test", () => {
    const closure = evidence.qualityClosure as unknown as Record<string, any>;

    expect(closure).not.toHaveProperty("observations");
    expect(closure.tests).toHaveLength(45);
    for (const test of closure.tests)
      expect(Object.keys(test).sort()).toEqual(
        [
          "assertionRecordSha256",
          "fullName",
          "name",
          "sourcePath",
          "status",
          "suiteResultSha256",
          "title",
        ].sort(),
      );
  });

  it("refuses the old three-field quality closure before any Vertex call", async () => {
    const adapter = provider();
    const outcome = await captureLiveEvidence(
      canonicalCaptureOptions(adapter.value),
    ).then(
      () => "RETURNED",
      (error: unknown) =>
        error instanceof Error ? error.message : "NON_ERROR_REJECTION",
    );

    expect({
      outcome,
      providerCalls: adapter.fetcher.mock.calls.length,
    }).toEqual({
      outcome: "LIVE_CAPTURE_ATTESTATION_MISSING",
      providerCalls: 0,
    });
  });

  it.each([
    "title",
    "fullName",
    "assertionRecordSha256",
    "suiteResultSha256",
  ] as const)(
    "rejects quality closure stripped of mandatory %s before Vertex",
    async (field) => {
      const adapter = provider();
      const closure = canonicalQualityClosure() as Record<string, any>;
      closure.tests = closure.tests.map(
        (test: Record<string, unknown>, index: number) => ({
          ...test,
          title: test.name,
          fullName: `qualification ${String(test.name)}`,
          assertionRecordSha256: "1".repeat(64),
          suiteResultSha256: "2".repeat(64),
          ...(index === 0 ? { [field]: undefined } : {}),
        }),
      );
      if (closure.tests[0][field] === undefined) delete closure.tests[0][field];
      const outcome = await captureLiveEvidence(
        canonicalCaptureOptions(adapter.value, {
          mechanical: {
            policy,
            qualityClosure: closure,
            finalReviewHashes: {
              residualRiskAcceptance: "e".repeat(64),
              securityReview: "1".repeat(64),
              privacyReview: "2".repeat(64),
              dataOwnerReview: "3".repeat(64),
            },
            verifySnapshot: jest.fn(async () => undefined),
          },
        }),
      ).then(
        () => "RETURNED",
        (error: unknown) =>
          error instanceof Error ? error.message : "NON_ERROR_REJECTION",
      );

      expect({
        outcome,
        providerCalls: adapter.fetcher.mock.calls.length,
      }).toEqual({
        outcome: "LIVE_CAPTURE_ATTESTATION_INVALID",
        providerCalls: 0,
      });
    },
  );

  it("rejects observations as an alias for tests before Vertex", async () => {
    const adapter = provider();
    const closure = canonicalQualityClosure() as Record<string, any>;
    closure.observations = closure.tests;
    delete closure.tests;
    const outcome = await captureLiveEvidence(
      canonicalCaptureOptions(adapter.value, {
        mechanical: {
          policy,
          qualityClosure: closure,
          finalReviewHashes: {
            residualRiskAcceptance: "e".repeat(64),
            securityReview: "1".repeat(64),
            privacyReview: "2".repeat(64),
            dataOwnerReview: "3".repeat(64),
          },
          verifySnapshot: jest.fn(async () => undefined),
        },
      }),
    ).then(
      () => "RETURNED",
      (error: unknown) =>
        error instanceof Error ? error.message : "NON_ERROR_REJECTION",
    );

    expect({
      outcome,
      providerCalls: adapter.fetcher.mock.calls.length,
    }).toEqual({
      outcome: "LIVE_CAPTURE_ATTESTATION_INVALID",
      providerCalls: 0,
    });
  });

  it.each([
    [
      "CountTokens raw bytes and self-hash without admission count",
      (value: Record<string, any>) =>
        replaceResponseBytes(event(value, "COUNT_TOKENS_RESPONSE"), (wire) => {
          wire.totalTokens = 101;
        }),
    ],
    [
      "GenerateContent raw bytes and self-hash without prediction",
      (value: Record<string, any>) =>
        replaceResponseBytes(event(value, "GENERATION_RESPONSE"), (wire) => {
          wire.modelVersion = "gemini-2.5-flash-mutated";
        }),
    ],
    [
      "request-plan SHA on every event without recomputed plan",
      (value: Record<string, any>) => {
        for (const item of causalEvents(value))
          item.requestPlanSha256 = "9".repeat(64);
        if (!Array.isArray(value.attemptLedger))
          for (const caseId of Object.keys(
            value.attemptLedger.requestPlanSha256ByCase,
          ))
            value.attemptLedger.requestPlanSha256ByCase[caseId] = "9".repeat(
              64,
            );
      },
    ],
    [
      "CountTokens request-body SHA",
      (value: Record<string, any>) => {
        event(value, "COUNT_TOKENS_REQUEST").requestBodySha256 = "8".repeat(64);
      },
    ],
    [
      "GenerateContent request-body SHA",
      (value: Record<string, any>) => {
        event(value, "GENERATION_REQUEST").requestBodySha256 = "7".repeat(64);
      },
    ],
    [
      "raw modelVersion only",
      (value: Record<string, any>) =>
        replaceResponseBytes(event(value, "GENERATION_RESPONSE"), (wire) => {
          wire.modelVersion = "gemini-2.5-flash-other";
        }),
    ],
    [
      "prediction and run modelVersion without raw response",
      (value: Record<string, any>) => {
        value.run.modelVersion = "gemini-2.5-flash-002";
        value.predictions[0].modelVersion = "gemini-2.5-flash-002";
      },
    ],
    [
      "raw responseId",
      (value: Record<string, any>) =>
        replaceResponseBytes(event(value, "GENERATION_RESPONSE"), (wire) => {
          wire.responseId = "response-mutated-only";
        }),
    ],
    [
      "trace responseId only",
      (value: Record<string, any>) => {
        value.predictions[0].adapterTrace.responseId = "response-trace-mutated";
      },
    ],
    [
      "prediction candidate cents only",
      (value: Record<string, any>) => {
        value.predictions[0].outcome.candidates[0].amountCents = "2";
      },
    ],
    [
      "two prediction candidates",
      (value: Record<string, any>) => {
        const candidates = value.predictions.find(
          (item: any) => item.caseId === "scan-010",
        ).outcome.candidates;
        [candidates[0], candidates[1]] = [candidates[1], candidates[0]];
      },
    ],
    [
      "two case ledger groups",
      (value: Record<string, any>) => {
        if (Array.isArray(value.attemptLedger)) {
          [value.attemptLedger[0], value.attemptLedger[1]] = [
            value.attemptLedger[1],
            value.attemptLedger[0],
          ];
          return;
        }
        const ledger = value.attemptLedger.ledger;
        const first = ledger.slice(0, 6);
        const second = ledger.slice(6, 12);
        ledger.splice(0, 12, ...second, ...first);
        ledger.forEach((item: any, index: number) => {
          item.sequence = index + 1;
        });
      },
    ],
    [
      "another case request ID",
      (value: Record<string, any>) => {
        const other = value.predictions[1].adapterTrace.requestId;
        for (const item of causalEvents(value))
          if (item.caseId === "scan-001") item.requestId = other;
      },
    ],
    [
      "another tenant ID",
      (value: Record<string, any>) => {
        value.predictions[0].tenantId = getOcrSynthCase(
          "tenant-identical-bytes-b",
        ).tenantId;
      },
    ],
    [
      "artifact SHA without generated PDF",
      (value: Record<string, any>) => {
        value.predictions[0].artifactSha256 = "6".repeat(64);
      },
    ],
    [
      "one closure observation",
      (value: Record<string, any>) => {
        (value.qualityClosure.observations ?? value.qualityClosure.tests).pop();
      },
    ],
    [
      "duplicate closure observation",
      (value: Record<string, any>) => {
        const observations =
          value.qualityClosure.observations ?? value.qualityClosure.tests;
        observations.splice(1, 0, structuredClone(observations[0]));
      },
    ],
    [
      "closure observation order",
      (value: Record<string, any>) => {
        const observations =
          value.qualityClosure.observations ?? value.qualityClosure.tests;
        [observations[0], observations[1]] = [observations[1], observations[0]];
      },
    ],
    [
      "closure observation source",
      (value: Record<string, any>) => {
        const observations =
          value.qualityClosure.observations ?? value.qualityClosure.tests;
        observations[0].sourcePath = "caller/fabricated.spec.ts";
      },
    ],
    [
      "repository tree SHA",
      (value: Record<string, any>) => {
        value.qualityClosure.snapshot.treeSha = "5".repeat(40);
      },
    ],
  ] as Array<[string, (value: Record<string, any>) => void]>)(
    "[B3] independently rejects broken causal binding: %s",
    (_label, mutate) => {
      const changed = JSON.parse(JSON.stringify(evidence)) as Record<
        string,
        any
      >;
      expect(() =>
        parseLiveEvidenceJson(JSON.stringify(changed)),
      ).not.toThrow();

      mutate(changed);

      expect(() => parseLiveEvidenceJson(JSON.stringify(changed))).toThrow(
        /^(?:LIVE_EVIDENCE_INVALID|LIVE_EVIDENCE_BINDING_INVALID)$/,
      );
    },
  );

  it("fails before dispatch when Linux VmHWM evidence is unavailable", async () => {
    const adapter = provider();
    await expect(
      captureLiveEvidence(
        canonicalCaptureOptions(adapter.value, {
          readProcSelfStatus: async () => {
            throw new Error("proc unavailable");
          },
        }),
      ),
    ).rejects.toThrow("LIVE_CAPTURE_VMHWM_UNAVAILABLE");
    expect(adapter.fetcher).not.toHaveBeenCalled();
  });

  it("records one pre-dispatch and eighteen post-response Linux VmHWM checkpoints", async () => {
    const adapter = provider();
    const readProcSelfStatus = jest.fn(
      async (_path: string) => "Name:\tnode\nVmHWM:\t524288 kB\n",
    );
    const captured = await captureLiveEvidence(
      canonicalCaptureOptions(adapter.value, { readProcSelfStatus }),
    );

    expect(readProcSelfStatus).toHaveBeenCalledTimes(19);
    expect(
      readProcSelfStatus.mock.calls.every(
        ([path]) => path === "/proc/self/status",
      ),
    ).toBe(true);
    expect(captured.predictions.map((item) => item.peakRssBytes)).toEqual(
      Array.from({ length: 18 }, () => policy.maxVmHwmBytes),
    );
    expect(adapter.fetcher).toHaveBeenCalledTimes(36);
  });

  it("preserves the complete provider-native V3 facts and explicit review defaults", () => {
    const serialized = JSON.stringify(evidence.predictions[0]!.outcome);
    for (const forbidden of ["bbox", "rowId", "amountText"])
      expect(serialized).not.toContain(`"${forbidden}"`);
    expect(evidence.predictions[0]!.outcome).toMatchObject({
      kind: "SUCCESS",
      candidates: [
        {
          pageNumber: 1,
          pageOccurrenceIndex: 1,
          description: "ITEM SINTETICO 001-0",
          amountCents: "1",
          sign: "POSITIVE",
          amountMeaning: "LINE_AMOUNT",
          dateText: "29/02/2024",
          normalizedDate: "2024-02-29",
          dateExplicitness: "FULL",
          installment: null,
          evidenceText: "29/02/2024  ITEM SINTETICO 001-0  R$ 0,01",
          selected: false,
          verificationStatus: "UNVERIFIED",
          candidateDisposition: "RAW_UNCLASSIFIED",
        },
      ],
    });
    expect(evidence.predictions[0]).toMatchObject({
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      modelVersion: VERSION,
      capturePath: "DIRECT_PROVIDER_CAPTURE",
      consentRecorded: false,
      consentCapability: null,
      attestationRequired: null,
    });
    expect(JSON.stringify(evidence.predictions[0])).not.toContain(
      "requestPayloadHash",
    );
  });

  it("uses one unique valid request identity across request, provenance, and trace", () => {
    const requestIds = evidence.predictions.map(
      (item) => item.adapterTrace!.requestId,
    );
    expect(new Set(requestIds).size).toBe(18);
    for (const [index, requestId] of requestIds.entries()) {
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(requestId).toBe(
        evidence.predictions[index]!.adapterTrace!.requestId,
      );
      expect(requestId).toBe(dispatchedRequestIds[index]);
    }
  });

  it("produces no fabricated consent or request mismatch issues", async () => {
    const report = await evaluateOcrSynth(evidence);
    expect(report.perCase.flatMap((item) => item.issues)).not.toEqual(
      expect.arrayContaining([
        "MISSING_CONSENT",
        "CONSENT_CAPABILITY_MISMATCH",
        "ATTESTATION_NOT_REQUIRED",
        "REQUEST_ID_MISMATCH",
      ]),
    );
    expect(report.liveEvidenceGaps).not.toContain(
      "MISSING_REAL_SERVICE_CONSENT_EVIDENCE",
    );
    expect(report.liveEvidenceGaps).not.toContain(
      "PRODUCTION_SERVICE_ACCOUNT_AUTH_NOT_PROVED",
    );
  });

  it("accepts local evidence structurally but never as production auth proof", async () => {
    const local = JSON.parse(JSON.stringify(evidence)) as OcrEvalInput;
    for (const prediction of local.predictions)
      prediction.adapterTrace!.authTrace = "LOCAL_ADC";
    expect(parseLiveEvidence(local)).toEqual(local);
    const report = await evaluateOcrSynth(local);
    expect(report.liveEvidenceGaps).toContain(
      "PRODUCTION_SERVICE_ACCOUNT_AUTH_NOT_PROVED",
    );
  });

  it("rejects the legacy undifferentiated ADC trace", () => {
    const legacy = structuredClone(evidence) as unknown as {
      predictions: Array<{
        adapterTrace: Record<string, unknown>;
      }>;
    };
    const trace = legacy.predictions[0]!.adapterTrace;
    delete trace.authTrace;
    trace.auth = "ADC_OAUTH";
    expect(() => parseLiveEvidence(legacy)).toThrow("LIVE_EVIDENCE_INVALID");
  });

  it("stops without retry or publication when the snapshot drifts after call 1 or 18", async () => {
    for (const driftAt of [1, 18]) {
      const adapter = provider();
      const verifySnapshot = jest.fn(async () => {
        if (verifySnapshot.mock.calls.length === driftAt)
          throw new Error("QUALITY_REPOSITORY_DRIFT");
      });
      const capture = captureLiveEvidence(
        canonicalCaptureOptions(adapter.value, {
          mechanical: {
            policy,
            qualityClosure: canonicalQualityClosure(),
            finalReviewHashes: {
              residualRiskAcceptance: "e".repeat(64),
              securityReview: "1".repeat(64),
              privacyReview: "2".repeat(64),
              dataOwnerReview: "3".repeat(64),
            },
            verifySnapshot,
          },
        }),
      );

      await expect(capture).rejects.toThrow("QUALITY_REPOSITORY_DRIFT");
      expect(adapter.fetcher).toHaveBeenCalledTimes(driftAt * 2);
      expect(verifySnapshot).toHaveBeenCalledTimes(driftAt);
    }
  });

  it("stops on duplicate response IDs or mixed model versions", async () => {
    const duplicate = provider([VERSION], ["same-response", "same-response"]);
    await expect(
      captureLiveEvidence(canonicalCaptureOptions(duplicate.value)),
    ).rejects.toThrow("LIVE_CAPTURE_PROVENANCE_MISMATCH");
    expect(duplicate.fetcher).toHaveBeenCalledTimes(4);

    const mixed = provider([VERSION, "gemini-other-version"]);
    await expect(
      captureLiveEvidence(canonicalCaptureOptions(mixed.value)),
    ).rejects.toThrow("LIVE_CAPTURE_PROVENANCE_MISMATCH");
    expect(mixed.fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(["provenance", "trace"] as const)(
    "stops when returned %s request identity differs from dispatch",
    async (target) => {
      const adapter = provider();
      const extract = adapter.value.extractPdf.bind(adapter.value);
      jest
        .spyOn(adapter.value, "extractPdf")
        .mockImplementation(async (request) => {
          const document = await extract(request);
          return {
            ...document,
            provenance: {
              ...document.provenance,
              ...(target === "provenance"
                ? {
                    requestId: "20000000-0000-4000-8000-000000000001",
                  }
                : {
                    requestTrace: {
                      ...document.provenance.requestTrace!,
                      requestId: "20000000-0000-4000-8000-000000000001",
                    },
                  }),
            },
          };
        });
      await expect(
        captureLiveEvidence(canonicalCaptureOptions(adapter.value)),
      ).rejects.toThrow("LIVE_CAPTURE_PROVIDER_CONTRACT_FAILED");
      expect(adapter.fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects duplicate request identities and fabricated direct consent", () => {
    const duplicate = structuredClone(evidence);
    duplicate.predictions[1]!.adapterTrace!.requestId =
      duplicate.predictions[0]!.adapterTrace!.requestId;
    expect(() => parseLiveEvidence(duplicate)).toThrow("LIVE_EVIDENCE_INVALID");

    const fabricated = structuredClone(evidence) as unknown as {
      predictions: Array<Record<string, unknown>>;
    };
    fabricated.predictions[0]!.consentRecorded = true;
    fabricated.predictions[0]!.consentCapability = {
      capability: "ANALYZE_ATTACHMENT_V2",
    };
    fabricated.predictions[0]!.attestationRequired = true;
    expect(() => parseLiveEvidence(fabricated)).toThrow(
      "LIVE_EVIDENCE_INVALID",
    );
  });

  it("requires exact real-service consent probe provenance", async () => {
    const changed = structuredClone(evidence) as unknown as Record<string, any>;
    const observations =
      changed.qualityClosure.observations ?? changed.qualityClosure.tests;
    observations.find(
      (observation: Record<string, unknown>) =>
        observation.name === "[PROBE] EXACT_CONSENT_CAPABILITY",
    )!.sourcePath =
      "apps/api/src/imports/ocr-synth-v1/direct-pdf-vertex-safety.spec.ts";
    expect(() => parseLiveEvidence(changed as unknown as OcrEvalInput)).toThrow(
      /^(?:LIVE_EVIDENCE_INVALID|LIVE_EVIDENCE_BINDING_INVALID)$/,
    );
    const report = await evaluateOcrSynth(changed as unknown as OcrEvalInput);
    expect(report.liveEvidenceGaps).toContain(
      "MISSING_REAL_SERVICE_CONSENT_EVIDENCE",
    );
  });

  it("scores mutations from native candidates without oracle annotations", async () => {
    const changed = structuredClone(evidence);
    const outcome = changed.predictions[0]!.outcome;
    if (outcome.kind !== "SUCCESS" || !("candidates" in outcome))
      throw new Error("test fixture");
    outcome.candidates[0]!.amountCents = "999";
    const report = await evaluateOcrSynth(changed);
    expect(
      report.perCase.find((item) => item.caseId === "scan-001")!.issues,
    ).toContain("MONEY_MISMATCH");
  });

  it("strictly parses evidence after JSON.parse and rejects malformed, extra, missing, and byte fields", () => {
    expect(parseLiveEvidenceJson(JSON.stringify(evidence))).toEqual(evidence);
    const extra = structuredClone(evidence) as unknown as Record<
      string,
      unknown
    >;
    extra.unknown = true;
    expect(() => parseLiveEvidence(extra)).toThrow("LIVE_EVIDENCE_INVALID");
    const missing = structuredClone(evidence) as unknown as Record<
      string,
      unknown
    >;
    delete missing.run;
    expect(() => parseLiveEvidence(missing)).toThrow("LIVE_EVIDENCE_INVALID");
    const bytes = structuredClone(evidence) as unknown as {
      predictions: Array<Record<string, unknown>>;
    };
    bytes.predictions[0]!.pdfBytes = {
      type: "Buffer",
      data: [37, 80, 68, 70],
    };
    expect(() => parseLiveEvidence(bytes)).toThrow("LIVE_EVIDENCE_INVALID");
    const unknownEnum = structuredClone(evidence);
    const unknownOutcome = unknownEnum.predictions[0]!.outcome;
    if (unknownOutcome.kind !== "SUCCESS" || !("candidates" in unknownOutcome))
      throw new Error("test fixture");
    unknownOutcome.candidates[0]!.sign =
      "UNTRUSTED" as (typeof unknownOutcome.candidates)[0]["sign"];
    expect(() => parseLiveEvidence(unknownEnum)).toThrow(
      "LIVE_EVIDENCE_INVALID",
    );
    const duplicateCase = structuredClone(evidence);
    duplicateCase.predictions[1]!.caseId = duplicateCase.predictions[0]!.caseId;
    expect(() => parseLiveEvidence(duplicateCase)).toThrow(
      "LIVE_EVIDENCE_INVALID",
    );
    expect(() => parseLiveEvidenceJson("{")).toThrow("LIVE_EVIDENCE_INVALID");
  });

  it("reserves mode 0600 before capture without following existing paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ocr-live-"));
    const output = join(directory, "evidence.json");
    const capture = jest.fn(async () => {
      const reservation = await stat(output);
      expect(reservation.isFile()).toBe(true);
      expect(reservation.mode & 0o777).toBe(0o600);
      expect(await readFile(output, "utf8")).toBe("");
      return evidence;
    });
    await writeLiveEvidenceExclusive(output, capture);
    expect(capture).toHaveBeenCalledTimes(1);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const serialized = await readFile(output, "utf8");
    expect(serialized).not.toContain("test-only-adc-token");
    expect(serialized).not.toContain("%PDF-");
    const existingCapture = jest.fn(async () => evidence);
    await expect(
      writeLiveEvidenceExclusive(output, existingCapture),
    ).rejects.toBeDefined();
    expect(existingCapture).not.toHaveBeenCalled();

    const target = join(directory, "target.json");
    const link = join(directory, "link.json");
    await symlink(target, link);
    const symlinkCapture = jest.fn(async () => evidence);
    await expect(
      writeLiveEvidenceExclusive(link, symlinkCapture),
    ).rejects.toBeDefined();
    expect(symlinkCapture).not.toHaveBeenCalled();

    const concurrent = join(directory, "concurrent.json");
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstWrite = writeLiveEvidenceExclusive(concurrent, async () => {
      firstStarted();
      await release;
      return evidence;
    });
    await started;
    const secondCapture = jest.fn(async () => evidence);
    await expect(
      writeLiveEvidenceExclusive(concurrent, secondCapture),
    ).rejects.toBeDefined();
    expect(secondCapture).not.toHaveBeenCalled();
    releaseFirst();
    await expect(firstWrite).resolves.toBeUndefined();

    const failed = join(directory, "failed.json");
    await expect(
      writeLiveEvidenceExclusive(failed, async () => {
        throw new Error("simulated");
      }),
    ).rejects.toThrow("simulated");
    await expect(stat(failed)).rejects.toBeDefined();
  });

  it("does not publish after post-capture SHA drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ocr-live-drift-"));
    const output = join(directory, "evidence.json");
    const capture = jest.fn(async () => evidence);
    await expect(
      writeLiveEvidenceExclusive(output, capture, async () => {
        throw new Error("LIVE_CAPTURE_REPOSITORY_DRIFT");
      }),
    ).rejects.toThrow("LIVE_CAPTURE_REPOSITORY_DRIFT");
    expect(capture).toHaveBeenCalledTimes(1);
    await expect(stat(output)).rejects.toBeDefined();
  });

  it("leaves a replacement untouched when failure cleanup loses inode ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ocr-live-inode-"));
    const output = join(directory, "evidence.json");
    await expect(
      writeLiveEvidenceExclusive(output, async () => {
        await unlink(output);
        await writeFile(output, "replacement", { mode: 0o600 });
        throw new Error("simulated");
      }),
    ).rejects.toThrow("simulated");
    expect(await readFile(output, "utf8")).toBe("replacement");
  });

  it("keeps all route and probe authority bound to mechanical closure results", () => {
    const qualificationTests = (
      policy as unknown as {
        qualificationTests: Array<{ name: string; sourcePath: string }>;
      }
    ).qualificationTests;
    const closure = evidence.qualityClosure as unknown as {
      observations?: Array<Record<string, unknown>>;
      tests?: Array<Record<string, unknown>>;
    };
    const observations = closure.observations ?? closure.tests ?? [];

    expect(observations).toEqual(
      qualificationTests.map(({ name, sourcePath }) => ({
        name,
        title: name,
        fullName: expect.stringContaining(name),
        status: "PASS",
        sourcePath,
        assertionRecordSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        suiteResultSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })),
    );
    expect(
      observations.filter(({ name }) => String(name).startsWith("[ROUTE] ")),
    ).toHaveLength(OCR_SYNTH_ROUTING_CASES.length);
    expect(
      observations.filter(({ name }) => String(name).startsWith("[PROBE] ")),
    ).toHaveLength(35);
  });
});

type CapturedAttemptAuthority = Readonly<{
  executeCapturedAttempt(input: {
    runId: string;
    runAttempt: 1;
    caseId: string;
    requestId: string;
    requestPlanSha256: string;
    countTokensRequestSha256: string;
    spentKnownBeforeMicros: number;
    reservedOutputTokens: 8192;
    inputMicrosPerMillionTokens: 300000;
    outputMicrosPerMillionTokens: 2500000;
    hardLimitMicros: 500000;
    countTokens: () => Promise<Buffer>;
    generation: () => Promise<Buffer>;
  }): Promise<Record<string, any>>;
  verifyAttemptLedger(input: unknown): unknown;
}>;

function capturedAttemptAuthority(): CapturedAttemptAuthority {
  const loaded =
    captureLiveCore as unknown as Partial<CapturedAttemptAuthority>;
  const observation = {
    kind:
      typeof loaded.executeCapturedAttempt === "function" &&
      typeof loaded.verifyAttemptLedger === "function"
        ? "READY"
        : "BOUNDARY_UNAVAILABLE",
    code: "CAPTURE_ATTEMPT_LEDGER_NOT_IMPLEMENTED",
  };
  expect(observation).toMatchObject({ kind: "READY" });
  if (observation.kind !== "READY") throw new Error(observation.code);
  return loaded as CapturedAttemptAuthority;
}

const attemptHash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

function countTokensResponse(totalTokens = 100) {
  return Buffer.from(JSON.stringify({ totalTokens }));
}

function generationResponseBytes(caseId = "scan-001") {
  return Buffer.from(
    JSON.stringify({
      responseId: `response-${caseId}`,
      modelVersion: VERSION,
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: JSON.stringify({ candidates: [] }) }] },
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        totalTokenCount: 120,
      },
    }),
  );
}

function attemptInput(
  spentKnownBeforeMicros: number,
  countTokens = jest.fn(async () => countTokensResponse()),
  generation = jest.fn(async () => generationResponseBytes()),
) {
  return {
    runId: "qualification-run-1001",
    runAttempt: 1 as const,
    caseId: "scan-001",
    requestId: "10000000-0000-4000-8000-000000000001",
    requestPlanSha256: "a".repeat(64),
    countTokensRequestSha256: "b".repeat(64),
    spentKnownBeforeMicros,
    reservedOutputTokens: 8192 as const,
    inputMicrosPerMillionTokens: 300_000 as const,
    outputMicrosPerMillionTokens: 2_500_000 as const,
    hardLimitMicros: 500_000 as const,
    countTokens,
    generation,
  };
}

function admittedLedgerCase(
  caseId: string,
  sequenceStart: number,
  caseIndex: number,
) {
  const countBytes = countTokensResponse();
  const generationBytes = generationResponseBytes(caseId);
  const common = {
    runId: "qualification-run-1001",
    runAttempt: 1,
    caseId,
    requestId: `10000000-0000-4000-8000-${String(caseIndex + 1).padStart(
      12,
      "0",
    )}`,
    requestPlanSha256: "a".repeat(64),
  };
  return [
    {
      ...common,
      sequence: sequenceStart,
      kind: "COUNT_TOKENS_REQUEST",
      requestBodySha256: "b".repeat(64),
    },
    {
      ...common,
      sequence: sequenceStart + 1,
      kind: "COUNT_TOKENS_RESPONSE",
      responseBytesBase64: countBytes.toString("base64"),
      responseByteLength: countBytes.length,
      responseSha256: attemptHash(countBytes),
      parsedInputTokens: 100,
    },
    {
      ...common,
      sequence: sequenceStart + 2,
      kind: "ADMISSION_DECISION",
      countTokensResponseSha256: attemptHash(countBytes),
      countedInputTokens: 100,
      reservedOutputTokens: 8192,
      inputMicrosPerMillionTokens: 300_000,
      outputMicrosPerMillionTokens: 2_500_000,
      spentKnownBeforeMicros: caseIndex * 20_510,
      worstCaseCurrentMicros: 20_510,
      cumulativeWorstCaseMicros: (caseIndex + 1) * 20_510,
      hardLimitMicros: 500_000,
      decision: "ADMITTED",
    },
    {
      ...common,
      sequence: sequenceStart + 3,
      kind: "GENERATION_REQUEST",
      requestBodySha256: "c".repeat(64),
    },
    {
      ...common,
      sequence: sequenceStart + 4,
      kind: "GENERATION_RESPONSE",
      responseBytesBase64: generationBytes.toString("base64"),
      responseByteLength: generationBytes.length,
      responseSha256: attemptHash(generationBytes),
    },
    {
      ...common,
      sequence: sequenceStart + 5,
      kind: "SPEND_RECONCILED",
      measuredCurrentMicros: 80,
      cumulativeMeasuredMicros: (caseIndex + 1) * 80,
      cumulativeWorstCaseMicros: (caseIndex + 1) * 20_510,
    },
  ] as Array<Record<string, any>>;
}

function capturedAttemptFixture() {
  return {
    runId: "qualification-run-1001",
    runAttempt: 1,
    ledger: OCR_SYNTH_SCANNED_RELEASE_CASES.flatMap(({ id }, index) =>
      admittedLedgerCase(id, index * 6 + 1, index),
    ),
  };
}

describe("hashed countTokens admission and ordered attempt ledger", () => {
  it.each([
    [479_490, "ADMITTED", 500_000, 1],
    [479_491, "CAPTURE_SPEND_LIMIT", 500_001, 0],
  ] as const)(
    "derives cumulative %i boundary from exact hashed bytes before generation",
    async (spentKnownBeforeMicros, decision, cumulative, generationCalls) => {
      const countTokens = jest.fn(async () => countTokensResponse());
      const generation = jest.fn(async () => generationResponseBytes());

      const result = await capturedAttemptAuthority().executeCapturedAttempt(
        attemptInput(spentKnownBeforeMicros, countTokens, generation),
      );

      expect(countTokens).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        decision,
        countedInputTokens: 100,
        worstCaseCurrentMicros: 20_510,
        cumulativeWorstCaseMicros: cumulative,
      });
      expect(generation).toHaveBeenCalledTimes(generationCalls);
      expect(
        result.ledger.map((event: { kind: string }) => event.kind),
      ).toEqual(
        decision === "ADMITTED"
          ? [
              "COUNT_TOKENS_REQUEST",
              "COUNT_TOKENS_RESPONSE",
              "ADMISSION_DECISION",
              "GENERATION_REQUEST",
              "GENERATION_RESPONSE",
              "SPEND_RECONCILED",
            ]
          : [
              "COUNT_TOKENS_REQUEST",
              "COUNT_TOKENS_RESPONSE",
              "ADMISSION_DECISION",
            ],
      );
      expect(result.ledger[1]).toMatchObject({
        responseByteLength: countTokensResponse().length,
        responseSha256: attemptHash(countTokensResponse()),
        parsedInputTokens: 100,
      });
    },
  );

  it("[B3] accepts bounded CountTokens metadata and hashes all exact bytes", async () => {
    const countBytes = Buffer.from(
      JSON.stringify({
        totalTokens: 100,
        totalBillableCharacters: 912,
        promptTokensDetails: [{ modality: "DOCUMENT", tokenCount: 100 }],
      }),
    );
    const countTokens = jest.fn(async () => Buffer.from(countBytes));
    const generation = jest.fn(async () => generationResponseBytes());

    const result = await capturedAttemptAuthority().executeCapturedAttempt(
      attemptInput(0, countTokens, generation),
    );

    expect(result).toMatchObject({
      decision: "ADMITTED",
      countedInputTokens: 100,
      ledger: expect.arrayContaining([
        expect.objectContaining({
          kind: "COUNT_TOKENS_RESPONSE",
          responseByteLength: countBytes.length,
          responseSha256: attemptHash(countBytes),
          parsedInputTokens: 100,
        }),
      ]),
    });
    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(generation).toHaveBeenCalledTimes(1);
  });

  it("accepts only the complete ordered 18-case canonical ledger", () => {
    const evidence = capturedAttemptFixture();

    expect(
      evidence.ledger
        .filter(({ kind }) => kind === "COUNT_TOKENS_REQUEST")
        .map(({ caseId }) => caseId),
    ).toEqual(OCR_SYNTH_SCANNED_RELEASE_CASES.map(({ id }) => id));
    expect(
      evidence.ledger
        .filter(({ kind }) => kind === "ADMISSION_DECISION")
        .map((event) => ({
          reservedOutputTokens: event.reservedOutputTokens,
          inputMicrosPerMillionTokens: event.inputMicrosPerMillionTokens,
          outputMicrosPerMillionTokens: event.outputMicrosPerMillionTokens,
          hardLimitMicros: event.hardLimitMicros,
          decision: event.decision,
        })),
    ).toEqual(
      Array.from({ length: 18 }, () => ({
        reservedOutputTokens: 8192,
        inputMicrosPerMillionTokens: 300_000,
        outputMicrosPerMillionTokens: 2_500_000,
        hardLimitMicros: 500_000,
        decision: "ADMITTED",
      })),
    );
    expect(capturedAttemptAuthority().verifyAttemptLedger(evidence)).toBe(true);
  });

  it.each([
    [
      "missing canonical scan-018",
      (evidence: ReturnType<typeof capturedAttemptFixture>) => {
        evidence.ledger.splice(-6);
      },
      "ATTEMPT_LEDGER_IDENTITIES_INVALID",
    ],
    [
      "a duplicated request identity",
      (evidence: ReturnType<typeof capturedAttemptFixture>) => {
        const duplicate = evidence.ledger[0]!.requestId;
        for (const event of evidence.ledger.filter(
          ({ caseId }) => caseId === "scan-002",
        ))
          event.requestId = duplicate;
      },
      "ATTEMPT_LEDGER_REQUEST_BINDING_INVALID",
    ],
    [
      "a per-case request-plan substitution",
      (evidence: ReturnType<typeof capturedAttemptFixture>) => {
        for (const event of evidence.ledger.filter(
          ({ caseId }) => caseId === "scan-009",
        ))
          event.requestPlanSha256 = "9".repeat(64);
      },
      "ATTEMPT_LEDGER_REQUEST_BINDING_INVALID",
    ],
    [
      "a generation response hash substitution",
      (evidence: ReturnType<typeof capturedAttemptFixture>) => {
        const response = evidence.ledger.find(
          ({ caseId, kind }) =>
            caseId === "scan-010" && kind === "GENERATION_RESPONSE",
        )!;
        response.responseSha256 = "8".repeat(64);
      },
      "GENERATION_RESPONSE_BINDING_INVALID",
    ],
    [
      "a measured current-cost substitution",
      (evidence: ReturnType<typeof capturedAttemptFixture>) => {
        const reconciled = evidence.ledger.find(
          ({ caseId, kind }) =>
            caseId === "scan-011" && kind === "SPEND_RECONCILED",
        )!;
        reconciled.measuredCurrentMicros = 81;
      },
      "MEASURED_SPEND_RECONCILIATION_INVALID",
    ],
    [
      "a running measured cumulative-cost reset",
      (evidence: ReturnType<typeof capturedAttemptFixture>) => {
        const reconciled = evidence.ledger.find(
          ({ caseId, kind }) =>
            caseId === "scan-012" && kind === "SPEND_RECONCILED",
        )!;
        reconciled.cumulativeMeasuredMicros = 80;
      },
      "CUMULATIVE_MEASURED_SPEND_INVALID",
    ],
    [
      "noncanonical fixed input pricing",
      (evidence: ReturnType<typeof capturedAttemptFixture>) => {
        for (const event of evidence.ledger) {
          if (event.kind === "ADMISSION_DECISION") {
            event.inputMicrosPerMillionTokens = 301_000;
            event.worstCaseCurrentMicros = 20_511;
            const caseIndex = Number(event.caseId.slice(-3)) - 1;
            event.spentKnownBeforeMicros = caseIndex * 20_511;
            event.cumulativeWorstCaseMicros = (caseIndex + 1) * 20_511;
          }
          if (event.kind === "SPEND_RECONCILED") {
            const caseIndex = Number(event.caseId.slice(-3)) - 1;
            event.cumulativeWorstCaseMicros = (caseIndex + 1) * 20_511;
          }
        }
      },
      "ATTEMPT_LEDGER_PRICING_INVALID",
    ],
  ] as const)("rejects %s", (_label, mutate, code) => {
    const evidence = capturedAttemptFixture();
    mutate(evidence);

    expect(() =>
      capturedAttemptAuthority().verifyAttemptLedger(evidence),
    ).toThrow(code);
  });

  it("does not trust an unbound countedInputTokens claim", () => {
    const evidence = capturedAttemptFixture();
    const admission = evidence.ledger.find(
      ({ kind }) => kind === "ADMISSION_DECISION",
    )!;
    admission.countedInputTokens = 0;

    expect(() =>
      capturedAttemptAuthority().verifyAttemptLedger(evidence),
    ).toThrow("COUNT_TOKENS_RESPONSE_BINDING_INVALID");
  });

  it.each([
    [
      "reserved output 8191",
      (ledger: Array<Record<string, any>>) => {
        ledger
          .filter(({ kind }) => kind === "ADMISSION_DECISION")
          .forEach((item) => {
            item.reservedOutputTokens = 8191;
          });
      },
    ],
    [
      "reserved output 8193",
      (ledger: Array<Record<string, any>>) => {
        ledger
          .filter(({ kind }) => kind === "ADMISSION_DECISION")
          .forEach((item) => {
            item.reservedOutputTokens = 8193;
          });
      },
    ],
    [
      "input price plus one",
      (ledger: Array<Record<string, any>>) => {
        ledger
          .filter(({ kind }) => kind === "ADMISSION_DECISION")
          .forEach((item) => {
            item.inputMicrosPerMillionTokens += 1;
          });
      },
    ],
    [
      "output price plus one",
      (ledger: Array<Record<string, any>>) => {
        ledger
          .filter(({ kind }) => kind === "ADMISSION_DECISION")
          .forEach((item) => {
            item.outputMicrosPerMillionTokens += 1;
          });
      },
    ],
    [
      "hard limit minus one",
      (ledger: Array<Record<string, any>>) => {
        ledger
          .filter(({ kind }) => kind === "ADMISSION_DECISION")
          .forEach((item) => {
            item.hardLimitMicros = 499_999;
          });
      },
    ],
    [
      "hard limit plus one",
      (ledger: Array<Record<string, any>>) => {
        ledger
          .filter(({ kind }) => kind === "ADMISSION_DECISION")
          .forEach((item) => {
            item.hardLimitMicros = 500_001;
          });
      },
    ],
    [
      "worst case plus one with adjusted cumulative claims",
      (ledger: Array<Record<string, any>>) => {
        for (const item of ledger) {
          const caseIndex = Number(item.caseId.slice(-3));
          if (item.kind === "ADMISSION_DECISION") {
            item.spentKnownBeforeMicros = (caseIndex - 1) * 20_511;
            item.worstCaseCurrentMicros = 20_511;
            item.cumulativeWorstCaseMicros = caseIndex * 20_511;
          }
          if (item.kind === "SPEND_RECONCILED")
            item.cumulativeWorstCaseMicros = caseIndex * 20_511;
        }
      },
    ],
    [
      "measured plus one with adjusted running cumulative claims",
      (ledger: Array<Record<string, any>>) => {
        for (const item of ledger) {
          if (item.kind !== "SPEND_RECONCILED") continue;
          const caseIndex = Number(item.caseId.slice(-3));
          item.measuredCurrentMicros = 81;
          item.cumulativeMeasuredMicros = caseIndex * 81;
        }
      },
    ],
    [
      "counted input plus one with adjusted worst and cumulative claims",
      (ledger: Array<Record<string, any>>) => {
        for (const item of ledger) {
          const caseIndex = Number(item.caseId.slice(-3));
          if (item.kind === "ADMISSION_DECISION") {
            item.countedInputTokens = 101;
            item.spentKnownBeforeMicros = (caseIndex - 1) * 20_511;
            item.worstCaseCurrentMicros = 20_511;
            item.cumulativeWorstCaseMicros = caseIndex * 20_511;
          }
          if (item.kind === "SPEND_RECONCILED")
            item.cumulativeWorstCaseMicros = caseIndex * 20_511;
        }
      },
    ],
  ] as const)(
    "recomputes admission and spend from raw bytes rather than trusting adjusted ledger claims: %s",
    (_label, mutate) => {
      const captured = capturedAttemptFixture();
      expect(capturedAttemptAuthority().verifyAttemptLedger(captured)).toBe(
        true,
      );

      mutate(captured.ledger);

      expect(() =>
        capturedAttemptAuthority().verifyAttemptLedger(captured),
      ).toThrow();
    },
  );

  describe("protected live-capture executable boundary", () => {
    it("local capture CLI is a fail-closed stub before attestation, auth, provider, output, or network", async () => {
      jest.resetModules();
      const attest = jest.fn();
      const providerFactory = jest.fn();
      const capture = jest.fn();
      const outputWriter = jest.fn();
      const outputPolicy = jest.fn(async () => undefined);
      jest.doMock("./quality-closure-attestation", () => ({
        assertOutputOutsideRepository: outputPolicy,
        qualityCaptureLockPath: jest.fn(
          async () => "/tmp/ocr-quality-global.lock",
        ),
        attestQualityClosure: attest.mockResolvedValue({
          policy: { marker: "policy" },
          closure: { version: 2, marker: "attested" },
        }),
        readFinalReviewHashes: jest.fn(async () => ({})),
        assertQualityRepositorySnapshot: jest.fn(async () => undefined),
      }));
      jest.doMock("../import-session/ocr/vertex-provider.factory", () => ({
        createConfiguredVertexPdfOcrProvider: providerFactory,
      }));
      jest.doMock("./capture-live-core", () => ({
        captureLiveEvidence: capture,
      }));
      jest.doMock("./capture-live-file", () => ({
        writeQualifiedLiveEvidenceExclusive: outputWriter,
      }));
      const previousArguments = process.argv;
      const previousExitCode = process.exitCode;
      process.argv = [
        process.execPath,
        "capture-live.ts",
        "/tmp/never-written.json",
      ];
      let complete!: (message: string) => void;
      const completed = new Promise<string>((resolve) => {
        complete = resolve;
      });
      const stderr = jest
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk) => {
          complete(String(chunk));
          return true;
        });
      try {
        jest.isolateModules(() => require("./capture-live"));
        await expect(completed).resolves.toBe(
          "LIVE_CAPTURE_PROTECTED_ENTRYPOINT_UNAVAILABLE\n",
        );
        expect(outputPolicy).not.toHaveBeenCalled();
        expect(attest).not.toHaveBeenCalled();
        expect(providerFactory).not.toHaveBeenCalled();
        expect(capture).not.toHaveBeenCalled();
        expect(outputWriter).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
        process.argv = previousArguments;
        process.exitCode = previousExitCode;
        jest.dontMock("./quality-closure-attestation");
        jest.dontMock("../import-session/ocr/vertex-provider.factory");
        jest.dontMock("./capture-live-core");
        jest.dontMock("./capture-live-file");
        jest.resetModules();
      }
    });

    it("[B3] decorative credential strings cannot invoke caller factories", async () => {
      const source = await readFile(join(__dirname, "capture-live.ts"), "utf8");
      const importSafeSource = source.replace(
        /\nvoid main\(\)\.catch[\s\S]*$/,
        "\n",
      );
      const javascript = ts.transpileModule(importSafeSource, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText;
      const moduleRecord: { exports: Record<string, unknown> } = {
        exports: {},
      };
      const outputWriter = jest.fn(async () => undefined);
      const requireStub = (id: string): unknown => {
        if (id === "node:path")
          return { resolve: (...parts: string[]) => join(...parts) };
        if (id === "./capture-live-file")
          return { writeQualifiedLiveEvidenceExclusive: outputWriter };
        if (id === "./quality-closure-attestation")
          return {
            assertOutputOutsideRepository: jest.fn(),
            assertQualityRepositorySnapshot: jest.fn(),
            attestQualityClosure: jest.fn(),
            qualityCaptureLockPath: jest.fn(),
            readFinalReviewHashes: jest.fn(),
          };
        return {};
      };
      runInNewContext(
        `(function (require, module, exports) { ${javascript}\n})`,
      )(requireStub, moduleRecord, moduleRecord.exports);
      const runner = moduleRecord.exports.runProtectedLiveCapture;
      const observation = {
        kind: typeof runner === "function" ? "READY" : "BOUNDARY_UNAVAILABLE",
        code: "LIVE_CAPTURE_PROTECTED_RUNNER_NOT_IMPLEMENTED",
      };

      expect(observation).toMatchObject({ kind: "READY" });
      expect(source).not.toContain(
        'throw new Error("LIVE_CAPTURE_BOUNDARY_RUNNER_UNAVAILABLE")',
      );
      if (typeof runner !== "function") throw new Error(observation.code);
      const missingDependencies = await (
        runner as (input: unknown) => Promise<unknown>
      )({}).then(
        () => null,
        (error: unknown) => error,
      );
      // The runner is constructed in an isolated VM realm, so its Error has a
      // different prototype. Match the stable semantic contract without
      // injecting outer-realm globals. Resolving after removal of the
      // fail-closed throw yields null and is mutation-locked by this assertion.
      expect({
        name: (missingDependencies as { name?: unknown } | null)?.name,
        message: (missingDependencies as { message?: unknown } | null)?.message,
      }).toEqual({
        name: "Error",
        message: "LIVE_CAPTURE_CREDENTIALS_MISSING",
      });

      const captureEvidence = jest.fn(async () => {
        throw new Error("CALLER_CAPTURE_MUST_NOT_RUN");
      });
      const verifyRepository = jest.fn(async () => {
        throw new Error("CALLER_REPOSITORY_CHECK_MUST_NOT_RUN");
      });
      const decorative = await (runner as (input: unknown) => Promise<unknown>)(
        {
          outputPath: "/tmp/band-3-must-not-exist.json",
          lockPath: "/tmp/band-3-must-not-exist.lock",
          credentials: {
            projectId: "plausible-project-id",
            serviceAccountPath: "/secrets/vertex-sa.json",
          },
          captureEvidence,
          verifyRepository,
        },
      ).then(
        () => null,
        (error: unknown) => error,
      );

      expect({
        name: (decorative as { name?: unknown } | null)?.name,
        message: (decorative as { message?: unknown } | null)?.message,
      }).toEqual({
        name: "Error",
        message: "LIVE_CAPTURE_PROTECTED_CONTEXT_UNAVAILABLE",
      });
      expect(captureEvidence).not.toHaveBeenCalled();
      expect(verifyRepository).not.toHaveBeenCalled();
      expect(outputWriter).not.toHaveBeenCalled();
    });
  });

  it.each([
    [
      "generation before admission",
      (events: Array<Record<string, any>>) => {
        [events[2], events[3]] = [events[3]!, events[2]!];
      },
    ],
    [
      "duplicate admission",
      (events: Array<Record<string, any>>) => {
        events.splice(3, 0, structuredClone(events[2]!));
      },
    ],
    [
      "missing count response",
      (events: Array<Record<string, any>>) => {
        events.splice(1, 1);
      },
    ],
    [
      "sequence reset",
      (events: Array<Record<string, any>>) => {
        events[6]!.sequence = 1;
      },
    ],
  ] as const)("rejects %s", (_label, mutate) => {
    const evidence = capturedAttemptFixture();
    mutate(evidence.ledger);

    expect(() =>
      capturedAttemptAuthority().verifyAttemptLedger(evidence),
    ).toThrow("ATTEMPT_LEDGER_ORDER_INVALID");
  });

  it("rejects a spend reset between cases", () => {
    const evidence = capturedAttemptFixture();
    const secondAdmission = evidence.ledger.find(
      (event) =>
        event.caseId === "scan-002" && event.kind === "ADMISSION_DECISION",
    )!;
    secondAdmission.spentKnownBeforeMicros = 0;

    expect(() =>
      capturedAttemptAuthority().verifyAttemptLedger(evidence),
    ).toThrow("CUMULATIVE_SPEND_MISMATCH");
  });

  it("rejects any generation event after terminal spend rejection", () => {
    const evidence = capturedAttemptFixture();
    evidence.ledger = evidence.ledger.slice(0, 3);
    Object.assign(evidence.ledger[2]!, {
      spentKnownBeforeMicros: 479_491,
      cumulativeWorstCaseMicros: 500_001,
      decision: "CAPTURE_SPEND_LIMIT",
    });
    evidence.ledger.push({
      ...evidence.ledger[2]!,
      sequence: 4,
      kind: "GENERATION_REQUEST",
      requestBodySha256: "c".repeat(64),
    });

    expect(() =>
      capturedAttemptAuthority().verifyAttemptLedger(evidence),
    ).toThrow("GENERATION_AFTER_REJECTION");
  });
});
