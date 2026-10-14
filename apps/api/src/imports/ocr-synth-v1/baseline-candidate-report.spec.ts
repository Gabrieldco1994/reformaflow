import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const MODULE_PATH = "./baseline-candidate-report";
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type ReportModule = Readonly<{
  evaluateBaselineCandidateReport(input: unknown): unknown;
  parseBaselineCandidateReport(input: unknown): unknown;
}>;

function loadReportBoundary():
  | { kind: "READY"; value: ReportModule }
  | {
      kind: "BOUNDARY_UNAVAILABLE";
      code: "BASELINE_CANDIDATE_REPORT_BOUNDARY_NOT_IMPLEMENTED";
    } {
  if (!existsSync(join(__dirname, "baseline-candidate-report.ts")))
    return {
      kind: "BOUNDARY_UNAVAILABLE",
      code: "BASELINE_CANDIDATE_REPORT_BOUNDARY_NOT_IMPLEMENTED",
    };
  const loaded = require(MODULE_PATH) as Partial<ReportModule>;
  if (
    typeof loaded.evaluateBaselineCandidateReport !== "function" ||
    typeof loaded.parseBaselineCandidateReport !== "function"
  )
    return {
      kind: "BOUNDARY_UNAVAILABLE",
      code: "BASELINE_CANDIDATE_REPORT_BOUNDARY_NOT_IMPLEMENTED",
    };
  return { kind: "READY", value: loaded as ReportModule };
}

function boundary(): ReportModule {
  const loaded = loadReportBoundary();
  expect(loaded).toMatchObject({ kind: "READY" });
  if (loaded.kind !== "READY") throw new Error(loaded.code);
  return loaded.value;
}

const caseRecords = Array.from({ length: 18 }, (_, index) => ({
  caseId: `scan-${String(index + 1).padStart(3, "0")}`,
  baseline: { outcome: "SUCCESS", artifactSha256: sha256(`base-${index}`) },
  candidate: {
    outcome: "SUCCESS",
    artifactSha256: sha256(`candidate-${index}`),
    modelVersion: "gemini-2.5-flash-001",
    amountMicros: 1_000,
  },
}));

const runtimeEnvelopeBytes = Buffer.from("signed-runtime-envelope-bytes");
const completeInput = Object.freeze({
  schemaVersion: 1,
  evidenceKind: "TEST_ONLY",
  baselineSha: "a".repeat(40),
  candidateSha: "b".repeat(40),
  corpusSha256: sha256("corpus"),
  policySha256: sha256("policy"),
  runtimeEnvelopeSha256: createHash("sha256")
    .update(runtimeEnvelopeBytes)
    .digest("hex"),
  activationSubjectSha256: sha256("activation-subject"),
  caseRecords,
});

describe("baseline by candidate release report", () => {
  it("requires exact per-case baseline and candidate execution records", () => {
    const report = boundary().parseBaselineCandidateReport(completeInput);

    expect(report).toMatchObject({ caseRecords });
    expect(report).not.toHaveProperty("baseline.metadataOnly", true);
  });

  it("rejects metadata-only baseline evidence", () => {
    expect(() =>
      boundary().parseBaselineCandidateReport({
        ...completeInput,
        caseRecords: undefined,
        baseline: { sha: "a".repeat(40), sampleCount: 18 },
      }),
    ).toThrow("MISSING_BASELINE_EXECUTION");
  });

  it("keeps TEST_ONLY fixtures at GAPS and never release PASS", () => {
    expect(
      boundary().evaluateBaselineCandidateReport(completeInput),
    ).toMatchObject({
      releaseStatus: "GAPS",
      issues: expect.arrayContaining([
        "MISSING_BASELINE_EXECUTION",
        "MISSING_LIVE_CANDIDATE_EXECUTION",
      ]),
    });
  });

  it("binds rich evidence to exact signed runtime envelope bytes", () => {
    expect(() =>
      boundary().parseBaselineCandidateReport({
        ...completeInput,
        runtimeEnvelopeSha256: sha256("different-runtime-envelope"),
        runtimeEnvelopeBytes,
      }),
    ).toThrow("RUNTIME_ENVELOPE_BINDING_MISMATCH");
  });

  it("rejects mixed activation and runtime subjects from different releases", () => {
    expect(() =>
      boundary().evaluateBaselineCandidateReport({
        ...completeInput,
        activationSubjectSha256: sha256("release-a"),
        runtimeActivationSubjectSha256: sha256("release-b"),
      }),
    ).toThrow("RELEASE_BINDING_MISMATCH");
  });

  it("remains GAPS when either real execution artifact is missing", () => {
    for (const missing of ["baselineExecution", "candidateExecution"]) {
      expect(
        boundary().evaluateBaselineCandidateReport({
          ...completeInput,
          evidenceKind: "LIVE",
          [missing]: null,
        }),
      ).toMatchObject({
        releaseStatus: "GAPS",
        issues: expect.arrayContaining([
          missing === "baselineExecution"
            ? "MISSING_BASELINE_EXECUTION"
            : "MISSING_LIVE_CANDIDATE_EXECUTION",
        ]),
      });
    }
  });
});
