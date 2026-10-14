import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { OCR_SYNTH_SCANNED_RELEASE_CASES, successfulRows } from "./corpus";
import { artifactSha256, generateArtifact } from "./fixture-generator";
import reportSchema from "./report.schema.json";

const MODULE_PATH = "./baseline-candidate-report";
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZipMember(name: string, bytes: Buffer): Buffer {
  const nameBytes = Buffer.from(name);
  const checksum = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + nameBytes.length + bytes.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, nameBytes, bytes, central, nameBytes, end]);
}

type ReportModule = Readonly<{
  evaluateBaselineCandidateReport(input: unknown): unknown;
  parseBaselineCandidateReport(input: unknown): unknown;
  assessActivationAuthority(input: unknown): Promise<Record<string, any>>;
  verifyBaselineArtifactV4(input: unknown): Promise<unknown>;
  deriveBaselineExpectationsV4(input?: unknown): Promise<Record<string, any>>;
  produceBaselineArtifactV4(input?: unknown): Promise<Record<string, any>>;
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
          dateText: row.dateText,
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

  function canonicalProducer(): Pick<
    ReportModule,
    "deriveBaselineExpectationsV4" | "produceBaselineArtifactV4"
  > {
    const loaded = require(MODULE_PATH) as Partial<ReportModule>;
    const observation = {
      kind:
        typeof loaded.deriveBaselineExpectationsV4 === "function" &&
        typeof loaded.produceBaselineArtifactV4 === "function"
          ? "READY"
          : "BOUNDARY_UNAVAILABLE",
      code: "CANONICAL_BASELINE_PRODUCER_NOT_IMPLEMENTED",
    };
    expect(observation).toMatchObject({ kind: "READY" });
    if (observation.kind !== "READY") throw new Error(observation.code);
    return loaded as ReportModule;
  }

  async function githubBaselineArtifactFixture() {
    const records = await canonicalRecords();
    const payload = {
      workflowPath: ".github/workflows/ocr-qualification.yml",
      workflowSha: "a".repeat(40),
      workflowHeadTree: "c".repeat(40),
      subjectSha: "d".repeat(40),
      subjectTree: "e".repeat(40),
      executableSha256: "f".repeat(64),
      corpusSha256: CORPUS_SHA256,
      datasetVersion: DATASET_VERSION,
      records,
    };
    const member = Buffer.from(JSON.stringify(payload));
    const archive = storedZipMember("baseline.json", member);
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
        digest: `sha256:${sha256(archive)}`,
        repository_id: 123_456,
        workflow_run: {
          id: 9_001,
          head_sha: "b".repeat(40),
          run_attempt: 1,
        },
      },
      archiveBytes: archive,
      members: [{ name: "baseline.json", bytes: member }],
      payload,
    };
  }

  async function canonicalRecomputationFixture() {
    const records = await canonicalRecords();
    return {
      kind: "OCR_CANONICAL_V4_RECOMPUTATION",
      evidenceClass: "LIVE",
      baseline: {
        provenance: { kind: "VERIFIED_BASELINE_ARTIFACT_V4" },
        records: structuredClone(records),
      },
      candidate: {
        provenance: { kind: "VERIFIED_CANDIDATE_ARTIFACT_V4" },
        records: structuredClone(records),
        rawVertexResponses: records.map(({ caseId }) => ({
          caseId,
          countTokensSha256: sha256(`count-${caseId}`),
          generationSha256: sha256(`generation-${caseId}`),
        })),
        attemptLedger: records.map(({ caseId }, index) => ({
          caseId,
          sequence: index + 1,
          decision: "ADMITTED",
        })),
        boundaryObservations: Array.from({ length: 45 }, (_, index) => ({
          identity: `observation-${index + 1}`,
        })),
      },
      provider: {
        requestedModelAlias: "gemini-2.5-flash",
        observedModelVersion: "gemini-2.5-flash-001",
        promptSha256: "1".repeat(64),
      },
      execution: {
        requestIds: records.map(
          (_, index) =>
            `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        ),
        responseIds: records.map(({ caseId }) => `response-${caseId}`),
        usage: {
          inputTokens: 1_800,
          outputTokens: 360,
          totalTokens: 2_160,
        },
        pricing: {
          currency: "USD",
          inputMicrosPerMillionTokens: 300_000,
          outputMicrosPerMillionTokens: 2_500_000,
          hardLimitMicros: 500_000,
          cumulativeWorstCaseMicros: 369_180,
          measuredMicros: 1_440,
        },
      },
    };
  }

  describe("canonical OCR V4 application authority", () => {
    it("exports callable canonical baseline derivation and SRE artifact producers", async () => {
      const producer = canonicalProducer();
      const expectedCorpusSha256 = createHash("sha256")
        .update(readFileSync(join(__dirname, "ground-truth.json")))
        .digest("hex");

      const expectations = await producer.deriveBaselineExpectationsV4();
      const artifact = await producer.produceBaselineArtifactV4();

      expect(expectations).toMatchObject({
        kind: "OCR_CANONICAL_V4_RECOMPUTATION",
        reportSchemaVersion: 4,
        datasetVersion: DATASET_VERSION,
        corpusSha256: expectedCorpusSha256,
        caseIds: CANONICAL_CASE_IDS,
        records: expect.arrayContaining([
          expect.objectContaining({ caseId: "scan-001" }),
          expect.objectContaining({ caseId: "scan-018" }),
        ]),
      });
      expect(artifact).toMatchObject({
        schemaVersion: 4,
        kind: "OCR_BASELINE_ARTIFACT_V4",
        datasetVersion: DATASET_VERSION,
        corpusSha256: expectedCorpusSha256,
        records: expectations.records,
      });
    });

    it("loads truth, dataset and corpus internally instead of accepting caller authority", async () => {
      const producer = canonicalProducer();
      const canonical = await producer.deriveBaselineExpectationsV4();
      const poisoned = await producer.deriveBaselineExpectationsV4({
        datasetVersion: "caller-dataset",
        corpusSha256: "0".repeat(64),
        groundTruth: [{ caseId: "caller-case", outcome: "SUCCESS" }],
        provenance: { kind: "CALLER_ASSERTED" },
      });

      expect(poisoned).toEqual(canonical);
      expect(JSON.stringify(poisoned)).not.toContain("caller");
    });

    it("uses OCR_CANONICAL_V4_RECOMPUTATION and emits the complete application V4 schema", async () => {
      const clean = await canonicalRecomputationFixture();
      const poisoned = {
        ...clean,
        datasetVersion: "caller-dataset",
        corpusSha256: "0".repeat(64),
        groundTruth: [{ caseId: "caller-case" }],
        provenance: { releaseStatus: "PASS", issues: [] },
      };

      const [canonical, callerAttempt] = await Promise.all([
        authority().assessActivationAuthority(clean),
        authority().assessActivationAuthority(poisoned),
      ]);
      const validate = new Ajv2020({ allErrors: true }).compile(reportSchema);

      expect(canonical.kind).toBe("OCR_CANONICAL_V4_RECOMPUTATION");
      expect(canonical.reportSchemaVersion).toBe(4);
      expect(validate(canonical.report)).toBe(true);
      expect(validate.errors).toBeNull();
      expect(callerAttempt.report).toEqual(canonical.report);
      expect(callerAttempt.releaseStatus).toBe(canonical.releaseStatus);
    });

    it("never signs caller-fabricated truth with eighteen ERROR records and no raw execution evidence", async () => {
      const input = await canonicalRecomputationFixture();
      Object.assign(input, {
        datasetVersion: "caller-fabricated-dataset",
        corpusSha256: "0".repeat(64),
        groundTruth: input.candidate.records.map(({ caseId }) => ({
          caseId,
          outcome: {
            kind: "ERROR",
            errorCode: "CALLER_ASSERTED",
            retryable: false,
          },
        })),
      });
      input.candidate.records = input.candidate.records.map((record) => ({
        ...record,
        outcome: {
          kind: "ERROR",
          errorCode: "CALLER_ASSERTED",
          retryable: false,
        },
      }));
      input.candidate.rawVertexResponses = [];
      input.candidate.attemptLedger = [];
      input.candidate.boundaryObservations = [];

      const assessment = await authority().assessActivationAuthority(input);

      expect(assessment).toMatchObject({
        kind: "OCR_CANONICAL_V4_RECOMPUTATION",
        reportSchemaVersion: 4,
        releaseStatus: "GAPS",
        signable: false,
      });
      expect(assessment.issues).toEqual(
        expect.arrayContaining([
          "CANONICAL_DATASET_BINDING_INVALID",
          "CANONICAL_CORPUS_BINDING_INVALID",
          "RAW_VERTEX_RESPONSES_MISSING",
          "ATTEMPT_LEDGER_MISSING",
          "BOUNDARY_OBSERVATIONS_MISSING",
        ]),
      );
    });

    it("reachability-blocks the legacy evaluator from PASS with non-null execution claims", () => {
      expect(
        boundary().evaluateBaselineCandidateReport({
          ...completeInput,
          evidenceKind: "LIVE",
          baselineExecution: { callerClaim: "executed" },
          candidateExecution: { callerClaim: "executed" },
        }),
      ).toEqual({
        reportSchemaVersion: 4,
        releaseStatus: "GAPS",
        issues: ["LEGACY_AUTHORITY_DISABLED"],
      });
    });

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
      ["date text", "dateText", "30/02/2026", "DATE_TEXT_MISMATCH"],
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
      ["page", "pageNumber", 2, "PAGE_ORDER_MISMATCH"],
      ["occurrence", "pageOccurrenceIndex", 2, "OCCURRENCE_ORDER_MISMATCH"],
      ["description", "description", "INVENTED", "DESCRIPTION_MISMATCH"],
    ] as const)(
      "scores mutated %s as a canonical fact defect",
      async (_label, field, value, issue) => {
        const input = await canonicalRecomputationFixture();
        const record = input.candidate.records.find(
          ({ caseId }) => caseId === "scan-001",
        );
        if (!record || record.outcome.kind !== "SUCCESS")
          throw new Error("CANONICAL_SUCCESS_FIXTURE_INVALID");
        const row = record.outcome.candidates[0]!;
        (row as Record<string, unknown>)[field] = value;

        const result = await authority().assessActivationAuthority(input);

        expect(result.releaseStatus).toBe("GAPS");
        expect(result.issues).toContain(issue);
      },
    );

    it.each([
      [
        "terminal code",
        (input: Awaited<ReturnType<typeof canonicalRecomputationFixture>>) => {
          const terminal = input.candidate.records.find(
            ({ caseId }) => caseId === "scan-012",
          )!;
          terminal.outcome = {
            kind: "ERROR",
            errorCode: "LIMIT_EXCEEDED",
            retryable: false,
          };
        },
        "TERMINAL_OUTCOME_MISMATCH",
      ],
      [
        "schema validity",
        (input: Awaited<ReturnType<typeof canonicalRecomputationFixture>>) => {
          (input.candidate.records[0]! as Record<string, unknown>).schemaValid =
            false;
        },
        "SCHEMA_INVALID",
      ],
    ] as const)("scores %s independently", async (_label, mutate, issue) => {
      const input = await canonicalRecomputationFixture();
      mutate(input);

      const result = await authority().assessActivationAuthority(input);

      expect(result.releaseStatus).toBe("GAPS");
      expect(result.issues).toContain(issue);
    });

    it.each([
      ["requested alias", ["provider", "requestedModelAlias"], null],
      ["observed model", ["provider", "observedModelVersion"], null],
      ["prompt", ["provider", "promptSha256"], null],
      ["request IDs", ["execution", "requestIds"], []],
      ["response IDs", ["execution", "responseIds"], []],
      ["usage totals", ["execution", "usage", "totalTokens"], 0],
      ["pricing", ["execution", "pricing", "measuredMicros"], 500_001],
      [
        "cumulative spend",
        ["execution", "pricing", "cumulativeWorstCaseMicros"],
        500_001,
      ],
    ] as const)(
      "missing or invalid %s remains GAPS",
      async (_label, path, replacement) => {
        const input = await canonicalRecomputationFixture();
        let target: Record<string, any> = input;
        for (const segment of path.slice(0, -1))
          target = target[segment] as Record<string, any>;
        target[path.at(-1)!] = replacement;

        const result = await authority().assessActivationAuthority(input);

        expect(result.releaseStatus).toBe("GAPS");
        expect(result.signable).toBe(false);
        expect(result.issues).not.toEqual([]);
      },
    );

    it.each([
      ["latency", "latencyMs", null],
      ["RSS", "peakRssBytes", null],
    ] as const)(
      "missing %s measurement remains GAPS",
      async (_label, field, replacement) => {
        const input = await canonicalRecomputationFixture();
        (input.candidate.records[0]! as Record<string, unknown>)[field] =
          replacement;

        const result = await authority().assessActivationAuthority(input);

        expect(result.releaseStatus).toBe("GAPS");
        expect(result.signable).toBe(false);
      },
    );

    it("extracts baseline authority directly from the authenticated archive member bytes", async () => {
      const fixture = await githubBaselineArtifactFixture();
      const memberPayload = structuredClone(fixture.payload);
      const archiveOnly = {
        expected: fixture.expected,
        metadata: fixture.metadata,
        archiveBytes: fixture.archiveBytes,
      };

      await expect(
        authority().verifyBaselineArtifactV4(archiveOnly),
      ).resolves.toMatchObject({
        kind: "VERIFIED_BASELINE_ARTIFACT_V4",
        records: memberPayload.records,
      });
    });

    it("rejects a genuine archive paired with fabricated independent member and payload objects", async () => {
      const fixture = await githubBaselineArtifactFixture();
      const fabricated = {
        ...fixture.payload,
        records: fixture.payload.records.map((record, index) =>
          index === 0 ? { ...record, artifactSha256: "0".repeat(64) } : record,
        ),
      };

      await expect(
        authority().verifyBaselineArtifactV4({
          ...fixture,
          members: [
            {
              name: fixture.expected.memberName,
              bytes: Buffer.from(JSON.stringify(fabricated)),
            },
          ],
          payload: fabricated,
        }),
      ).rejects.toThrow("BASELINE_ARTIFACT_PROVENANCE_INVALID");
    });

    it.each([
      [
        "repository ID",
        (
          fixture: Awaited<ReturnType<typeof githubBaselineArtifactFixture>>,
        ) => {
          fixture.metadata.repository_id = 999_999;
        },
      ],
      [
        "run attempt",
        (
          fixture: Awaited<ReturnType<typeof githubBaselineArtifactFixture>>,
        ) => {
          fixture.metadata.workflow_run.run_attempt = 2;
        },
      ],
      [
        "member bytes",
        (
          fixture: Awaited<ReturnType<typeof githubBaselineArtifactFixture>>,
        ) => {
          const altered = Buffer.from("{}");
          fixture.archiveBytes = storedZipMember(
            fixture.expected.memberName,
            altered,
          );
          fixture.metadata.digest = `sha256:${sha256(fixture.archiveBytes)}`;
        },
      ],
    ] as const)(
      "rejects baseline artifact with altered %s independently of caller payload",
      async (_label, mutate) => {
        const fixture = await githubBaselineArtifactFixture();
        fixture.metadata.repository_id = fixture.expected.repositoryId;
        fixture.metadata.workflow_run.run_attempt = 1;
        mutate(fixture);

        await expect(
          authority().verifyBaselineArtifactV4(fixture),
        ).rejects.toThrow("BASELINE_ARTIFACT_PROVENANCE_INVALID");
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
