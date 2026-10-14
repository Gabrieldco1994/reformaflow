import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OCR_SYNTH_SCANNED_RELEASE_CASES, successfulRows } from "./corpus";
import { artifactSha256, generateArtifact } from "./fixture-generator";

const MODULE_PATH = "./baseline-candidate-report";
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type ReportModule = Readonly<{
  evaluateBaselineCandidateReport(input: unknown): unknown;
  parseBaselineCandidateReport(input: unknown): unknown;
  assessActivationAuthority(input: unknown): Promise<Record<string, any>>;
  verifyBaselineArtifactV4(input: unknown): Promise<unknown>;
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
    typeof loaded.parseBaselineCandidateReport !== "function" ||
    typeof loaded.assessActivationAuthority !== "function" ||
    typeof loaded.verifyBaselineArtifactV4 !== "function"
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

  const CANONICAL_CASE_IDS = Array.from(
    { length: 18 },
    (_, index) => `scan-${String(index + 1).padStart(3, "0")}`,
  );
  const DATASET_VERSION = "ocr-synth-v1-direct-pdf-vertex-v3";
  const CORPUS_SHA256 = sha256("pinned-ground-truth-v4");

  async function canonicalRecords() {
    return Promise.all(
      OCR_SYNTH_SCANNED_RELEASE_CASES.map(async (testCase) => {
        const rows = successfulRows(testCase).map((row, index) => ({
          pageNumber: row.page,
          pageOccurrenceIndex: index + 1,
          description: row.description,
          amountCents: row.amountCents,
          sign: row.sign,
          amountMeaning: row.amountMeaning,
          rawDate: row.dateText,
          normalizedDate: row.normalizedDate,
          dateExplicitness: row.dateExplicitness,
          installment:
            row.installmentCurrent === null || row.installmentTotal === null
              ? null
              : {
                  index: row.installmentCurrent,
                  total: row.installmentTotal,
                },
          installmentMeaning: row.installmentMeaning,
          evidenceText: row.evidenceText,
          selected: false,
          verificationStatus: "UNVERIFIED",
          candidateDisposition: "RAW_UNCLASSIFIED",
        }));
        return {
          caseId: testCase.id,
          tenantId: testCase.tenantId,
          artifactSha256: artifactSha256(await generateArtifact(testCase)),
          outcome:
            testCase.expected.kind === "ERROR"
              ? structuredClone(testCase.expected)
              : {
                  kind: "SUCCESS",
                  terminalCode: null,
                  candidates: rows,
                },
          financialWrites: 0,
          latencyMs: 30_000,
          peakRssBytes: 536_870_912,
        };
      }),
    );
  }

  async function canonicalAuthorityFixture() {
    const records = await canonicalRecords();
    return {
      evidenceClass: "LIVE",
      datasetVersion: DATASET_VERSION,
      corpusSha256: CORPUS_SHA256,
      groundTruth: structuredClone(records),
      baseline: {
        records: structuredClone(records),
        provenance: { kind: "GITHUB_ARTIFACT_V4" },
      },
      candidate: {
        records: structuredClone(records),
        provenance: { kind: "GITHUB_ARTIFACT_V4" },
      },
    };
  }

  function successfulCandidate(
    input: Awaited<ReturnType<typeof canonicalAuthorityFixture>>,
    caseId: string,
    rowIndex = 0,
  ) {
    const record = input.candidate.records.find(
      (candidate) => candidate.caseId === caseId,
    );
    if (!record || record.outcome.kind !== "SUCCESS")
      throw new Error("CANONICAL_SUCCESS_FIXTURE_INVALID");
    return record.outcome.candidates[rowIndex]!;
  }

  function authority(): Pick<
    ReportModule,
    "assessActivationAuthority" | "verifyBaselineArtifactV4"
  > {
    const loaded = loadReportBoundary();
    expect(loaded).toMatchObject({ kind: "READY" });
    if (loaded.kind !== "READY") throw new Error(loaded.code);
    return loaded.value;
  }

  function canonicalArtifactMember(records: unknown) {
    return Buffer.from(
      JSON.stringify({
        datasetVersion: DATASET_VERSION,
        corpusSha256: CORPUS_SHA256,
        records,
      }),
    );
  }

  async function githubBaselineArtifactFixture() {
    const records = await canonicalRecords();
    const member = canonicalArtifactMember(records);
    const archive = Buffer.from("deterministic-github-artifact-v4-archive");
    return {
      expected: {
        repositoryId: 123_456,
        workflowPath: ".github/workflows/ocr-qualification.yml",
        workflowRunId: 9_001,
        workflowRunAttempt: 1,
        artifactId: 7_001,
        artifactName: "ocr-baseline-9001-1",
        workflowSha: "a".repeat(40),
        workflowHeadSha: "b".repeat(40),
        workflowHeadTree: "c".repeat(40),
        baselineSubjectSha: "d".repeat(40),
        baselineSubjectTree: "e".repeat(40),
        baselineExecutableSha256: "f".repeat(64),
        corpusSha256: CORPUS_SHA256,
        datasetVersion: DATASET_VERSION,
        caseIds: CANONICAL_CASE_IDS,
        artifactSha256ByCase: Object.fromEntries(
          records.map((record) => [record.caseId, record.artifactSha256]),
        ),
        memberName: "baseline.json",
      },
      metadata: {
        id: 7_001,
        name: "ocr-baseline-9001-1",
        expired: false,
        digest: `sha256:${sha256(archive.toString("binary"))}`,
        workflow_run: {
          id: 9_001,
          head_sha: "b".repeat(40),
        },
      },
      archiveBytes: archive,
      members: [{ name: "baseline.json", bytes: member }],
      payload: {
        workflowPath: ".github/workflows/ocr-qualification.yml",
        workflowSha: "a".repeat(40),
        workflowHeadTree: "c".repeat(40),
        subjectSha: "d".repeat(40),
        subjectTree: "e".repeat(40),
        executableSha256: "f".repeat(64),
        corpusSha256: CORPUS_SHA256,
        datasetVersion: DATASET_VERSION,
        records,
      },
    };
  }

  describe("canonical OCR V4 application authority", () => {
    it("rejects eighteen invented SUCCESS identities instead of treating count as corpus identity", async () => {
      const input = await canonicalAuthorityFixture();
      input.candidate.records = input.candidate.records.map(
        (record, index) => ({
          ...record,
          caseId: `case-${String(index + 1).padStart(2, "0")}`,
        }),
      );

      await expect(
        authority().assessActivationAuthority(input),
      ).resolves.toMatchObject({
        reportSchemaVersion: 4,
        releaseStatus: "GAPS",
        signable: false,
        issues: ["CASE_IDENTITY_INVALID"],
      });
    });

    it.each([
      ["amount cents", "amountCents", "2", "MONEY_MISMATCH"],
      ["sign", "sign", "NEGATIVE", "SIGN_MISMATCH"],
      ["date", "normalizedDate", "2026-10-14", "DATE_MISMATCH"],
      [
        "date explicitness",
        "dateExplicitness",
        "YEARLESS",
        "DATE_EXPLICITNESS_MISMATCH",
      ],
      [
        "installment",
        "installment",
        { index: 2, total: 2 },
        "INSTALLMENT_MISMATCH",
      ],
      [
        "installment meaning",
        "installmentMeaning",
        "UNKNOWN",
        "INSTALLMENT_MEANING_INVENTED",
      ],
      ["amount meaning", "amountMeaning", "UNKNOWN", "AMOUNT_MEANING_INVENTED"],
      [
        "visible evidence",
        "evidenceText",
        "invented evidence",
        "VISIBLE_EVIDENCE_MISMATCH",
      ],
    ] as const)(
      "derives GAPS from mutated %s rather than equal caller outcome",
      async (_label, field, value, code) => {
        const input = await canonicalAuthorityFixture();
        const row = successfulCandidate(input, "scan-001");
        (row as Record<string, unknown>)[field] = value;

        const assessment = await authority().assessActivationAuthority(input);

        expect(assessment.releaseStatus).toBe("GAPS");
        expect(assessment.signable).toBe(false);
        expect(assessment.issues).toContain(code);
        expect(assessment.report.regressions).toContainEqual({
          caseId: "scan-001",
          issues: expect.arrayContaining([code]),
        });
      },
    );

    it.each([
      [
        "omitted row",
        (input: Awaited<ReturnType<typeof canonicalAuthorityFixture>>) => {
          const record = input.candidate.records.find(
            ({ caseId }) => caseId === "scan-001",
          )!;
          if (record.outcome.kind === "SUCCESS") record.outcome.candidates = [];
        },
        "OMITTED_ROW",
      ],
      [
        "invented row",
        (input: Awaited<ReturnType<typeof canonicalAuthorityFixture>>) => {
          const record = input.candidate.records.find(
            ({ caseId }) => caseId === "scan-001",
          )!;
          if (record.outcome.kind === "SUCCESS")
            record.outcome.candidates.push(
              structuredClone(record.outcome.candidates[0]!),
            );
        },
        "INVENTED_ROW",
      ],
      [
        "tenant substitution",
        (input: Awaited<ReturnType<typeof canonicalAuthorityFixture>>) => {
          input.candidate.records[0]!.tenantId = "tenant-synthetic-b";
        },
        "TENANT_BINDING_MISMATCH",
      ],
      [
        "selected automation",
        (input: Awaited<ReturnType<typeof canonicalAuthorityFixture>>) => {
          successfulCandidate(input, "scan-001").selected = true;
        },
        "UNSAFE_CANDIDATE_DEFAULT",
      ],
      [
        "verified automation",
        (input: Awaited<ReturnType<typeof canonicalAuthorityFixture>>) => {
          successfulCandidate(input, "scan-001").verificationStatus =
            "VERIFIED";
        },
        "UNSAFE_CANDIDATE_DEFAULT",
      ],
      [
        "classified automation",
        (input: Awaited<ReturnType<typeof canonicalAuthorityFixture>>) => {
          successfulCandidate(input, "scan-001").candidateDisposition =
            "AUTO_ACCEPTED";
        },
        "PROMPT_FINANCIAL_DECISION",
      ],
      [
        "financial write",
        (input: Awaited<ReturnType<typeof canonicalAuthorityFixture>>) => {
          input.candidate.records[0]!.financialWrites = 1;
        },
        "FINANCIAL_WRITE",
      ],
    ] as const)(
      "rejects %s hidden behind equal SUCCESS",
      async (_label, mutate, code) => {
        const input = await canonicalAuthorityFixture();
        mutate(input);

        const assessment = await authority().assessActivationAuthority(input);

        expect(assessment).toMatchObject({
          reportSchemaVersion: 4,
          releaseStatus: "GAPS",
          signable: false,
          issues: expect.arrayContaining([code]),
        });
      },
    );

    it.each([
      ["latency", "latencyMs", 30_000, "PASS"],
      ["latency", "latencyMs", 30_001, "LATENCY_LIMIT_NOT_MET"],
      ["RSS", "peakRssBytes", 536_870_912, "PASS"],
      ["RSS", "peakRssBytes", 536_870_913, "RSS_LIMIT_NOT_MET"],
    ] as const)(
      "enforces exact %s boundary %i",
      async (_label, field, value, expected) => {
        const input = await canonicalAuthorityFixture();
        for (const record of input.candidate.records) record[field] = value;

        const assessment = await authority().assessActivationAuthority(input);

        if (expected === "PASS") {
          expect(assessment.issues).not.toContain("LATENCY_LIMIT_NOT_MET");
          expect(assessment.issues).not.toContain("RSS_LIMIT_NOT_MET");
        } else {
          expect(assessment.releaseStatus).toBe("GAPS");
          expect(assessment.issues).toContain(expected);
        }
      },
    );

    it("binds both sides to exact ordered IDs, corpus, tenant and generated PDF hashes", async () => {
      const input = await canonicalAuthorityFixture();
      const assessment = await authority().assessActivationAuthority(input);

      expect(input.baseline.records.map(({ caseId }) => caseId)).toEqual(
        CANONICAL_CASE_IDS,
      );
      expect(input.candidate.records.map(({ caseId }) => caseId)).toEqual(
        CANONICAL_CASE_IDS,
      );
      expect(assessment.report).toMatchObject({
        reportSchemaVersion: 4,
        datasetVersion: DATASET_VERSION,
        bindings: { corpusSha256: CORPUS_SHA256 },
      });
    });

    it("metadata-only baseline yields exactly MISSING_BASELINE_EXECUTION", async () => {
      const input = await canonicalAuthorityFixture();
      input.baseline = {
        provenance: input.baseline.provenance,
      } as typeof input.baseline;

      await expect(
        authority().assessActivationAuthority(input),
      ).resolves.toMatchObject({
        releaseStatus: "GAPS",
        signable: false,
        issues: ["MISSING_BASELINE_EXECUTION"],
      });
    });

    it.each([
      [
        "archive digest",
        (
          fixture: Awaited<ReturnType<typeof githubBaselineArtifactFixture>>,
        ) => {
          fixture.metadata.digest = `sha256:${"0".repeat(64)}`;
        },
      ],
      [
        "artifact id",
        (
          fixture: Awaited<ReturnType<typeof githubBaselineArtifactFixture>>,
        ) => {
          fixture.metadata.id = 999_999;
        },
      ],
      [
        "workflow run",
        (
          fixture: Awaited<ReturnType<typeof githubBaselineArtifactFixture>>,
        ) => {
          fixture.metadata.workflow_run.id += 1;
        },
      ],
      [
        "head SHA",
        (
          fixture: Awaited<ReturnType<typeof githubBaselineArtifactFixture>>,
        ) => {
          fixture.metadata.workflow_run.head_sha = "0".repeat(40);
        },
      ],
      [
        "baseline tree",
        (
          fixture: Awaited<ReturnType<typeof githubBaselineArtifactFixture>>,
        ) => {
          fixture.payload.subjectTree = "0".repeat(40);
        },
      ],
      [
        "corpus",
        (
          fixture: Awaited<ReturnType<typeof githubBaselineArtifactFixture>>,
        ) => {
          fixture.payload.corpusSha256 = "0".repeat(64);
        },
      ],
      [
        "dataset",
        (
          fixture: Awaited<ReturnType<typeof githubBaselineArtifactFixture>>,
        ) => {
          fixture.payload.datasetVersion = "invented-dataset";
        },
      ],
      [
        "ordered identities",
        (
          fixture: Awaited<ReturnType<typeof githubBaselineArtifactFixture>>,
        ) => {
          fixture.payload.records.reverse();
        },
      ],
      [
        "generated PDF",
        (
          fixture: Awaited<ReturnType<typeof githubBaselineArtifactFixture>>,
        ) => {
          fixture.payload.records[0]!.artifactSha256 = "0".repeat(64);
        },
      ],
    ] as const)(
      "rejects externally resolved baseline artifact with altered %s",
      async (_label, mutate) => {
        const fixture = await githubBaselineArtifactFixture();
        mutate(fixture);

        await expect(
          authority().verifyBaselineArtifactV4(fixture),
        ).rejects.toThrow("BASELINE_ARTIFACT_PROVENANCE_INVALID");
      },
    );
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
