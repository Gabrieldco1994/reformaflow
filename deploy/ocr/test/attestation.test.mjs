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
  buildUnsignedPayloadFromBytes,
} from "../build-unsigned-attestation.mjs";
import * as unsignedAttestation from "../build-unsigned-attestation.mjs";

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
      maxTotalCostMicros: 502000,
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
      assessment: {
        sha256: "6".repeat(64),
        size: 3456,
        artifactId: "7003",
        githubArtifactDigest: `sha256:${"4".repeat(64)}`,
      },
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
      hardLimitMicros: 502000,
      reservedMicros: 502000,
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
    hardLimitMicros: 502000,
    reservedMicros: 502000,
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
        hardLimitMicros: 502000,
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
        hardLimitMicros: 502000,
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
  );
}

function assertPersistedAssessmentRequired(result) {
  assert.equal(result.releaseStatus, "GAPS");
  assert.equal(result.signable, false);
  assert.deepEqual(result.issues, ["PERSISTED_REPORT_ASSESSMENT_REQUIRED"]);
}

test("legacy report cannot reach unsigned producer without persisted application assessment", () => {
  const input = unsignedInputs();
  const assessed = buildUnsignedPayloadFromBytes(
    input.payload,
    input.raw,
    input.reportBytes,
    input.spendBytes,
  );
  assertPersistedAssessmentRequired(assessed);
  const built = buildUnsignedPayloadFromBytes(
    input.payload,
    input.raw,
    input.reportBytes,
    input.spendBytes,
  );
  assert.equal(built.releaseStatus, "GAPS");
  assert.equal(built.signable, false);
  assert.deepEqual(built.issues, ["PERSISTED_REPORT_ASSESSMENT_REQUIRED"]);
});

test("V1 and hybrid reports are structured GAPS and never signable", () => {
  const input = unsignedInputs();
  for (const report of [
    { schemaVersion: 1, releaseStatus: "PASS", spend: input.report.spend },
    { ...input.report, schemaVersion: 1 },
  ]) {
    const result = evaluateMutation(input, report);
    assertPersistedAssessmentRequired(result);
  }
});

test("production bundle cannot bypass the persisted V4 assessment", () => {
  assert.throws(
    () =>
      unsignedAttestation.buildUnsignedPayloadFromBundle({
        schemaVersion: 1,
        mode: "BUNDLE",
        payload: fixture("f".repeat(64)),
        rawEvidenceBase64: Buffer.from("{}").toString("base64"),
        reportBase64: Buffer.from("{}").toString("base64"),
        spendRequestBase64: Buffer.from("{}").toString("base64"),
      }),
    /UNSIGNED_INPUT_INVALID/,
  );
});

test("TEST_ONLY and absent legacy executions cannot bypass persisted assessment", () => {
  const input = unsignedInputs();
  const testOnly = evaluateMutation(input, {
    ...input.report,
    evidenceClass: "TEST_ONLY",
  });
  assertPersistedAssessmentRequired(testOnly);
  for (const side of ["baseline", "candidate"]) {
    const report = structuredClone(input.report);
    report[side] = null;
    assertPersistedAssessmentRequired(evaluateMutation(input, report));
  }
});

test("legacy execution mutations cannot create authority without persisted assessment", () => {
  const input = unsignedInputs();
  const metadata = structuredClone(input.report);
  metadata.baseline.provenance.executionKind = "IN_MEMORY_TEST_FIXTURE";
  assertPersistedAssessmentRequired(evaluateMutation(input, metadata));
  const artifactValue = parseStrictJson(input.raw.toString("utf8"));
  artifactValue.executionArtifacts.baseline.bytesBase64 =
    Buffer.from("metadata-only").toString("base64");
  const artifactRaw = Buffer.from(canonicalize(artifactValue));
  const artifactReport = structuredClone(input.report);
  artifactReport.rawEvidenceSha256 = sha256(artifactRaw);
  assertPersistedAssessmentRequired(
    evaluateMutation(input, artifactReport, artifactRaw),
  );
  const duplicate = structuredClone(input.report);
  duplicate.candidate.records[1].requestId =
    duplicate.candidate.records[0].requestId;
  assertPersistedAssessmentRequired(evaluateMutation(input, duplicate));
  const rawValue = parseStrictJson(input.raw.toString("utf8"));
  rawValue.responses[0].bytesBase64 = Buffer.from("mutated").toString("base64");
  const raw = Buffer.from(canonicalize(rawValue));
  const rawMismatch = structuredClone(input.report);
  rawMismatch.rawEvidenceSha256 = sha256(raw);
  assertPersistedAssessmentRequired(evaluateMutation(input, rawMismatch, raw));
});

test("legacy prompt and outcome mutations cannot bypass persisted assessment", () => {
  const input = unsignedInputs();
  const prompt = structuredClone(input.report);
  prompt.candidate.records[0].promptSha256 = "0".repeat(64);
  assertPersistedAssessmentRequired(evaluateMutation(input, prompt));
  const unknown = structuredClone(input.report);
  unknown.candidate.records[0].providerOutcome = "SOMETHING_NONEMPTY";
  assertPersistedAssessmentRequired(evaluateMutation(input, unknown));
  const limit = structuredClone(input.report);
  limit.baseline.records[0].outcome = "LIMIT_EXCEEDED";
  limit.candidate.records[0].providerOutcome = "LIMIT_EXCEEDED";
  limit.candidate.records[0].outcome = "OCR_UNAVAILABLE";
  assertPersistedAssessmentRequired(evaluateMutation(input, limit));
});

test("legacy caller claims cannot create PASS without persisted assessment", () => {
  const input = unsignedInputs();
  const claimed = structuredClone(input.report);
  claimed.comparison.cases[0].pass = false;
  assertPersistedAssessmentRequired(evaluateMutation(input, claimed));
  const cost = structuredClone(input.report);
  cost.candidate.records[0].cost.amountMicros += 1;
  assertPersistedAssessmentRequired(evaluateMutation(input, cost));
  const status = structuredClone(input.report);
  status.releaseStatus = "GAPS";
  status.issues = ["CALLER_CLAIM"];
  assertPersistedAssessmentRequired(evaluateMutation(input, status));
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
  assertPersistedAssessmentRequired(
    buildUnsignedPayloadFromBytes(payload, input.raw, reportBytes, spendBytes),
  );
});

test("attempt spend admits 502000 and blocks 502001 before generation", () => {
  assert.deepEqual(admitCumulativeSpend(501999, 1), {
    status: "ADMITTED",
    cumulativeWorstCaseMicros: 502000,
  });
  assert.deepEqual(admitCumulativeSpend(501999, 2), {
    status: "CAPTURE_SPEND_LIMIT",
    cumulativeWorstCaseMicros: 502001,
  });
  const input = unsignedInputs();
  const restarted = structuredClone(input.report);
  restarted.candidate.records[1].admission.spentBeforeMicros = 0;
  assertPersistedAssessmentRequired(evaluateMutation(input, restarted));
  const understated = structuredClone(input.report);
  understated.candidate.records[0].admission.worstCaseCurrentMicros = 1;
  assertPersistedAssessmentRequired(evaluateMutation(input, understated));
});

test("legacy mechanical claims cannot bypass persisted assessment", () => {
  const input = unsignedInputs();
  const missing = structuredClone(input.report);
  missing.boundaryObservations.pop();
  assertPersistedAssessmentRequired(evaluateMutation(input, missing));
  const claimed = structuredClone(input.report);
  claimed.boundaryObservations[0].pass = true;
  assertPersistedAssessmentRequired(evaluateMutation(input, claimed));
  const written = structuredClone(input.report);
  written.boundaryObservations[0].financialDeltas.Expense = 1;
  assertPersistedAssessmentRequired(evaluateMutation(input, written));
  const mutated = structuredClone(input.report);
  mutated.boundaryObservations[10].outcome = "CALLER_ASSERTED_PASS";
  assertPersistedAssessmentRequired(evaluateMutation(input, mutated));
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

const authorityRoot = resolve(import.meta.dirname, "../../..");
const canonicalCaseIds = Array.from(
  { length: 18 },
  (_, index) => `scan-${String(index + 1).padStart(3, "0")}`,
);
const canonicalDatasetVersion = "ocr-synth-v1-direct-pdf-vertex-v3";
const canonicalReportSchemaPath =
  "apps/api/src/imports/ocr-synth-v1/report.schema.json";

function canonicalAuthorityBoundary() {
  const loaded = unsignedAttestation;
  const observation = {
    kind:
      typeof loaded.assessCanonicalReport === "function" &&
      typeof loaded.verifyCandidateArtifactV4 === "function"
        ? "READY"
        : "BOUNDARY_UNAVAILABLE",
    code: "CANONICAL_REPORT_V4_AUTHORITY_NOT_IMPLEMENTED",
  };
  assert.deepEqual(observation, {
    kind: "READY",
    code: "CANONICAL_REPORT_V4_AUTHORITY_NOT_IMPLEMENTED",
  });
  if (observation.kind !== "READY") throw new Error(observation.code);
  return loaded;
}

function exactRawEntry(bytes) {
  return {
    bytesBase64: bytes.toString("base64"),
    byteLength: bytes.length,
    sha256: sha256(bytes),
  };
}

function providerPayload(index) {
  return {
    completionStatus: "COMPLETE",
    reportedPageCount: 1,
    pageAccounting: [
      {
        pageNumber: 1,
        status: "READABLE",
        visibleOccurrenceCount: 1,
      },
    ],
    candidates: [
      {
        pageNumber: 1,
        pageOccurrenceIndex: 1,
        description: `ITEM SINTETICO ${String(index + 1).padStart(3, "0")}-0`,
        amountCents: String(index + 1),
        sign: "POSITIVE",
        amountMeaning: "LINE_AMOUNT",
        rawDate: "29/02/2024",
        normalizedDate: "2024-02-29",
        dateExplicitness: "FULL",
        installment: null,
        installmentMeaning: "ABSENT",
        evidenceText: `29/02/2024 ITEM SINTETICO ${String(index + 1).padStart(3, "0")}-0`,
        selected: false,
        verificationStatus: "UNVERIFIED",
        candidateDisposition: "RAW_UNCLASSIFIED",
      },
    ],
  };
}

function rawCandidateCase(index) {
  const caseId = canonicalCaseIds[index];
  const countTokensBytes = Buffer.from(canonicalize({ totalTokens: 100 }));
  const generationBytes = Buffer.from(
    canonicalize({
      responseId: `response-${caseId}`,
      modelVersion: "gemini-2.5-flash-001",
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [{ text: canonicalize(providerPayload(index)) }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        totalTokenCount: 120,
      },
    }),
  );
  return {
    caseId,
    tenantId: "tenant-synthetic-a",
    artifactSha256: sha256(`generated-pdf-${caseId}`),
    requestPlanSha256: sha256(`request-plan-${caseId}`),
    requestId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    countTokens: {
      endpoint:
        "https://southamerica-east1-aiplatform.googleapis.com/v1/projects/p/locations/southamerica-east1/publishers/google/models/gemini-2.5-flash:countTokens",
      method: "POST",
      ...exactRawEntry(countTokensBytes),
    },
    admission: {
      countTokensResponseSha256: sha256(countTokensBytes),
      decision: "ADMITTED",
    },
    generation: {
      endpoint:
        "https://southamerica-east1-aiplatform.googleapis.com/v1/projects/p/locations/southamerica-east1/publishers/google/models/gemini-2.5-flash:generateContent",
      method: "POST",
      ...exactRawEntry(generationBytes),
    },
  };
}

function canonicalApplicationReport() {
  return {
    reportSchemaVersion: 4,
    historicalComparison: "NOT_PERFORMED_P1_DEFERRED",
    datasetVersion: canonicalDatasetVersion,
    corpusSampleCount: 52,
    releaseScannedPdfSampleCount: 18,
    routingSafetySampleCount: 10,
    futureImageSampleCount: 12,
    baseline: {
      sha: "a".repeat(40),
      behavior: "OCR_REQUIRED",
      sampleCount: 18,
    },
    candidate: { evidenceClass: "LIVE" },
    thresholds: {
      scannedTaskSuccessRate: 1,
      exactMoneyRate: 1,
      exactSignRate: 1,
      exactDateRate: 1,
      exactDateExplicitnessRate: 1,
      exactInstallmentRate: 1,
      unknownPreservationRate: 1,
      visibleEvidenceRate: 1,
      schemaValidityRate: 1,
      inventedRows: 0,
      omittedRows: 0,
      tenantLeaks: 0,
      falseAutomations: 0,
      financialWrites: 0,
      maxP95LatencyMs: 30_000,
      maxPeakRssBytes: 536_870_912,
      maxTotalCostMicros: 502_000,
    },
    metrics: {
      scannedTaskSuccessRate: 1,
      exactMoneyRate: 1,
      exactSignRate: 1,
      exactDateRate: 1,
      exactDateExplicitnessRate: 1,
      exactInstallmentRate: 1,
      unknownPreservationRate: 1,
      visibleEvidenceRate: 1,
      schemaValidityRate: 1,
      inventedRows: 0,
      omittedRows: 0,
      tenantLeaks: 0,
      falseAutomations: 0,
      financialWrites: 0,
      p95LatencyMs: 1_000,
      peakRssBytes: 100_000_000,
      inputTokens: 1_800,
      outputTokens: 360,
      totalTokens: 2_160,
      totalCostMicros: 1_440,
      costCurrency: "USD",
    },
    perCase: canonicalCaseIds.map((caseId) => ({
      caseId,
      pass: true,
      issues: [],
    })),
    regressions: [],
    routingCases: Array.from({ length: 10 }, (_, index) => ({
      caseId: `mixed-${String(index + 1).padStart(3, "0")}`,
      pass: true,
      issues: [],
    })),
    safetyProbes: probeIds.map((id) => ({ id, pass: true, issues: [] })),
    fallbackSafety: {
      explicitFailures: true,
      emptySuccessAccepted: false,
      financialWritesPerformed: 0,
      tenantLeakCount: 0,
      routingProviderCalls: 0,
    },
    liveEvidenceGaps: [],
    functionalStatus: "PASS",
    releaseStatus: "PASS",
  };
}

function storedZip(name, bytes) {
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const centralOffset = local.length + nameBytes.length + bytes.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, bytes, central, nameBytes, eocd]);
}

function candidateGithubArtifactFixture(rawEvidence) {
  const memberBytes = Buffer.from(canonicalize(rawEvidence));
  const archiveBytes = storedZip("raw-evidence.json", memberBytes);
  return {
    expected: {
      repositoryId: 12345,
      workflowPath: ".github/workflows/ocr-qualification.yml",
      workflowRunId: 1001,
      workflowRunAttempt: 1,
      artifactId: 7002,
      artifactName: "ocr-candidate-1001-1",
      workflowSha: "a".repeat(40),
      workflowHeadSha: "b".repeat(40),
      workflowHeadTree: "c".repeat(40),
      subjectSha: "d".repeat(40),
      subjectTree: "e".repeat(40),
      memberName: "raw-evidence.json",
    },
    metadata: {
      id: 7002,
      name: "ocr-candidate-1001-1",
      expired: false,
      digest: `sha256:${sha256(archiveBytes)}`,
      workflow_run: { id: 1001, head_sha: "b".repeat(40) },
    },
    archiveBytesBase64: archiveBytes.toString("base64"),
    bindings: {
      workflowPath: ".github/workflows/ocr-qualification.yml",
      workflowSha: "a".repeat(40),
      workflowHeadTree: "c".repeat(40),
      subjectSha: "d".repeat(40),
      subjectTree: "e".repeat(40),
    },
  };
}

async function canonicalAuthorityInputs(options = {}) {
  const rawEvidence = {
    evidenceClass: options.evidenceClass ?? "LIVE",
    datasetVersion: canonicalDatasetVersion,
    cases: canonicalCaseIds.map((_, index) => rawCandidateCase(index)),
  };
  return {
    evidenceClass: options.evidenceClass ?? "LIVE",
    report: canonicalApplicationReport(),
    rawEvidence,
    baselineArtifact: { verified: true, records: canonicalCaseIds },
    candidateArtifact: candidateGithubArtifactFixture(rawEvidence),
    boundaryObservations: { verified: true, count: 45 },
    attemptLedger: { verified: true, runAttempt: 1 },
  };
}

function canonicalExternalAuthority(input) {
  const expected = input.candidateArtifact.expected;
  return {
    repositoryId: expected.repositoryId,
    workflowPath: expected.workflowPath,
    workflowSha: expected.workflowSha,
    workflowRunId: expected.workflowRunId,
    workflowRunAttempt: expected.workflowRunAttempt,
    workflowHeadSha: expected.workflowHeadSha,
    workflowHeadTree: expected.workflowHeadTree,
    subjectSha: expected.subjectSha,
    subjectTree: expected.subjectTree,
    artifactId: expected.artifactId,
    artifactName: expected.artifactName,
    artifactDigest: input.candidateArtifact.metadata.digest,
    memberName: expected.memberName,
  };
}

async function assessCanonicalMutation(input, mutation) {
  const rawEvidence = mutation.rawEvidence ?? input.rawEvidence;
  const candidateArtifact =
    mutation.candidateArtifact ?? candidateGithubArtifactFixture(rawEvidence);
  const bound = { ...input, ...mutation, rawEvidence, candidateArtifact };
  return canonicalAuthorityBoundary().assessCanonicalReport(
    bound,
    canonicalExternalAuthority(bound),
  );
}

test("legacy provider wrapper evidence is rejected before unsigned authority", async () => {
  const input = await canonicalAuthorityInputs();
  const raw = structuredClone(input.rawEvidence);
  const wrapperBytes = Buffer.from(
    canonicalize({
      responseId: "response-scan-001",
      modelVersion: "gemini-2.5-flash-001",
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        totalTokenCount: 120,
      },
      result: { providerOutcome: "SUCCEEDED" },
    }),
  );
  Object.assign(raw.cases[0].generation, exactRawEntry(wrapperBytes));

  const result = await assessCanonicalMutation(input, { rawEvidence: raw });

  assert.equal(result.releaseStatus, "GAPS");
  assert.equal(result.signable, false);
  assert.deepEqual(result.issues, ["RAW_VERTEX_RESPONSE_SCHEMA_INVALID"]);
});

test("legacy raw-byte and caller-PASS claims cannot bypass application V4", async () => {
  const input = await canonicalAuthorityInputs();
  const raw = structuredClone(input.rawEvidence);
  const generation = parseStrictJson(
    Buffer.from(raw.cases[0].generation.bytesBase64, "base64").toString("utf8"),
  );
  const text = parseStrictJson(generation.candidates[0].content.parts[0].text);
  text.candidates[0].amountCents = "2";
  generation.candidates[0].content.parts[0].text = canonicalize(text);
  const mutatedBytes = Buffer.from(canonicalize(generation));
  Object.assign(raw.cases[0].generation, exactRawEntry(mutatedBytes));
  const report = structuredClone(input.report);
  report.releaseStatus = "PASS";
  report.functionalStatus = "PASS";
  report.regressions = [];

  const result = await assessCanonicalMutation(input, {
    rawEvidence: raw,
    report,
    releaseStatus: "PASS",
    issues: [],
  });

  assert.equal(result.releaseStatus, "GAPS");
  assert.equal(result.signable, false);
  assert.deepEqual(result.issues, ["RAW_VERTEX_RESPONSE_SCHEMA_INVALID"]);
});

test("legacy evidence missing Vertex bytes remains fail closed", async () => {
  const input = await canonicalAuthorityInputs();
  const raw = structuredClone(input.rawEvidence);
  delete raw.cases[0].generation.bytesBase64;

  const result = await assessCanonicalMutation(input, { rawEvidence: raw });

  assert.deepEqual(result.issues, ["RAW_VERTEX_RESPONSE_SCHEMA_INVALID"]);
  assert.equal(result.releaseStatus, "GAPS");
  assert.equal(result.signable, false);
});

test("legacy raw-byte encodings never re-enable the retired assessor", async () => {
  const input = await canonicalAuthorityInputs();
  const limit = 16 * 1024 * 1024;
  const mutations = [
    (entry) => {
      entry.bytesBase64 = "***not-base64***";
    },
    (entry) => {
      entry.sha256 = "0".repeat(64);
    },
    (entry) => {
      Object.assign(entry, exactRawEntry(Buffer.alloc(0)));
    },
    (entry) => {
      Object.assign(entry, exactRawEntry(Buffer.alloc(limit + 1, 1)));
    },
  ];

  for (const mutate of mutations) {
    const raw = structuredClone(input.rawEvidence);
    mutate(raw.cases[0].generation);
    const result = await assessCanonicalMutation(input, { rawEvidence: raw });
    assert.deepEqual(result.issues, ["RAW_VERTEX_RESPONSE_SCHEMA_INVALID"]);
    assert.equal(result.signable, false);
  }
});

test("legacy response identity and usage claims never reach unsigned authority", async () => {
  const input = await canonicalAuthorityInputs();
  for (const mutate of [
    (entry) => {
      entry.responseId = "caller-response-id";
    },
    (entry) => {
      entry.modelVersion = "caller-model-version";
    },
    (entry) => {
      entry.usage = {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
      };
    },
  ]) {
    const raw = structuredClone(input.rawEvidence);
    mutate(raw.cases[0].generation);
    const result = await assessCanonicalMutation(input, { rawEvidence: raw });
    assert.deepEqual(result.issues, ["RAW_VERTEX_RESPONSE_SCHEMA_INVALID"]);
  }
});

test("candidate GitHub artifact provenance is externally bound", async () => {
  const input = await canonicalAuthorityInputs();
  const mutations = [
    (artifact) => {
      artifact.metadata.digest = `sha256:${"0".repeat(64)}`;
    },
    (artifact) => {
      artifact.metadata.id = 999999;
    },
    (artifact) => {
      artifact.metadata.workflow_run.id += 1;
    },
    (artifact) => {
      artifact.metadata.workflow_run.head_sha = "0".repeat(40);
    },
    (artifact) => {
      artifact.bindings.subjectTree = "0".repeat(40);
    },
    (artifact) => {
      artifact.archiveBytesBase64 = Buffer.concat([
        Buffer.from(artifact.archiveBytesBase64, "base64"),
        Buffer.from("forged-trailer"),
      ]).toString("base64");
    },
  ];

  for (const mutate of mutations) {
    const artifact = structuredClone(input.candidateArtifact);
    mutate(artifact);
    await assert.rejects(
      () =>
        canonicalAuthorityBoundary().verifyCandidateArtifactV4(
          artifact,
          canonicalExternalAuthority(input),
        ),
      /CANDIDATE_ARTIFACT_PROVENANCE_INVALID/,
    );
  }
});

test("coordinated candidate copies cannot replace external GitHub authority", async () => {
  const input = await canonicalAuthorityInputs();
  const artifact = structuredClone(input.candidateArtifact);
  artifact.expected.artifactId = 9009;
  artifact.metadata.id = 9009;
  artifact.expected.workflowRunId = 8118;
  artifact.metadata.workflow_run.id = 8118;
  artifact.expected.subjectSha = "9".repeat(40);
  artifact.bindings.subjectSha = "9".repeat(40);

  await assert.rejects(
    () =>
      canonicalAuthorityBoundary().verifyCandidateArtifactV4(
        artifact,
        canonicalExternalAuthority(input),
      ),
    /CANDIDATE_ARTIFACT_PROVENANCE_INVALID/,
  );
});

test("candidate payload cannot borrow the digest of another artifact archive", async () => {
  const input = await canonicalAuthorityInputs();
  const artifact = structuredClone(input.candidateArtifact);
  const forgedPayload = structuredClone(input.rawEvidence);
  forgedPayload.cases[0].tenantId = "forged-tenant";
  artifact.archiveBytesBase64 = storedZip(
    "raw-evidence.json",
    Buffer.from(canonicalize(forgedPayload)),
  ).toString("base64");

  await assert.rejects(
    () =>
      canonicalAuthorityBoundary().verifyCandidateArtifactV4(
        artifact,
        canonicalExternalAuthority(input),
        forgedPayload,
      ),
    /CANDIDATE_ARTIFACT_PROVENANCE_INVALID/,
  );
});

test("product raw evidence is recomputed before application V4 can pass", async () => {
  const report = canonicalApplicationReport();
  const rawEvidence = {
    run: {
      candidateSha: "d".repeat(40),
      candidateTree: "e".repeat(40),
    },
    predictions: [],
  };
  const artifact = candidateGithubArtifactFixture(rawEvidence);
  const authority = canonicalExternalAuthority({
    candidateArtifact: artifact,
  });
  const candidateArtifact = structuredClone(artifact);
  let recomputations = 0;
  const assessment = await canonicalAuthorityBoundary().assessCanonicalReport(
    {
      evidenceClass: "LIVE",
      rawEvidence,
      report,
      candidateArtifact,
    },
    authority,
    {
      recompute: async (value) => {
        recomputations += 1;
        assert.deepEqual(value, rawEvidence);
        return structuredClone(report);
      },
    },
  );

  assert.equal(recomputations, 1);
  assert.equal(assessment.releaseStatus, "PASS");
  assert.equal(assessment.signable, true);

  const claimed = structuredClone(report);
  claimed.metrics.exactMoneyRate = 0;
  const rejected = await canonicalAuthorityBoundary().assessCanonicalReport(
    {
      evidenceClass: "LIVE",
      rawEvidence,
      report: claimed,
      candidateArtifact,
    },
    authority,
    { recompute: async () => structuredClone(report) },
  );
  assert.equal(rejected.releaseStatus, "GAPS");
  assert.equal(rejected.signable, false);
  assert.ok(rejected.issues.includes("REPORT_V4_DERIVATION_MISMATCH"));
});

test("only the application-owned report V4 is accepted with no SRE transformation", async () => {
  const report = canonicalApplicationReport();
  const rawEvidence = {
    run: {
      candidateSha: "d".repeat(40),
      candidateTree: "e".repeat(40),
    },
    predictions: [],
  };
  const candidateArtifact = candidateGithubArtifactFixture(rawEvidence);
  const input = {
    evidenceClass: "LIVE",
    report,
    rawEvidence,
    candidateArtifact,
  };
  const result = await canonicalAuthorityBoundary().assessCanonicalReport(
    input,
    canonicalExternalAuthority(input),
    { recompute: async () => structuredClone(report) },
  );
  const schemaBytes = await readFile(
    resolve(authorityRoot, canonicalReportSchemaPath),
  );

  assert.equal(result.reportSchemaVersion, 4);
  assert.equal(result.bindings.reportSchemaSha256, sha256(schemaBytes));
  assert.equal(
    result.bindings.reportSha256,
    sha256(Buffer.from(canonicalize(report))),
  );
  assert.equal(result.releaseStatus, "PASS");
  assert.equal(result.signable, true);
  assert.equal("transformedReport" in result, false);
});

test("approved application V4 reaches unsigned bytes and the external KMS boundary", async () => {
  const seed = unsignedInputs();
  const report = canonicalApplicationReport();
  const rawValue = {
    run: { modelVersion: "gemini-2.5-flash-001" },
    predictions: canonicalCaseIds.map((caseId, index) => ({
      caseId,
      adapterTrace: {
        requestId: `request-${String(index + 1).padStart(2, "0")}`,
        responseId: `response-${String(index + 1).padStart(2, "0")}`,
      },
    })),
  };
  const raw = Buffer.from(canonicalize(rawValue));
  const reportBytes = Buffer.from(canonicalize(report));
  const persistedAssessment = {
    reportSchemaVersion: 4,
    releaseStatus: "PASS",
    signable: true,
    issues: [],
    bindings: {
      rawEvidenceSha256: sha256(Buffer.from(canonicalize(rawValue))),
      reportSha256: sha256(Buffer.from(canonicalize(report))),
      reportSchemaSha256: "a".repeat(64),
    },
  };
  const assessmentBytes = Buffer.from(canonicalize(persistedAssessment));
  const payload = structuredClone(seed.payload);
  payload.evidence.raw.sha256 = sha256(raw);
  payload.evidence.raw.size = raw.length;
  payload.evidence.report.sha256 = sha256(reportBytes);
  payload.evidence.report.size = reportBytes.length;
  payload.evidence.assessment.sha256 = sha256(assessmentBytes);
  payload.evidence.assessment.size = assessmentBytes.length;

  const prepared = buildUnsignedPayloadFromBytes(
    payload,
    raw,
    reportBytes,
    seed.spendBytes,
    assessmentBytes,
  );

  assert.match(prepared.runtimePayloadBase64, /^[A-Za-z0-9+/]+=*$/);
  const runtimePayload = parseStrictJson(
    Buffer.from(prepared.runtimePayloadBase64, "base64").toString("utf8"),
  );
  assert.equal(runtimePayload.verdict, "PASS");
  assert.equal(
    prepared.activationPayloadDraft.evidence.assessment.sha256,
    sha256(assessmentBytes),
  );
  assert.equal(
    prepared.activationPayloadDraft.evidence.requestIds.length,
    canonicalCaseIds.length,
  );
});

test("TEST_ONLY remains deterministic GAPS with every live-evidence deficit", async () => {
  const input = await canonicalAuthorityInputs({ evidenceClass: "TEST_ONLY" });
  const first = await canonicalAuthorityBoundary().assessCanonicalReport(
    input,
    canonicalExternalAuthority(input),
  );
  const second = await canonicalAuthorityBoundary().assessCanonicalReport(
    structuredClone(input),
    canonicalExternalAuthority(input),
  );

  assert.deepEqual(second, first);
  assert.equal(first.releaseStatus, "GAPS");
  assert.equal(first.signable, false);
  assert.deepEqual(first.issues, [
    "LIVE_PROVIDER_RUN_NOT_SUPPLIED",
    "MISSING_BASELINE_EXECUTION",
    "MISSING_LIVE_CANDIDATE_EXECUTION",
    "MISSING_RAW_VERTEX_RESPONSE_BYTES",
    "MISSING_LIVE_ATTEMPT_LEDGER",
    "MISSING_LIVE_BOUNDARY_OBSERVATIONS",
  ]);
});
