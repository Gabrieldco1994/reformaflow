import { mkdtemp, readFile, stat, symlink } from "node:fs/promises";
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
} from "./evaluator";
import { artifactSha256, generateArtifact } from "./fixture-generator";
import {
  parseLiveEvidence,
  parseLiveEvidenceJson,
} from "./live-evidence-parser";

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
) {
  let index = 0;
  const fetcher = jest.fn(async () => {
    const testCase = OCR_SYNTH_SCANNED_RELEASE_CASES[index]!;
    const rows = successfulRows(testCase);
    const current = index++;
    return response({
      responseId: responseIds?.[current] ?? `response-${testCase.id}`,
      modelVersion: versions[current] ?? versions[0],
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              {
                text: JSON.stringify({
                  candidates: rows.map((row) => ({
                    pageNumber: row.page,
                    description: row.description,
                    amountCents: row.amountCents,
                    amountMeaning: row.amountMeaning,
                    date:
                      row.normalizedDate &&
                      /^\d{4}-\d{2}-\d{2}$/.test(row.normalizedDate)
                        ? row.normalizedDate
                        : null,
                    installment:
                      row.installmentCurrent !== null &&
                      row.installmentTotal !== null
                        ? {
                            index: row.installmentCurrent,
                            total: row.installmentTotal,
                          }
                        : null,
                    evidenceText: row.evidenceText,
                  })),
                }),
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
      { accessToken: async () => "test-only-adc-token" },
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
  for (const probe of safetyProbes)
    probe.source = "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED";
  return {
    candidateSha: SHA,
    configurationSha256: "a".repeat(64),
    adapterSha256: "b".repeat(64),
    declaredLimits: {
      maxP95LatencyMs: 30_000,
      maxTotalCostMicros: 1_000_000,
      maxRequestBodyBytes: 20_000_000,
      maxProviderDeadlineMs: 30_000,
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
      source: "test pricing",
      effectiveDate: "2026-10-13",
      inputMicrosPerMillionTokens: 1_000_000,
      outputMicrosPerMillionTokens: 1_000_000,
    },
    routingCases,
    safetyProbes,
  };
}

describe("audited synthetic Vertex capture", () => {
  let evidence: Awaited<ReturnType<typeof captureLiveEvidence>>;

  beforeAll(async () => {
    const adapter = provider();
    const extract = jest.spyOn(adapter.value, "extractPdf");
    evidence = await captureLiveEvidence({
      provider: adapter.value,
      manifest: await manifest(),
      currentRepoSha: SHA,
      memoryRss: () => 100,
    });
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
    });
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

  it("strictly parses evidence and rejects extra, missing, duplicate, and byte fields", () => {
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
    expect(() =>
      parseLiveEvidenceJson(
        JSON.stringify(evidence).replace(
          '"datasetVersion":',
          '"datasetVersion":"duplicate","datasetVersion":',
        ),
      ),
    ).toThrow("LIVE_EVIDENCE_INVALID");
  });

  it("writes mode 0600 exclusively without following links and cleans failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ocr-live-"));
    const output = join(directory, "evidence.json");
    await writeLiveEvidenceExclusive(output, evidence);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const serialized = await readFile(output, "utf8");
    expect(serialized).not.toContain("test-only-adc-token");
    expect(serialized).not.toContain("%PDF-");
    await expect(
      writeLiveEvidenceExclusive(output, evidence),
    ).rejects.toBeDefined();

    const target = join(directory, "target.json");
    const link = join(directory, "link.json");
    await symlink(target, link);
    await expect(
      writeLiveEvidenceExclusive(link, evidence),
    ).rejects.toBeDefined();

    const concurrent = join(directory, "concurrent.json");
    const writes = await Promise.allSettled([
      writeLiveEvidenceExclusive(concurrent, evidence),
      writeLiveEvidenceExclusive(concurrent, evidence),
    ]);
    expect(writes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );

    const failed = join(directory, "failed.json");
    await expect(
      writeLiveEvidenceExclusive(failed, evidence, async () => {
        throw new Error("simulated");
      }),
    ).rejects.toThrow("simulated");
    await expect(stat(failed)).rejects.toBeDefined();
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
