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
import {
  captureLiveEvidence,
  type CaptureLiveManifest,
} from "./capture-live-core";
import { writeLiveEvidenceExclusive } from "./capture-live-file";
import {
  OCR_SYNTH_ROUTING_CASES,
  OCR_SYNTH_SCANNED_RELEASE_CASES,
  successfulRows,
} from "./corpus";
import {
  buildOracleRoutingCases,
  buildOracleSafetyProbes,
  evaluateOcrSynth,
  type OcrEvalInput,
} from "./evaluator";
import { artifactSha256, generateArtifact } from "./fixture-generator";
import {
  parseLiveEvidence,
  parseLiveEvidenceJson,
} from "./live-evidence-parser";
import policy from "./quality-closure-policy.json";

jest.setTimeout(120_000);

const SHA = "c".repeat(40);
const VERSION = "gemini-2.5-flash-001";
const SERVICE_EVIDENCE_TEST =
  "apps/api/src/imports/import-session/ocr/pdf-ocr-analyze.integration.spec.ts";
const SERVICE_CONTEXT_PROBES = new Set([
  "EXACT_CONSENT_CAPABILITY",
  "PRIOR_CONSENT_DECLARATION",
  "MISSING_CONSENT",
  "MISSING_ATTESTATION",
  "SELECTED_TRUE_DEFAULT",
  "VERIFIED_DEFAULT",
]);

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

async function manifest(): Promise<CaptureLiveManifest> {
  const routingCases = await buildOracleRoutingCases();
  for (const route of routingCases) {
    route.source = "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED";
    route.testFile =
      "apps/api/src/imports/import-session/ocr/pdf-ocr-analyze.integration.spec.ts";
  }
  const safetyProbes = buildOracleSafetyProbes();
  for (const probe of safetyProbes) {
    probe.source = "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED";
    if (SERVICE_CONTEXT_PROBES.has(probe.id))
      probe.testFile = SERVICE_EVIDENCE_TEST;
  }
  return {
    candidateSha: SHA,
    configurationSha256: "a".repeat(64),
    adapterSha256: "b".repeat(64),
    declaredLimits: {
      maxP95LatencyMs: policy.maxP95LatencyMs,
      maxTotalCostMicros: policy.maxTotalCostMicros,
      maxRequestBodyBytes: policy.maxRequestBodyBytes,
      maxProviderDeadlineMs: policy.maxProviderDeadlineMs,
    },
    durableBudgets: {
      policySha256: "d".repeat(64),
      tenantLimitMicros: 1_000_000,
      globalLimitMicros: 2_000_000,
      storage: "DATABASE",
    },
    residualRiskAcceptance: {
      decision: "OPTION_1_COMPLETE_ORIGINAL_PDF",
      dataOwnerAcceptanceSha256: "e".repeat(64),
      noLocalDerivative: true,
    },
    finalReviews: {
      securityReviewSha256: "1".repeat(64),
      privacyReviewSha256: "2".repeat(64),
      dataOwnerReviewSha256: "3".repeat(64),
    },
    pricing: {
      source: policy.pricing.source,
      effectiveDate: policy.pricing.observedOn,
      inputMicrosPerMillionTokens: policy.pricing.inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens: policy.pricing.outputMicrosPerMillionTokens,
    },
    routingCases,
    safetyProbes,
  };
}

describe("audited synthetic Vertex capture", () => {
  let evidence: Awaited<ReturnType<typeof captureLiveEvidence>>;
  let dispatchedRequestIds: string[];

  beforeAll(async () => {
    const adapter = provider();
    const extract = jest.spyOn(adapter.value, "extractPdf");
    evidence = await captureLiveEvidence({
      provider: adapter.value,
      manifest: await manifest(),
      currentRepoSha: SHA,
      memoryRss: () => 100,
    });
    dispatchedRequestIds = extract.mock.calls.map(
      ([request]) => request.requestId,
    );
    expect(extract).toHaveBeenCalledTimes(18);
    expect(adapter.fetcher).toHaveBeenCalledTimes(18);
  });

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
    const captured = await captureLiveEvidence({
      provider: adapter.value,
      manifest: await manifest(),
      currentRepoSha: SHA,
      memoryRss: () => 256_000_000,
    });

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
      captureLiveEvidence({
        provider: adapter.value,
        manifest: await manifest(),
        currentRepoSha: SHA,
        readProcSelfStatus: async () => {
          throw new Error("proc unavailable");
        },
      } as Parameters<typeof captureLiveEvidence>[0]),
    ).rejects.toThrow("LIVE_CAPTURE_VMHWM_UNAVAILABLE");
    expect(adapter.fetcher).not.toHaveBeenCalled();
  });

  it("records one pre-dispatch and eighteen post-response Linux VmHWM checkpoints", async () => {
    const adapter = provider();
    const readProcSelfStatus = jest.fn(
      async (_path: string) => "Name:\tnode\nVmHWM:\t524288 kB\n",
    );
    const captured = await captureLiveEvidence({
      provider: adapter.value,
      manifest: await manifest(),
      currentRepoSha: SHA,
      readProcSelfStatus,
    } as Parameters<typeof captureLiveEvidence>[0]);

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

  it("fails preflight with zero calls on repository drift or cross-contract routing", async () => {
    const adapter = provider();
    await expect(
      captureLiveEvidence({
        provider: adapter.value,
        manifest: await manifest(),
        currentRepoSha: "f".repeat(40),
      }),
    ).rejects.toThrow("LIVE_CAPTURE_PREFLIGHT_FAILED");
    const crossed = await manifest();
    crossed.routingCases[0]!.tenantId = "other-tenant";
    await expect(
      captureLiveEvidence({
        provider: adapter.value,
        manifest: crossed,
        currentRepoSha: SHA,
      }),
    ).rejects.toThrow("LIVE_CAPTURE_PREFLIGHT_FAILED");
    expect(adapter.fetcher).not.toHaveBeenCalled();
  });

  it("stops on duplicate response IDs or mixed model versions", async () => {
    const duplicate = provider([VERSION], ["same-response", "same-response"]);
    await expect(
      captureLiveEvidence({
        provider: duplicate.value,
        manifest: await manifest(),
        currentRepoSha: SHA,
      }),
    ).rejects.toThrow("LIVE_CAPTURE_PROVENANCE_MISMATCH");
    expect(duplicate.fetcher).toHaveBeenCalledTimes(2);

    const mixed = provider([VERSION, "gemini-other-version"]);
    await expect(
      captureLiveEvidence({
        provider: mixed.value,
        manifest: await manifest(),
        currentRepoSha: SHA,
      }),
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
        captureLiveEvidence({
          provider: adapter.value,
          manifest: await manifest(),
          currentRepoSha: SHA,
        }),
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
