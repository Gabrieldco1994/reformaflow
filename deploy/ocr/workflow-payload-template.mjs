#!/usr/bin/env node
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalize,
  parseStrictJson,
  sha256,
} from "../../scripts/ci/ocr-attestation.mjs";
function fail() {
  throw new Error("PAYLOAD_TEMPLATE_INVALID");
}
async function bytes(path) {
  const handle = await open(
    resolve(path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0) fail();
    const value = await handle.readFile();
    return { value, size: value.length };
  } finally {
    await handle.close();
  }
}
function env(name, pattern) {
  const value = process.env[name] ?? "";
  if (!pattern.test(value)) fail();
  return value;
}
try {
  const [
    rawPath,
    reportPath,
    reviewsPath,
    infraPath,
    runtimeSubjectPath,
    recoveryEvidencePath,
  ] = process.argv.slice(2);
  if (!recoveryEvidencePath) fail();
  const raw = await bytes(rawPath);
  const reportBytes = await bytes(reportPath);
  const report = parseStrictJson(reportBytes.value.toString("utf8"));
  const reviews = parseStrictJson(await readFile(resolve(reviewsPath), "utf8"));
  const infra = parseStrictJson(await readFile(resolve(infraPath), "utf8"));
  const runtime = parseStrictJson(
    await readFile(resolve(runtimeSubjectPath), "utf8"),
  );
  const recovery = parseStrictJson(
    await readFile(resolve(recoveryEvidencePath), "utf8"),
  );
  const candidateRecords = Array.isArray(report.candidate?.records)
    ? report.candidate.records
    : [];
  const observedModelVersion =
    typeof report.provider?.observedModelVersion === "string" &&
    /^[!-~]{1,192}$/.test(report.provider.observedModelVersion)
      ? report.provider.observedModelVersion
      : "UNAVAILABLE";
  if (
    report.reportSchemaVersion !== 4 ||
    Object.hasOwn(report, "schemaVersion") ||
    report.provider?.provider !== infra.provider?.provider ||
    report.provider?.requestedModelAlias !==
      infra.provider?.requestedModelAlias ||
    report.provider?.region !== infra.provider?.region ||
    report.provider?.endpoint !== infra.provider?.endpoint ||
    report.provider?.promptSha256 !== infra.provider?.promptSha256 ||
    (report.evidenceClass !== "TEST_ONLY" &&
      candidateRecords.length > 0 &&
      observedModelVersion === "UNAVAILABLE")
  )
    fail();
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(
    Date.parse(issuedAt) + infra.qualificationLifetimeSeconds * 1000,
  ).toISOString();
  const payload = {
    schemaVersion: 1,
    attestationId: "0".repeat(64),
    subject: {
      repository: {
        name: env("GITHUB_REPOSITORY", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        id: env("GITHUB_REPOSITORY_ID", /^[1-9][0-9]*$/),
        ownerId: env("GITHUB_REPOSITORY_OWNER_ID", /^[1-9][0-9]*$/),
      },
      git: {
        sha: env("OCR_SUBJECT_SHA", /^[0-9a-f]{40}$/),
        tree: env("OCR_SUBJECT_TREE", /^[0-9a-f]{40}$/),
      },
      productionImage: {
        reference: runtime.receipt.image.reference,
        digest: runtime.receipt.image.digest,
        ociConfigDigest: runtime.receipt.image.ociConfigDigest,
        applicationEntrypointPath:
          runtime.receipt.image.applicationEntrypointPath,
        applicationEntrypointSize:
          runtime.receipt.image.applicationEntrypointSize,
        executableSha256: runtime.receipt.image.executableSha256,
        runtimeSubjectArtifactId: runtime.artifactId,
        runtimeSubjectGithubArtifactDigest: runtime.githubArtifactDigest,
        runtimeSubjectArtifactSha256: runtime.runtimeSubjectArtifactSha256,
        runtimeSubjectWorkflowRunId: runtime.receipt.workflow.runId,
        runtimeSubjectWorkflowRunAttempt: runtime.receipt.workflow.runAttempt,
      },
      qualificationImage: {
        digest: env("OCR_IMAGE_DIGEST", /^sha256:[0-9a-f]{64}$/),
        executableDigest: env("OCR_EXECUTABLE_DIGEST", /^sha256:[0-9a-f]{64}$/),
      },
    },
    workflow: {
      path: ".github/workflows/ocr-qualification.yml",
      sha: env("GITHUB_WORKFLOW_SHA", /^[0-9a-f]{40}$/),
      runId: env("GITHUB_RUN_ID", /^[1-9][0-9]*$/),
      runAttempt: Number(env("GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/)),
      ref: "refs/heads/main",
      event: "workflow_dispatch",
    },
    runIdentity: {
      repositoryId: process.env.GITHUB_REPOSITORY_ID,
      repositoryOwnerId: process.env.GITHUB_REPOSITORY_OWNER_ID,
      actorId: env("GITHUB_ACTOR_ID", /^[1-9][0-9]*$/),
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    },
    policy: infra.policy,
    corpus: infra.corpus,
    pricing: infra.pricing,
    reviews,
    provider: {
      provider: infra.provider.provider,
      model: infra.provider.requestedModelAlias,
      modelVersion: observedModelVersion,
      region: infra.provider.region,
      endpoint: infra.provider.endpoint,
      promptSha256: infra.provider.promptSha256,
    },
    evidence: {
      raw: {
        sha256: sha256(raw.value),
        size: raw.size,
        artifactId: env("OCR_RAW_ARTIFACT_ID", /^[1-9][0-9]*$/),
      },
      report: {
        sha256: sha256(reportBytes.value),
        size: reportBytes.size,
        artifactId: env("OCR_REPORT_ARTIFACT_ID", /^[1-9][0-9]*$/),
      },
      requestIds: candidateRecords.map((item) => item.requestId),
      responseIds: candidateRecords.map((item) => item.responseId),
    },
    spend: {
      currency: "USD",
      hardLimitMicros: infra.pricing.maxTotalCostMicros,
      reservedMicros: infra.pricing.maxTotalCostMicros,
      measuredMicros: report.spend.measuredMicros,
      admissionSha256: report.spend.admissionSha256,
      admittedAt: report.spend.admittedAt,
    },
    recoveryEvidence: {
      producer: {
        workflowPath: recovery.payload.workflow.path,
        workflowSha: recovery.payload.workflow.sha,
        runId: recovery.payload.workflow.runId,
        runAttempt: recovery.payload.workflow.runAttempt,
        artifactId: recovery.artifactId,
        githubArtifactDigest: recovery.githubArtifactDigest,
        payloadSha256: recovery.recoveryEvidenceArtifactSha256,
      },
      backupRestore: {
        receiptSha256: recovery.payload.backupRestore.receiptSha256,
      },
      legacyUpgrade: {
        receiptSha256: recovery.payload.legacyUpgrade.receiptSha256,
      },
    },
    validity: { issuedAt, notBefore: issuedAt, expiresAt },
    kms: {
      keyResource: env(
        "OCR_KMS_KEY_RESOURCE",
        /^projects\/[A-Za-z0-9._-]+\/locations\/[A-Za-z0-9._-]+\/keyRings\/[A-Za-z0-9._-]+\/cryptoKeys\/[A-Za-z0-9._-]+$/,
      ),
      cryptoKeyVersion: env(
        "OCR_KMS_KEY_VERSION",
        /^projects\/[A-Za-z0-9._-]+\/locations\/[A-Za-z0-9._-]+\/keyRings\/[A-Za-z0-9._-]+\/cryptoKeys\/[A-Za-z0-9._-]+\/cryptoKeyVersions\/[1-9][0-9]*$/,
      ),
      algorithm: "EC_SIGN_P256_SHA256",
      publicKeySha256: env("OCR_KMS_PUBLIC_KEY_SHA256", /^[0-9a-f]{64}$/),
    },
  };
  if (
    runtime.receipt.git.commitSha !== payload.subject.git.sha ||
    runtime.receipt.git.treeSha !== payload.subject.git.tree ||
    recovery.payload.git.commitSha !== payload.subject.git.sha ||
    recovery.payload.git.treeSha !== payload.subject.git.tree ||
    runtime.receipt.repository.name !== payload.subject.repository.name ||
    recovery.payload.repository.name !== payload.subject.repository.name ||
    Date.parse(expiresAt) > Date.parse(infra.policy.validThroughUtc) ||
    Date.parse(expiresAt) > Date.parse(infra.pricing.recheckThroughUtc)
  )
    fail();
  process.stdout.write(canonicalize(payload));
} catch {
  process.stderr.write("PAYLOAD_TEMPLATE_INVALID\n");
  process.exitCode = 1;
}
