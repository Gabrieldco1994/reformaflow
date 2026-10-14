import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  assertSpendReservation,
  canonicalize,
  finalizeActivationPayload,
  makeAttestationId,
  makeRuntimeReleaseEnvelope,
  prepareRuntimeReleaseDraft,
  parseStrictJson,
  reserveSpend,
  sha256,
  validatePayload,
  validateRuntimeReleasePayload,
  validateTrustBundle,
  verifyEnvelope,
  verifyReleaseCrossBinding,
  verifyRuntimeReleaseEnvelope,
} from "../../../scripts/ci/ocr-attestation.mjs";
import {
  admitCumulativeSpend,
  assessReportV4,
  buildUnsignedPayloadFromBytes,
} from "../build-unsigned-attestation.mjs";

function fixture(publicKeySha256) {
  const sha = "a".repeat(40);
  const tree = "b".repeat(40);
  const payload = {
    schemaVersion: 1,
    attestationId: "0".repeat(64),
    subject: {
      repository: {
        name: "Gabrieldco1994/reformaflow",
        id: "12345",
        ownerId: "67890",
      },
      git: { sha, tree },
      productionImage: {
        reference: `registry.fly.io/reformaflow-api@sha256:${"c".repeat(64)}`,
        digest: `sha256:${"c".repeat(64)}`,
        ociConfigDigest: `sha256:${"1".repeat(64)}`,
        applicationEntrypointPath: "/entrypoint.sh",
        applicationEntrypointSize: 4096,
        executableSha256: "6".repeat(64),
        runtimeSubjectArtifactId: "7001",
        runtimeSubjectGithubArtifactDigest: `sha256:${"2".repeat(64)}`,
        runtimeSubjectArtifactSha256: "3".repeat(64),
        runtimeSubjectWorkflowRunId: "6001",
        runtimeSubjectWorkflowRunAttempt: 1,
      },
      qualificationImage: {
        digest: `sha256:${"d".repeat(64)}`,
        executableDigest: `sha256:${"e".repeat(64)}`,
      },
    },
    workflow: {
      path: ".github/workflows/ocr-qualification.yml",
      sha,
      runId: "1001",
      runAttempt: 1,
      ref: "refs/heads/main",
      event: "workflow_dispatch",
    },
    runIdentity: {
      repositoryId: "12345",
      repositoryOwnerId: "67890",
      actorId: "24680",
      runId: "1001",
      runAttempt: 1,
    },
    policy: {
      path: "apps/api/src/imports/ocr-synth-v1/quality-closure-policy.json",
      sha256: "1".repeat(64),
      version: "ocr-quality-closure-v2",
      validThroughUtc: "2026-10-21T23:59:59.000Z",
    },
    corpus: {
      path: "apps/api/src/imports/ocr-synth-v1/ground-truth.json",
      sha256: "2".repeat(64),
      datasetVersion: "ocr-synth-v1-direct-pdf-vertex-v3",
    },
    pricing: {
      source: "https://cloud.google.com/vertex-ai/generative-ai/pricing",
      observedOn: "2026-10-14T00:00:00.000Z",
      recheckThroughUtc: "2026-10-21T23:59:59.000Z",
      currency: "USD",
      inputMicrosPerMillionTokens: 300000,
      outputMicrosPerMillionTokens: 2500000,
      maxTotalCostMicros: 500000,
    },
    reviews: [
      "DATA_OWNER_RISK_ACCEPTANCE",
      "SECURITY",
      "PRIVACY",
      "DATA_OWNER_FINAL",
    ].map((role, index) => ({
      role,
      path: `deploy/ocr/reviews/review-${index}.json`,
      blobSha: String(index + 3).repeat(40),
      sha256: String(index + 3).repeat(64),
      subjectSha: sha,
      subjectTree: tree,
      policySha256: "1".repeat(64),
      decision: "APPROVED",
      approvalSource: "GITHUB_PROTECTED_ENVIRONMENT",
      approvalEnvironment: [
        "ocr-review-data-owner-risk",
        "ocr-review-security",
        "ocr-review-privacy",
        "ocr-review-data-owner-final",
      ][index],
      reviewerId: String(9000 + index),
      reviewerLogin: `reviewer-${index}`,
      approvalRunId: "1001",
      qualificationRunAttempt: 1,
      approvalEvidenceObservedAt: "2026-10-14T05:00:00.000Z",
    })),
    provider: {
      provider: "GOOGLE_VERTEX_AI",
      model: "gemini-2.5-flash",
      modelVersion: "gemini-2.5-flash-20261014",
      region: "southamerica-east1",
      endpoint: "https://southamerica-east1-aiplatform.googleapis.com",
      promptSha256: "5".repeat(64),
    },
    evidence: {
      raw: { sha256: "7".repeat(64), size: 1234, artifactId: "7001" },
      report: { sha256: "8".repeat(64), size: 2345, artifactId: "7002" },
      requestIds: Array.from(
        { length: 18 },
        (_, index) => `request-${String(index + 1).padStart(2, "0")}`,
      ),
      responseIds: Array.from(
        { length: 18 },
        (_, index) => `response-${String(index + 1).padStart(2, "0")}`,
      ),
    },
    spend: {
      currency: "USD",
      hardLimitMicros: 500000,
      reservedMicros: 500000,
      measuredMicros: 1200,
      admissionSha256: "9".repeat(64),
      admittedAt: "2026-10-14T05:10:00.000Z",
    },
    recoveryEvidence: {
      producer: {
        workflowPath: ".github/workflows/ocr-recovery-evidence.yml",
        workflowSha: "a".repeat(40),
        runId: "6002",
        runAttempt: 1,
        artifactId: "8001",
        githubArtifactDigest: `sha256:${"4".repeat(64)}`,
        payloadSha256: "7".repeat(64),
      },
      backupRestore: { receiptSha256: "a".repeat(64) },
      legacyUpgrade: { receiptSha256: "b".repeat(64) },
    },
    validity: {
      issuedAt: "2026-10-14T05:30:00.000Z",
      notBefore: "2026-10-14T05:20:00.000Z",
      expiresAt: "2026-10-15T05:30:00.000Z",
    },
    kms: {
      keyResource:
        "projects/p/locations/southamerica-east1/keyRings/r/cryptoKeys/k",
      cryptoKeyVersion:
        "projects/p/locations/southamerica-east1/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
      algorithm: "EC_SIGN_P256_SHA256",
      publicKeySha256,
    },
  };
  return payload;
}

async function signedFixture(mutateTemplate = () => undefined) {
  const root = await mkdtemp(join(tmpdir(), "ocr-attestation-"));
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const publicKeySha256 = sha256(
    publicKey.export({ type: "spki", format: "der" }),
  );
  const template = fixture(publicKeySha256);
  mutateTemplate(template);
  const prepared = prepareRuntimeReleaseDraft(template);
  const runtimePayloadBytes = Buffer.from(
    prepared.runtimePayloadBase64,
    "base64",
  );
  const runtimeSignature = sign(
    "sha256",
    runtimePayloadBytes,
    privateKey,
  ).toString("base64");
  const runtimeEnvelope = makeRuntimeReleaseEnvelope(runtimePayloadBytes, {
    keyId: prepared.activationPayloadDraft.kms.cryptoKeyVersion,
    algorithm: "EC_SIGN_P256_SHA256",
    valueBase64: runtimeSignature,
  });
  const runtimeEnvelopeBytes = Buffer.from(canonicalize(runtimeEnvelope));
  const payload = finalizeActivationPayload(
    prepared.activationPayloadDraft,
    runtimeEnvelopeBytes,
  );
  const signature = sign(
    "sha256",
    Buffer.from(canonicalize(payload)),
    privateKey,
  ).toString("base64");
  const envelope = {
    schemaVersion: 1,
    payload,
    signature: { ...payload.kms, valueBase64: signature },
  };
  const allowlist = {
    schemaVersion: 1,
    keys: [
      {
        keyId: payload.kms.cryptoKeyVersion,
        algorithm: "EC_SIGN_P256_SHA256",
        publicKeyPem: pem,
        publicKeySha256,
        notBefore: "2026-10-14T00:00:00.000Z",
        notAfter: "2026-11-01T00:00:00.000Z",
        allowedWorkflowSha: payload.workflow.sha,
      },
    ],
  };
  return {
    root,
    envelope,
    allowlist,
    privateKey,
    runtimeEnvelope,
    runtimeEnvelopeBytes,
    runtimePayloadBytes,
    prepared,
  };
}

test("compiled API trust source is canonical empty fail-closed schema", async () => {
  const path = resolve(
    import.meta.dirname,
    "../../../apps/api/src/imports/import-session/ocr/ocr-release-trust.json",
  );
  const trust = parseStrictJson(await readFile(path, "utf8"));
  assert.equal(validateTrustBundle(trust).schemaVersion, 1);
  assert.deepEqual(trust.keys, []);
});

test("canonical JSON is stable and rejects duplicate keys and noncanonical numbers", () => {
  assert.equal(
    canonicalize(parseStrictJson('{"z":2,"a":[true,null,1]}')),
    '{"a":[true,null,1],"z":2}',
  );
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /JSON_DUPLICATE_KEY/);
  assert.throws(
    () => parseStrictJson('{"a":1.0}'),
    /JSON_NUMBER_NOT_CANONICAL_INTEGER/,
  );
});

test("allowlisted local fixture signature verifies and binds exact run identity", async () => {
  const { root, envelope, allowlist } = await signedFixture();
  const seen = new Set();
  const result = await verifyEnvelope(envelope, allowlist, {
    root,
    now: new Date("2026-10-14T06:00:00.000Z"),
    expectedRunId: "1001",
    expectedRunAttempt: 1,
    expectedMainSha: "a".repeat(40),
    expectedProductionImage: envelope.payload.subject.productionImage.reference,
    seenAttestationIds: seen,
  });
  assert.equal(result.attestationId, envelope.payload.attestationId);
  await assert.rejects(
    () =>
      verifyEnvelope(envelope, allowlist, {
        root,
        now: new Date("2026-10-14T06:00:00.000Z"),
        seenAttestationIds: seen,
      }),
    /ATTESTATION_REPLAY/,
  );
});

test("self-issued keys, mutations, wrong run, and expiry fail closed", async () => {
  const { root, envelope, allowlist } = await signedFixture();
  await assert.rejects(
    () =>
      verifyEnvelope(
        envelope,
        { schemaVersion: 1, keys: [] },
        { root, now: new Date("2026-10-14T06:00:00.000Z") },
      ),
    /KEY_NOT_ALLOWLISTED/,
  );
  await assert.rejects(
    () =>
      verifyEnvelope(envelope, allowlist, {
        root,
        now: new Date("2026-10-14T06:00:00.000Z"),
        expectedRunId: "1002",
      }),
    /RUN_IDENTITY_INVALID/,
  );
  await assert.rejects(
    () =>
      verifyEnvelope(envelope, allowlist, {
        root,
        now: new Date("2026-10-16T06:00:00.000Z"),
      }),
    /ATTESTATION_EXPIRED/,
  );
  const changed = structuredClone(envelope);
  changed.payload.subject.productionImage.digest = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => validatePayload(changed.payload),
    /PRODUCTION_IMAGE_BINDING_INVALID|ATTESTATION_ID_INVALID/,
  );
});

test("hard spend reservation is exclusive and detects path replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr-spend-"));
  await mkdir(join(root, "run"));
  const path = join(root, "run", "reservation.json");
  const request = {
    schemaVersion: 1,
    subjectSha: "a".repeat(40),
    subjectTree: "b".repeat(40),
    productionImage: `registry.fly.io/reformaflow-api@sha256:${"f".repeat(64)}`,
    qualificationImageDigest: `sha256:${"c".repeat(64)}`,
    executableDigest: `sha256:${"1".repeat(64)}`,
    workflowSha: "a".repeat(40),
    policySha256: "d".repeat(64),
    corpusSha256: "2".repeat(64),
    reviewSetSha256: "e".repeat(64),
    runId: "1001",
    runAttempt: 1,
    currency: "USD",
    hardLimitMicros: 500000,
    reservedMicros: 500000,
    provider: "GOOGLE_VERTEX_AI",
    requestedModelAlias: "gemini-2.5-flash",
    region: "southamerica-east1",
    endpoint: "https://southamerica-east1-aiplatform.googleapis.com",
    promptSha256: "5".repeat(64),
    inputMicrosPerMillionTokens: 300000,
    outputMicrosPerMillionTokens: 2500000,
    expectedCaseCount: 18,
    admittedAt: "2026-10-14T05:10:00.000Z",
  };
  const reservation = await reserveSpend(request, path);
  await assertSpendReservation(reservation, path);
  await assert.rejects(() => reserveSpend(request, path), /EEXIST/);
  const replacement = join(root, "replacement");
  await writeFile(replacement, "replacement", { mode: 0o600 });
  await rename(replacement, path);
  await assert.rejects(
    () => assertSpendReservation(reservation, path),
    /SPEND_RESERVATION_CHANGED/,
  );
  await reservation.handle.close();
});

test("canonical signing bytes have no newline and legacy newline signatures fail", async () => {
  const { root, envelope, allowlist, privateKey } = await signedFixture();
  const canonical = canonicalize(envelope.payload);
  assert.notEqual(canonical.at(-1), "\n");
  const legacy = structuredClone(envelope);
  legacy.signature.valueBase64 = sign(
    "sha256",
    Buffer.from(`${canonical}\n`),
    privateKey,
  ).toString("base64");
  await assert.rejects(
    () =>
      verifyEnvelope(legacy, allowlist, {
        root,
        now: new Date("2026-10-14T06:00:00.000Z"),
      }),
    /SIGNATURE_INVALID/,
  );
});

test("activation comparison rejects mutated signed recovery evidence", async () => {
  const { root, envelope, allowlist } = await signedFixture();
  await assert.rejects(
    () =>
      verifyEnvelope(envelope, allowlist, {
        root,
        now: new Date("2026-10-14T06:00:00.000Z"),
        expectedBackupRestoreSha256: "f".repeat(64),
        expectedBackupRestoreArtifactId: "8001",
        expectedLegacyUpgradeSha256: "b".repeat(64),
        expectedLegacyUpgradeArtifactId: "8002",
      }),
    /RECOVERY_EVIDENCE_MISMATCH/,
  );
});

const probeIds = [
  "WRONG_ENDPOINT",
  "WRONG_MODEL",
  "WRONG_REGION",
  "API_KEY_AUTH",
  "ADC_SCOPE_BOUNDED",
  "REQUEST_BODY_BOUNDED",
  "DEADLINE_BOUNDED",
  "GLOBAL_ENDPOINT_FALLBACK",
  "TOOLS_PRESENT",
  "FILE_URI_PRESENT",
  "CACHE_PRESENT",
  "TEXTUAL_PDF_PROVIDER_CALL",
  "LOCAL_RASTER_SANDBOX",
  "PAGE_11_ADMISSION",
  "MIXED_LOCAL_PROVIDER_DUPLICATION",
  "PARTIAL_RESPONSE",
  "MALFORMED_RESPONSE",
  "TRUNCATED_RESPONSE",
  "SAFETY_BLOCKED_RESPONSE",
  "AMBIGUOUS_TIMEOUT_RETRY",
  "UNKNOWN_OUTCOME_NO_RETRY",
  "DURABLE_TENANT_BUDGET",
  "DURABLE_GLOBAL_BUDGET",
  "ACTIVE_SESSION_CONTENT_PURGE_AFTER_7_DAYS",
  "EXACT_CONSENT_CAPABILITY",
  "SELECTED_TRUE_DEFAULT",
  "VERIFIED_DEFAULT",
  "MISSING_CONSENT",
  "MISSING_ATTESTATION",
  "FINANCIAL_WRITE",
  "KNOWN_SAFETY_FINISH_REASONS",
  "TERMINAL_FAILURE_REPLAY_NO_CALL",
  "CAPABILITY_OFF",
  "PRIOR_CONSENT_DECLARATION",
  "RESIDUAL_RISK_ACCEPTANCE",
];
const zeroDeltas = {
  Expense: 0,
  CashFlowEntry: 0,
  Receipt: 0,
  RateioAllocation: 0,
  Settlement: 0,
  InvoiceLiquidation: 0,
};
function execution(payload, records, candidate) {
  const binding = {
    repository: "Gabrieldco1994/reformaflow",
    workflowSha: candidate ? payload.workflow.sha : "f".repeat(40),
    runId: candidate ? payload.workflow.runId : "9001",
    runAttempt: candidate ? payload.workflow.runAttempt : 1,
    subjectSha: candidate ? payload.subject.git.sha : "d".repeat(40),
    subjectTree: candidate ? payload.subject.git.tree : "e".repeat(40),
    corpusSha256: payload.corpus.sha256,
  };
  const artifactId = candidate ? "7002" : "7001";
  const bytes = Buffer.from(
    canonicalize({
      ...binding,
      recordsSha256: sha256(canonicalize(records)),
    }),
  );
  return {
    provenance: {
      evidenceClass: "LIVE",
      executionKind: "PERSISTED_WORKFLOW_ARTIFACT",
      repository: binding.repository,
      workflowPath: ".github/workflows/ocr-qualification.yml",
      workflowSha: binding.workflowSha,
      runId: binding.runId,
      runAttempt: binding.runAttempt,
      subjectSha: binding.subjectSha,
      subjectTree: binding.subjectTree,
      corpusSha256: binding.corpusSha256,
      artifactId,
      artifactSha256: sha256(bytes),
    },
    rawArtifact: { artifactId, bytesBase64: bytes.toString("base64") },
  };
}
function strictV4Report(payload) {
  const baselineRecords = Array.from({ length: 18 }, (_, index) => ({
    caseId: "case-" + String(index + 1).padStart(2, "0"),
    artifactSha256: sha256("artifact-" + index),
    outcome: "SUCCESS",
  }));
  let cumulative = 0;
  const rawResponses = [];
  const candidateRecords = baselineRecords.map((baseline, index) => {
    const inputTokens = 100 + index;
    const outputTokens = 20;
    const responseId = "response-" + String(index + 1).padStart(2, "0");
    const wire = Buffer.from(
      canonicalize({
        responseId,
        modelVersion: "gemini-2.5-flash-001",
        usageMetadata: {
          promptTokenCount: inputTokens,
          candidatesTokenCount: outputTokens,
          totalTokenCount: inputTokens + outputTokens,
        },
        result: { providerOutcome: "SUCCEEDED" },
      }),
    );
    rawResponses.push({
      caseId: baseline.caseId,
      responseId,
      bytesBase64: wire.toString("base64"),
    });
    const spentBeforeMicros = cumulative;
    const worstCaseCurrentMicros = Math.ceil(
      (inputTokens * payload.pricing.inputMicrosPerMillionTokens +
        8192 * payload.pricing.outputMicrosPerMillionTokens) /
        1000000,
    );
    cumulative += worstCaseCurrentMicros;
    return {
      caseId: baseline.caseId,
      artifactSha256: baseline.artifactSha256,
      providerOutcome: "SUCCEEDED",
      outcome: "SUCCESS",
      requestedModelAlias: payload.provider.model,
      modelVersion: "gemini-2.5-flash-001",
      promptSha256: payload.provider.promptSha256,
      latencyMs: 100 + index,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      cost: {
        currency: "USD",
        amountMicros: Math.ceil(
          (inputTokens * payload.pricing.inputMicrosPerMillionTokens +
            outputTokens * payload.pricing.outputMicrosPerMillionTokens) /
            1000000,
        ),
      },
      requestId:
        "10000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
      responseId,
      rawResponseSha256: sha256(wire),
      admission: {
        attemptId: payload.workflow.runId + ":" + payload.workflow.runAttempt,
        sequence: index + 1,
        spentBeforeMicros,
        countedInputTokens: inputTokens,
        reservedOutputTokens: 8192,
        worstCaseCurrentMicros,
        hardLimitMicros: 500000,
        status: "ADMITTED",
      },
    };
  });
  const baselineExecution = execution(payload, baselineRecords, false);
  const candidateExecution = execution(payload, candidateRecords, true);
  const raw = Buffer.from(
    canonicalize({
      schemaVersion: 4,
      evidenceClass: "LIVE",
      executionArtifacts: {
        baseline: baselineExecution.rawArtifact,
        candidate: candidateExecution.rawArtifact,
      },
      responses: rawResponses,
    }),
  );
  const comparisonCases = baselineRecords.map((item) => ({
    caseId: item.caseId,
    pass: true,
    issues: [],
  }));
  const inputTokens = candidateRecords.reduce(
    (sum, item) => sum + item.usage.inputTokens,
    0,
  );
  const outputTokens = candidateRecords.reduce(
    (sum, item) => sum + item.usage.outputTokens,
    0,
  );
  const measuredMicros = candidateRecords.reduce(
    (sum, item) => sum + item.cost.amountMicros,
    0,
  );
  const boundaryObservations = [
    ...Array.from({ length: 10 }, (_, index) => ({
      identity: "[ROUTE] mixed-" + String(index + 1).padStart(3, "0"),
      boundary: "ImportSessionExtractionService.analyzeAttached",
      scenarioSha256: sha256("route-" + index),
      outcome: "ROUTED_LOCALLY",
      countTokensCalls: 0,
      generationCalls: 0,
      financialDeltas: { ...zeroDeltas },
    })),
    ...probeIds.map((id, index) => ({
      identity: "[PROBE] " + id,
      boundary: "QualificationBoundary.probe",
      scenarioSha256: sha256("probe-" + index),
      outcome: "GUARDED",
      countTokensCalls: 0,
      generationCalls: 0,
      financialDeltas: { ...zeroDeltas },
    })),
  ];
  return {
    raw,
    report: {
      reportSchemaVersion: 4,
      evidenceClass: "LIVE",
      rawEvidenceSha256: sha256(raw),
      provider: {
        provider: payload.provider.provider,
        requestedModelAlias: payload.provider.model,
        observedModelVersion: "gemini-2.5-flash-001",
        region: payload.provider.region,
        endpoint: payload.provider.endpoint,
        promptSha256: payload.provider.promptSha256,
      },
      pricing: {
        currency: payload.pricing.currency,
        inputMicrosPerMillionTokens:
          payload.pricing.inputMicrosPerMillionTokens,
        outputMicrosPerMillionTokens:
          payload.pricing.outputMicrosPerMillionTokens,
        hardLimitMicros: payload.pricing.maxTotalCostMicros,
      },
      baseline: {
        provenance: baselineExecution.provenance,
        records: baselineRecords,
      },
      candidate: {
        provenance: candidateExecution.provenance,
        records: candidateRecords,
      },
      boundaryObservations,
      comparison: { cases: comparisonCases },
      regressions: [],
      metrics: {
        caseCount: 18,
        passCount: 18,
        regressionCount: 0,
        p95LatencyMs: 117,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        totalCostMicros: measuredMicros,
        costCurrency: "USD",
      },
      spend: {
        hardLimitMicros: 500000,
        cumulativeWorstCaseMicros: cumulative,
        measuredMicros,
        admissionSha256: payload.spend.admissionSha256,
        admittedAt: payload.spend.admittedAt,
      },
      issues: [],
      releaseStatus: "PASS",
    },
  };
}
function unsignedInputs() {
  const payload = fixture("f".repeat(64));
  const spendRequest = {
    schemaVersion: 1,
    subjectSha: payload.subject.git.sha,
    subjectTree: payload.subject.git.tree,
    productionImage: payload.subject.productionImage.reference,
    qualificationImageDigest: payload.subject.qualificationImage.digest,
    executableDigest: payload.subject.qualificationImage.executableDigest,
    workflowSha: payload.workflow.sha,
    policySha256: payload.policy.sha256,
    corpusSha256: payload.corpus.sha256,
    reviewSetSha256: sha256(canonicalize(payload.reviews)),
    runId: payload.workflow.runId,
    runAttempt: payload.workflow.runAttempt,
    currency: "USD",
    hardLimitMicros: payload.spend.hardLimitMicros,
    reservedMicros: payload.spend.reservedMicros,
    provider: payload.provider.provider,
    requestedModelAlias: payload.provider.model,
    region: payload.provider.region,
    endpoint: payload.provider.endpoint,
    promptSha256: payload.provider.promptSha256,
    inputMicrosPerMillionTokens: payload.pricing.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens: payload.pricing.outputMicrosPerMillionTokens,
    expectedCaseCount: 18,
    admittedAt: payload.spend.admittedAt,
  };
  const spendBytes = Buffer.from(canonicalize(spendRequest));
  payload.spend.admissionSha256 = sha256(spendBytes);
  const value = strictV4Report(payload);
  const reportBytes = Buffer.from(canonicalize(value.report));
  payload.spend.measuredMicros = value.report.spend.measuredMicros;
  payload.evidence.raw.sha256 = sha256(value.raw);
  payload.evidence.raw.size = value.raw.length;
  payload.evidence.report.sha256 = sha256(reportBytes);
  payload.evidence.report.size = reportBytes.length;
  return {
    payload,
    raw: value.raw,
    spendBytes,
    report: value.report,
    reportBytes,
  };
}
function evaluateMutation(input, report, raw = input.raw) {
  const reportBytes = Buffer.from(canonicalize(report));
  const payload = structuredClone(input.payload);
  payload.evidence.raw.sha256 = sha256(raw);
  payload.evidence.raw.size = raw.length;
  payload.evidence.report.sha256 = sha256(reportBytes);
  payload.evidence.report.size = reportBytes.length;
  return buildUnsignedPayloadFromBytes(
    payload,
    raw,
    reportBytes,
    input.spendBytes,
    { assessmentOnly: true },
  );
}

test("unsigned producer requires live baseline candidate PASS and prompt binding", () => {
  const input = unsignedInputs();
  const assessed = buildUnsignedPayloadFromBytes(
    input.payload,
    input.raw,
    input.reportBytes,
    input.spendBytes,
    { assessmentOnly: true },
  );
  assert.deepEqual(assessed.issues, []);
  assert.equal(assessed.releaseStatus, "PASS");
  assert.equal(assessed.signable, true);
  const built = buildUnsignedPayloadFromBytes(
    input.payload,
    input.raw,
    input.reportBytes,
    input.spendBytes,
  );
  const runtime = validateRuntimeReleasePayload(
    parseStrictJson(
      Buffer.from(built.runtimePayloadBase64, "base64").toString("utf8"),
    ),
  );
  assert.equal(runtime.provider.model, "gemini-2.5-flash");
  assert.equal(runtime.provider.modelVersion, "gemini-2.5-flash-001");
  assert.equal(
    runtime.provider.promptSha256,
    input.payload.provider.promptSha256,
  );
});

test("V1 and hybrid reports are structured GAPS and never signable", () => {
  const input = unsignedInputs();
  for (const report of [
    { schemaVersion: 1, releaseStatus: "PASS", spend: input.report.spend },
    { ...input.report, schemaVersion: 1 },
  ]) {
    const result = evaluateMutation(input, report);
    assert.equal(result.releaseStatus, "GAPS");
    assert.equal(result.signable, false);
    assert.deepEqual(result.issues, ["REPORT_V4_REQUIRED"]);
  }
});

test("TEST_ONLY and absent executions retain deterministic missing codes", () => {
  const input = unsignedInputs();
  const testOnly = evaluateMutation(input, {
    ...input.report,
    evidenceClass: "TEST_ONLY",
  });
  assert.deepEqual(testOnly.issues, [
    "MISSING_BASELINE_EXECUTION",
    "MISSING_LIVE_CANDIDATE_EXECUTION",
  ]);
  for (const [side, code] of [
    ["baseline", "MISSING_BASELINE_EXECUTION"],
    ["candidate", "MISSING_LIVE_CANDIDATE_EXECUTION"],
  ]) {
    const report = structuredClone(input.report);
    report[side] = null;
    assert.deepEqual(evaluateMutation(input, report).issues, [code]);
  }
});

test("execution provenance, identities, and raw response bytes are authority", () => {
  const input = unsignedInputs();
  const metadata = structuredClone(input.report);
  metadata.baseline.provenance.executionKind = "IN_MEMORY_TEST_FIXTURE";
  assert.deepEqual(evaluateMutation(input, metadata).issues, [
    "EXECUTION_PROVENANCE_INVALID",
  ]);
  const artifactValue = parseStrictJson(input.raw.toString("utf8"));
  artifactValue.executionArtifacts.baseline.bytesBase64 =
    Buffer.from("metadata-only").toString("base64");
  const artifactRaw = Buffer.from(canonicalize(artifactValue));
  const artifactReport = structuredClone(input.report);
  artifactReport.rawEvidenceSha256 = sha256(artifactRaw);
  assert.deepEqual(
    evaluateMutation(input, artifactReport, artifactRaw).issues,
    ["EXECUTION_ARTIFACT_INVALID"],
  );
  const duplicate = structuredClone(input.report);
  duplicate.candidate.records[1].requestId =
    duplicate.candidate.records[0].requestId;
  assert.deepEqual(evaluateMutation(input, duplicate).issues, [
    "CASE_IDENTITY_INVALID",
  ]);
  const rawValue = parseStrictJson(input.raw.toString("utf8"));
  rawValue.responses[0].bytesBase64 = Buffer.from("mutated").toString("base64");
  const raw = Buffer.from(canonicalize(rawValue));
  const rawMismatch = structuredClone(input.report);
  rawMismatch.rawEvidenceSha256 = sha256(raw);
  assert.deepEqual(evaluateMutation(input, rawMismatch, raw).issues, [
    "RAW_RESPONSE_BINDING_INVALID",
  ]);
});

test("prompt alias opaque model and outcome mapping are independently bound", () => {
  const input = unsignedInputs();
  const prompt = structuredClone(input.report);
  prompt.candidate.records[0].promptSha256 = "0".repeat(64);
  assert.deepEqual(evaluateMutation(input, prompt).issues, [
    "PROMPT_OR_MODEL_BINDING_INVALID",
  ]);
  const unknown = structuredClone(input.report);
  unknown.candidate.records[0].providerOutcome = "SOMETHING_NONEMPTY";
  assert.deepEqual(evaluateMutation(input, unknown).issues, [
    "OUTCOME_MAPPING_INVALID",
  ]);
  const limit = structuredClone(input.report);
  limit.baseline.records[0].outcome = "LIMIT_EXCEEDED";
  limit.candidate.records[0].providerOutcome = "LIMIT_EXCEEDED";
  limit.candidate.records[0].outcome = "OCR_UNAVAILABLE";
  assert.deepEqual(evaluateMutation(input, limit).issues, [
    "OUTCOME_MAPPING_INVALID",
  ]);
});

test("caller comparison metrics cost and status claims cannot create PASS", () => {
  const input = unsignedInputs();
  const claimed = structuredClone(input.report);
  claimed.comparison.cases[0].pass = false;
  assert.deepEqual(evaluateMutation(input, claimed).issues, [
    "PRODUCER_DERIVATION_MISMATCH",
  ]);
  const cost = structuredClone(input.report);
  cost.candidate.records[0].cost.amountMicros += 1;
  assert.deepEqual(evaluateMutation(input, cost).issues, [
    "MEASURED_SPEND_MISMATCH",
  ]);
  const status = structuredClone(input.report);
  status.releaseStatus = "GAPS";
  status.issues = ["CALLER_CLAIM"];
  assert.deepEqual(evaluateMutation(input, status).issues, [
    "PRODUCER_STATUS_MISMATCH",
  ]);
  const request = parseStrictJson(input.spendBytes.toString("utf8"));
  request.requestedModelAlias = "caller-controlled-alias";
  const spendBytes = Buffer.from(canonicalize(request));
  const report = structuredClone(input.report);
  report.spend.admissionSha256 = sha256(spendBytes);
  const reportBytes = Buffer.from(canonicalize(report));
  const payload = structuredClone(input.payload);
  payload.spend.admissionSha256 = sha256(spendBytes);
  payload.evidence.report.sha256 = sha256(reportBytes);
  payload.evidence.report.size = reportBytes.length;
  assert.deepEqual(
    buildUnsignedPayloadFromBytes(payload, input.raw, reportBytes, spendBytes, {
      assessmentOnly: true,
    }).issues,
    ["SPEND_BINDING_INVALID"],
  );
});

test("attempt spend admits 500000 and blocks 500001 before generation", () => {
  assert.deepEqual(admitCumulativeSpend(499999, 1), {
    status: "ADMITTED",
    cumulativeWorstCaseMicros: 500000,
  });
  assert.deepEqual(admitCumulativeSpend(499999, 2), {
    status: "CAPTURE_SPEND_LIMIT",
    cumulativeWorstCaseMicros: 500001,
  });
  const input = unsignedInputs();
  const restarted = structuredClone(input.report);
  restarted.candidate.records[1].admission.spentBeforeMicros = 0;
  assert.deepEqual(evaluateMutation(input, restarted).issues, [
    "SPEND_ATTEMPT_STATE_INVALID",
  ]);
  const understated = structuredClone(input.report);
  understated.candidate.records[0].admission.worstCaseCurrentMicros = 1;
  assert.deepEqual(evaluateMutation(input, understated).issues, [
    "SPEND_ATTEMPT_STATE_INVALID",
  ]);
});

test("exact 10 ROUTE and 35 PROBE observations reject claims mutation and writes", () => {
  const input = unsignedInputs();
  const missing = structuredClone(input.report);
  missing.boundaryObservations.pop();
  assert.deepEqual(evaluateMutation(input, missing).issues, [
    "BOUNDARY_EVIDENCE_INCOMPLETE",
  ]);
  const claimed = structuredClone(input.report);
  claimed.boundaryObservations[0].pass = true;
  assert.deepEqual(evaluateMutation(input, claimed).issues, [
    "REPORT_V4_SCHEMA_INVALID",
  ]);
  const written = structuredClone(input.report);
  written.boundaryObservations[0].financialDeltas.Expense = 1;
  assert.deepEqual(evaluateMutation(input, written).issues, [
    "FINANCIAL_DELTA_NONZERO",
  ]);
  const mutated = structuredClone(input.report);
  mutated.boundaryObservations[10].outcome = "CALLER_ASSERTED_PASS";
  assert.deepEqual(evaluateMutation(input, mutated).issues, [
    "BOUNDARY_EVIDENCE_MUTATED",
  ]);
});

test("runtime envelope verifies exact payload bytes and rejects extra fields raw signatures and whitespace", async () => {
  const fixtureValue = await signedFixture();
  const result = await verifyRuntimeReleaseEnvelope(
    fixtureValue.runtimeEnvelope,
    fixtureValue.allowlist,
    { now: new Date("2026-10-14T06:00:00.000Z") },
  );
  assert.deepEqual(
    result.payload,
    parseStrictJson(fixtureValue.runtimePayloadBytes.toString("utf8")),
  );
  assert.deepEqual(Object.keys(fixtureValue.runtimeEnvelope), [
    "schemaVersion",
    "payloadBase64",
    "signature",
  ]);
  await assert.rejects(
    () =>
      verifyRuntimeReleaseEnvelope(
        { ...fixtureValue.runtimeEnvelope, forbidden: true },
        fixtureValue.allowlist,
        { now: new Date("2026-10-14T06:00:00.000Z") },
      ),
    /RUNTIME_ENVELOPE_INVALID/,
  );
  const extraPayload = { ...result.payload, forbidden: true };
  assert.throws(
    () => validateRuntimeReleasePayload(extraPayload),
    /RUNTIME_PAYLOAD_INVALID/,
  );
  assert.throws(
    () =>
      makeRuntimeReleaseEnvelope(fixtureValue.runtimePayloadBytes, {
        keyId: fixtureValue.envelope.payload.kms.cryptoKeyVersion,
        algorithm: "EC_SIGN_P256_SHA256",
        valueBase64: Buffer.alloc(64).toString("base64"),
      }),
    /RUNTIME_ENVELOPE_INVALID/,
  );
  const changed = structuredClone(fixtureValue.runtimeEnvelope);
  const bytes = Buffer.from(changed.payloadBase64, "base64");
  bytes[bytes.length - 2] ^= 1;
  changed.payloadBase64 = bytes.toString("base64");
  await assert.rejects(
    () =>
      verifyRuntimeReleaseEnvelope(changed, fixtureValue.allowlist, {
        now: new Date("2026-10-14T06:00:00.000Z"),
      }),
    /JSON_INVALID|RUNTIME_PAYLOAD_INVALID|SIGNATURE_INVALID/,
  );
});

test("trust rejects RSA non-P256 and algorithm forks", () => {
  const { publicKey: rsa } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const rsaPem = rsa.export({ type: "spki", format: "pem" });
  const rsaHash = sha256(rsa.export({ type: "spki", format: "der" }));
  const base = {
    schemaVersion: 1,
    keys: [
      {
        keyId: "key/1",
        algorithm: "EC_SIGN_P256_SHA256",
        publicKeyPem: rsaPem,
        publicKeySha256: rsaHash,
        notBefore: "2026-10-14T00:00:00.000Z",
        notAfter: "2026-11-01T00:00:00.000Z",
        allowedWorkflowSha: "a".repeat(40),
      },
    ],
  };
  assert.throws(() => validateTrustBundle(base), /TRUST_BUNDLE_INVALID/);
  const { publicKey: p384 } = generateKeyPairSync("ec", {
    namedCurve: "secp384r1",
  });
  const pem = p384.export({ type: "spki", format: "pem" });
  const hash = sha256(p384.export({ type: "spki", format: "der" }));
  assert.throws(
    () =>
      validateTrustBundle({
        ...base,
        keys: [{ ...base.keys[0], publicKeyPem: pem, publicKeySha256: hash }],
      }),
    /TRUST_BUNDLE_INVALID/,
  );
  assert.throws(
    () =>
      validateTrustBundle({
        ...base,
        keys: [{ ...base.keys[0], algorithm: "RSA_PSS_SHA256" }],
      }),
    /TRUST_BUNDLE_INVALID/,
  );
});

test("two-way binding rejects recovery mutation runtime byte mutation and valid A B mixing", async () => {
  const a = await signedFixture();
  const b = await signedFixture((payload) => {
    payload.recoveryEvidence.backupRestore.receiptSha256 = "f".repeat(64);
  });
  assert.equal(
    verifyReleaseCrossBinding(a.envelope.payload, a.runtimeEnvelopeBytes),
    true,
  );
  const recoveryMutation = structuredClone(a.envelope.payload);
  recoveryMutation.recoveryEvidence.backupRestore.receiptSha256 = "e".repeat(
    64,
  );
  assert.throws(
    () => verifyReleaseCrossBinding(recoveryMutation, a.runtimeEnvelopeBytes),
    /ACTIVATION_SUBJECT_DIGEST_MISMATCH/,
  );
  assert.throws(
    () =>
      verifyReleaseCrossBinding(
        a.envelope.payload,
        Buffer.concat([a.runtimeEnvelopeBytes, Buffer.from(" ")]),
      ),
    /RUNTIME_ENVELOPE_DIGEST_MISMATCH/,
  );
  assert.throws(
    () => verifyReleaseCrossBinding(a.envelope.payload, b.runtimeEnvelopeBytes),
    /RUNTIME_ENVELOPE_DIGEST_MISMATCH/,
  );
  const mixed = structuredClone(a.envelope.payload);
  mixed.runtimeRelease.runtimeEnvelopeSha256 = sha256(b.runtimeEnvelopeBytes);
  mixed.attestationId = makeAttestationId(mixed);
  assert.throws(
    () => verifyReleaseCrossBinding(mixed, b.runtimeEnvelopeBytes),
    /ACTIVATION_SUBJECT_DIGEST_MISMATCH/,
  );
});
