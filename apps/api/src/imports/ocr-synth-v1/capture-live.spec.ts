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
import { PDF_OCR_MODEL_ID, PDF_OCR_PROVIDER_ID } from "@reformaflow/domain";
import { VertexPdfOcrProvider } from "../import-session/ocr/vertex-pdf-ocr.provider";
import { captureLiveEvidence } from "./capture-live-core";
import * as captureLiveCore from "./capture-live-core";
import { writeLiveEvidenceExclusive } from "./capture-live-file";
import {
  OCR_SYNTH_ROUTING_CASES,
  OCR_SYNTH_SCANNED_RELEASE_CASES,
  successfulRows,
} from "./corpus";
import { evaluateOcrSynth, type OcrEvalInput } from "./evaluator";
import { artifactSha256, generateArtifact } from "./fixture-generator";
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
  const fetcher = jest.fn(async () => {
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
        amountMeaning: row.amountMeaning,
        date:
          row.normalizedDate && /^\d{4}-\d{2}-\d{2}$/.test(row.normalizedDate)
            ? row.normalizedDate
            : null,
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
  return {
    fetcher,
    value: new VertexPdfOcrProvider(
      "synthetic-eval-project",
      {
        authTrace: "SERVICE_ACCOUNT_FILE_ADC",
        accessToken: async () => "test-only-adc-token",
      },
      fetcher,
    ),
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
  let dispatchedRequestIds: string[];
  let platform: PropertyDescriptor;

  beforeAll(async () => {
    platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", {
      ...platform,
      value: "linux",
    });

    const adapter = provider();
    const extract = jest.spyOn(adapter.value, "extractPdf");
    evidence = await captureLiveEvidence(
      canonicalCaptureOptions(adapter.value, { memoryRss: () => 100 }),
    );
    dispatchedRequestIds = extract.mock.calls.map(
      ([request]) => request.requestId,
    );
    expect(extract).toHaveBeenCalledTimes(18);
    expect(adapter.fetcher).toHaveBeenCalledTimes(18);
  });
  afterAll(() => Object.defineProperty(process, "platform", platform));

  it("calls the real adapter once for each literal scanned case only", () => {
    expect(evidence.predictions.map((item) => item.caseId)).toEqual(
      OCR_SYNTH_SCANNED_RELEASE_CASES.map((item) => item.id),
    );
    expect(evidence.routingCases).toHaveLength(OCR_SYNTH_ROUTING_CASES.length);
    expect(
      evidence.routingCases.every((item) => item.providerCalls === 0),
    ).toBe(true);
    const dense = evidence.predictions.find(
      (item) => item.caseId === "scan-010",
    )!;
    expect(
      dense.outcome.kind === "SUCCESS" && "candidates" in dense.outcome
        ? dense.outcome.candidates
        : [],
    ).toHaveLength(24);
  });

  it("captures all 18 expected outcomes with one dispatch each and no terminal retry", async () => {
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
    expect(adapter.fetcher).toHaveBeenCalledTimes(18);
    expect(
      captured.predictions.map((item) => item.adapterTrace?.providerCallCount),
    ).toEqual(Array.from({ length: 18 }, () => 1));
    expect(
      captured.predictions.map((item) => item.adapterTrace?.attempts),
    ).toEqual(Array.from({ length: 18 }, () => 1));
  });

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
    expect(adapter.fetcher).toHaveBeenCalledTimes(18);
  });

  it("emits only provider-native outcome fields and derives sign locally", () => {
    const serialized = JSON.stringify(evidence.predictions[0]!.outcome);
    for (const forbidden of [
      "bbox",
      "rowId",
      "amountText",
      "dateText",
      "selected",
      "verificationStatus",
    ])
      expect(serialized).not.toContain(`"${forbidden}"`);
    expect(serialized).toContain('"sign"');
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
      expect(adapter.fetcher).toHaveBeenCalledTimes(driftAt);
      expect(verifySnapshot).toHaveBeenCalledTimes(driftAt);
    }
  });

  it("stops on duplicate response IDs or mixed model versions", async () => {
    const duplicate = provider([VERSION], ["same-response", "same-response"]);
    await expect(
      captureLiveEvidence(canonicalCaptureOptions(duplicate.value)),
    ).rejects.toThrow("LIVE_CAPTURE_PROVENANCE_MISMATCH");
    expect(duplicate.fetcher).toHaveBeenCalledTimes(2);

    const mixed = provider([VERSION, "gemini-other-version"]);
    await expect(
      captureLiveEvidence(canonicalCaptureOptions(mixed.value)),
    ).rejects.toThrow("LIVE_CAPTURE_PROVENANCE_MISMATCH");
    expect(mixed.fetcher).toHaveBeenCalledTimes(2);
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
      expect(adapter.fetcher).toHaveBeenCalledTimes(1);
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
    const changed = structuredClone(evidence);
    changed.safetyProbes.find(
      (probe) => probe.id === "EXACT_CONSENT_CAPABILITY",
    )!.testFile =
      "apps/api/src/imports/ocr-synth-v1/direct-pdf-vertex-safety.spec.ts";
    const report = await evaluateOcrSynth(changed);
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

  it("keeps generated route evidence bound to the same synthetic bytes", async () => {
    for (const route of evidence.routingCases) {
      const testCase = OCR_SYNTH_ROUTING_CASES.find(
        (item) => item.id === route.caseId,
      )!;
      expect(route.artifactSha256).toBe(
        artifactSha256(await generateArtifact(testCase)),
      );
    }
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

function generationResponseBytes() {
  return Buffer.from(
    JSON.stringify({
      responseId: "response-scan-001",
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

function admittedLedgerCase(caseId: string, sequenceStart: number) {
  const countBytes = countTokensResponse();
  const generationBytes = generationResponseBytes();
  const common = {
    runId: "qualification-run-1001",
    runAttempt: 1,
    caseId,
    requestId: `request-${caseId}`,
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
      spentKnownBeforeMicros: sequenceStart === 1 ? 0 : 20_510,
      worstCaseCurrentMicros: 20_510,
      cumulativeWorstCaseMicros: sequenceStart === 1 ? 20_510 : 41_020,
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
      cumulativeMeasuredMicros: sequenceStart === 1 ? 80 : 160,
      cumulativeWorstCaseMicros: sequenceStart === 1 ? 20_510 : 41_020,
    },
  ] as Array<Record<string, any>>;
}

function capturedAttemptFixture() {
  return {
    runId: "qualification-run-1001",
    runAttempt: 1,
    ledger: [
      ...admittedLedgerCase("scan-001", 1),
      ...admittedLedgerCase("scan-002", 7),
    ],
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
