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
import { buildUnsignedPayloadFromBytes } from "../build-unsigned-attestation.mjs";

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
    reviewSetSha256: "e".repeat(64),
    runId: "1001",
    runAttempt: 1,
    currency: "USD",
    hardLimitMicros: 500000,
    reservedMicros: 500000,
    provider: "GOOGLE_VERTEX_AI",
    model: "gemini-2.5-flash",
    modelVersion: "gemini-2.5-flash-20261014",
    region: "southamerica-east1",
    endpoint: "https://southamerica-east1-aiplatform.googleapis.com",
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

function liveReport(payload) {
  const baselineCases = payload.evidence.requestIds.map((_, index) => ({
    caseId: `case-${String(index + 1).padStart(2, "0")}`,
    artifactSha256: String((index % 6) + 1).repeat(64),
    outcome: "OCR_REQUIRED",
    providerGenerationCalls: 0,
  }));
  const candidateCases = baselineCases.map((baseline, index) => ({
    caseId: baseline.caseId,
    artifactSha256: baseline.artifactSha256,
    outcome: "OCR_COMPLETED",
    requestId: payload.evidence.requestIds[index],
    responseId: payload.evidence.responseIds[index],
    usage: {
      inputTokens: 100 + index,
      outputTokens: 20,
      totalTokens: 120 + index,
    },
    parsedCandidateFacts: { rows: 1 },
  }));
  return {
    schemaVersion: 1,
    releaseStatus: "PASS",
    evidenceClass: "LIVE",
    rawEvidenceSha256: payload.evidence.raw.sha256,
    provider: payload.provider,
    requestIds: payload.evidence.requestIds,
    responseIds: payload.evidence.responseIds,
    spend: {
      measuredMicros: payload.spend.measuredMicros,
      admissionSha256: payload.spend.admissionSha256,
      admittedAt: payload.spend.admittedAt,
    },
    baseline: {
      gitSha: "f".repeat(40),
      treeSha: "e".repeat(40),
      executionKind: "HISTORICAL_REAL",
      cases: baselineCases,
    },
    candidate: {
      gitSha: payload.subject.git.sha,
      treeSha: payload.subject.git.tree,
      executionKind: "VERTEX_LIVE",
      cases: candidateCases,
    },
    comparison: {
      cases: baselineCases.map((value) => ({
        caseId: value.caseId,
        pass: true,
        issues: [],
      })),
    },
  };
}

function unsignedInputs() {
  const payload = fixture("f".repeat(64));
  const raw = Buffer.from("raw-provider-evidence");
  const spendRequest = {
    schemaVersion: 1,
    subjectSha: payload.subject.git.sha,
    subjectTree: payload.subject.git.tree,
    productionImage: payload.subject.productionImage.reference,
    qualificationImageDigest: payload.subject.qualificationImage.digest,
    executableDigest: payload.subject.qualificationImage.executableDigest,
    workflowSha: payload.workflow.sha,
    policySha256: payload.policy.sha256,
    reviewSetSha256: sha256(canonicalize(payload.reviews)),
    runId: payload.workflow.runId,
    runAttempt: payload.workflow.runAttempt,
    currency: "USD",
    hardLimitMicros: payload.spend.hardLimitMicros,
    reservedMicros: payload.spend.reservedMicros,
    provider: payload.provider.provider,
    model: payload.provider.model,
    modelVersion: payload.provider.modelVersion,
    region: payload.provider.region,
    endpoint: payload.provider.endpoint,
    admittedAt: payload.spend.admittedAt,
  };
  const spendBytes = Buffer.from(canonicalize(spendRequest));
  payload.spend.admissionSha256 = sha256(spendBytes);
  payload.evidence.raw.sha256 = sha256(raw);
  payload.evidence.raw.size = raw.length;
  const report = liveReport(payload);
  const reportBytes = Buffer.from(canonicalize(report));
  payload.evidence.report.sha256 = sha256(reportBytes);
  payload.evidence.report.size = reportBytes.length;
  return { payload, raw, spendBytes, report, reportBytes };
}

test("unsigned producer requires live baseline candidate PASS and prompt binding", () => {
  const input = unsignedInputs();
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
  assert.equal(
    runtime.provider.promptSha256,
    input.payload.provider.promptSha256,
  );
  assert.equal(runtime.closure.reviews.length, 4);
  assert.deepEqual(Object.keys(runtime.closure.reviews[0]).sort(), [
    "descriptorSha256",
    "role",
  ]);
  for (const mutation of [
    { releaseStatus: "GAPS" },
    { evidenceClass: "TEST_ONLY" },
  ]) {
    const report = { ...input.report, ...mutation };
    const bytes = Buffer.from(canonicalize(report));
    const payload = structuredClone(input.payload);
    payload.evidence.report.sha256 = sha256(bytes);
    payload.evidence.report.size = bytes.length;
    assert.throws(
      () =>
        buildUnsignedPayloadFromBytes(
          payload,
          input.raw,
          bytes,
          input.spendBytes,
        ),
      /REPORT_NOT_SIGNABLE/,
    );
  }
  const missing = structuredClone(input.report);
  missing.baseline.cases.pop();
  const missingBytes = Buffer.from(canonicalize(missing));
  const missingPayload = structuredClone(input.payload);
  missingPayload.evidence.report.sha256 = sha256(missingBytes);
  missingPayload.evidence.report.size = missingBytes.length;
  assert.throws(
    () =>
      buildUnsignedPayloadFromBytes(
        missingPayload,
        input.raw,
        missingBytes,
        input.spendBytes,
      ),
    /REPORT_AUTHORITY_INVALID/,
  );
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
