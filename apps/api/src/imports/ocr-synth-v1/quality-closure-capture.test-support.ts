import { VertexPdfOcrProvider } from "../import-session/ocr/vertex-pdf-ocr.provider";
import { OCR_SYNTH_SCANNED_RELEASE_CASES, successfulRows } from "./corpus";
import {
  buildOracleRoutingCases,
  buildOracleSafetyProbes,
  type OcrEvalRunConfig,
} from "./evaluator";
import type { CaptureLiveManifest } from "./capture-live-core";
import policy from "./quality-closure-policy.json";

export const CAPTURE_TEST_SHA = "c".repeat(40);
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

export function buildCaptureProvider() {
  let index = 0;
  const fetcher = jest.fn(async () => {
    const testCase = OCR_SYNTH_SCANNED_RELEASE_CASES[index++]!;
    const rows = successfulRows(testCase);
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
    const terminal =
      testCase.id === "scan-012"
        ? "INCOMPLETE"
        : testCase.id === "scan-018"
          ? "OCCURRENCE_LIMIT_EXCEEDED"
          : null;
    const payload =
      terminal === null
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
            completionStatus: terminal,
            reportedPageCount: testCase.artifact.pageCount,
            pageAccounting: Array.from(
              { length: testCase.artifact.pageCount },
              (_, pageIndex) => ({
                pageNumber: pageIndex + 1,
                status:
                  terminal === "INCOMPLETE" && pageIndex === 1
                    ? "UNREADABLE"
                    : terminal === "OCCURRENCE_LIMIT_EXCEEDED" &&
                        pageIndex === 0
                      ? "READABLE"
                      : "EMPTY",
                visibleOccurrenceCount:
                  terminal === "OCCURRENCE_LIMIT_EXCEEDED" && pageIndex === 0
                    ? 25
                    : 0,
              }),
            ),
            candidates: [],
          };
    return response({
      responseId: `response-${testCase.id}`,
      modelVersion: VERSION,
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: JSON.stringify(payload) }] },
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
    provider: new VertexPdfOcrProvider(
      "synthetic-eval-project",
      {
        authTrace: "SERVICE_ACCOUNT_FILE_ADC",
        accessToken: async () => "test-only-adc-token",
      },
      fetcher,
    ),
  };
}

export async function buildCaptureManifest(): Promise<CaptureLiveManifest> {
  const routingCases = await buildOracleRoutingCases();
  for (const route of routingCases) {
    route.source = "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED";
    route.testFile = SERVICE_EVIDENCE_TEST;
  }
  const safetyProbes = buildOracleSafetyProbes();
  for (const probe of safetyProbes) {
    probe.source = "REAL_SERVICE_TEST_WITH_EXTERNAL_MODEL_MOCKED";
    if (SERVICE_CONTEXT_PROBES.has(probe.id))
      probe.testFile = SERVICE_EVIDENCE_TEST;
  }
  const declaredLimits: OcrEvalRunConfig["declaredLimits"] = {
    maxP95LatencyMs: policy.maxP95LatencyMs,
    maxTotalCostMicros: policy.maxTotalCostMicros,
    maxRequestBodyBytes: policy.maxRequestBodyBytes,
    maxProviderDeadlineMs: policy.maxProviderDeadlineMs,
  };
  return {
    candidateSha: CAPTURE_TEST_SHA,
    configurationSha256: "a".repeat(64),
    adapterSha256: "b".repeat(64),
    declaredLimits,
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
