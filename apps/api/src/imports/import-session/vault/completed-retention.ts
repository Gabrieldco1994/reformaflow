import type { ImportArtifact, Prisma } from "@prisma/client";
import {
  ImportSessionAttachmentState,
  ImportSessionArtifactState,
  ImportSessionState,
} from "@reformaflow/domain";
import type { ImportRawClaim } from "../import-session.raw-executions";
import { PDF_OCR_USAGE_OUTCOME } from "../ocr/pdf-ocr-budget";

const RELEASED_ATTACHMENT_FILE_NAME = "document";
const TERMINAL_SESSION_STATES = [
  ImportSessionState.APPLIED,
  ImportSessionState.CANCELLED,
  ImportSessionState.EXPIRED,
];
/** Deliberately not a parseable live evidence envelope. */
const PURGED_OBSERVATION_EVIDENCE_JSON = "{}";

/** Keep fencing/provenance, not the user-provided original filename. */
export function releasedAttachmentData(
  now: Date,
): Prisma.ImportSessionArtifactUpdateManyMutationInput {
  return {
    state: ImportSessionAttachmentState.RELEASED,
    fileName: RELEASED_ATTACHMENT_FILE_NAME,
    releasedAt: now,
    uploadGeneration: { increment: 1 },
    uploadSessionVersion: null,
    uploadLeaseExpiresAt: null,
    uploadTokenExpiresAt: null,
  };
}

export type CompletedAttachmentScope = Readonly<{
  tenantId: string;
  ownerProjectId: string;
  sessionId: string;
}>;

type ParserLease = Pick<ImportArtifact, "id" | "parseGeneration" | "state">;
type ParserLeaseInvalidationOptions = Readonly<{
  limit?: number;
  assertLive?: () => void;
  conflictError?: () => Error;
}>;

export class TerminalParserLeaseInvalidationError extends Error {
  constructor() {
    super("Terminal parser lease changed during invalidation");
    this.name = "TerminalParserLeaseInvalidationError";
  }
}

/**
 * The caller owns the tenant writer transaction and has persisted (or is about
 * to persist) a terminal transition. The generation CAS fences an already
 * admitted parser; its in-memory owner must be aborted only after commit.
 */
export async function invalidateTerminalParserLeases(
  tx: Prisma.TransactionClient,
  scope: CompletedAttachmentScope,
  options: ParserLeaseInvalidationOptions = {},
): Promise<ImportRawClaim[]> {
  options.assertLive?.();
  const leases: ParserLease[] = await tx.importArtifact.findMany({
    where: {
      tenantId: scope.tenantId,
      ownerProjectId: scope.ownerProjectId,
      leaseSessionId: scope.sessionId,
    },
    select: { id: true, parseGeneration: true, state: true },
    orderBy: { id: "asc" },
    ...(options.limit === undefined ? {} : { take: options.limit }),
  });
  const claims: ImportRawClaim[] = [];
  for (const lease of leases) {
    options.assertLive?.();
    const claim = {
      tenantId: scope.tenantId,
      ownerProjectId: scope.ownerProjectId,
      sessionId: scope.sessionId,
      artifactId: lease.id,
      parseGeneration: lease.parseGeneration,
    };
    const invalidated = await tx.importArtifact.updateMany({
      where: {
        tenantId: claim.tenantId,
        ownerProjectId: claim.ownerProjectId,
        id: claim.artifactId,
        leaseSessionId: claim.sessionId,
        parseGeneration: claim.parseGeneration,
      },
      data: {
        leaseSessionId: null,
        leaseSessionVersion: null,
        leaseTokenExpiresAt: null,
        leaseExpiresAt: null,
        parseGeneration: { increment: 1 },
        ...(lease.state === ImportSessionArtifactState.ANALYZING
          ? { state: ImportSessionArtifactState.RAW_READY }
          : {}),
      },
    });
    options.assertLive?.();
    if (invalidated.count !== 1)
      throw (
        options.conflictError?.() ?? new TerminalParserLeaseInvalidationError()
      );
    claims.push(claim);
  }
  return claims;
}

/** Select legacy terminal leftovers independently of original/blob existence. */
export function pendingTerminalObservationCleanupWhere(
  scope: Pick<CompletedAttachmentScope, "tenantId" | "ownerProjectId">,
): Prisma.ImportArtifactWhereInput {
  return {
    tenantId: scope.tenantId,
    ownerProjectId: scope.ownerProjectId,
    references: {
      some: { session: { state: { in: TERMINAL_SESSION_STATES } } },
      none: { state: { not: ImportSessionAttachmentState.RELEASED } },
    },
    observations: {
      some: { evidenceJson: { not: PURGED_OBSERVATION_EVIDENCE_JSON } },
    },
  };
}

/**
 * Same tenant writer lock as attachment release/upload/claims is required.
 * Check reference liveness in the mutation itself. Keep canonical FKs and the
 * artifact hash + row reference/ID for same-document dedupe; no evidence field
 * is needed for receipt replay or a canonical claim.
 */
export async function purgeUnreferencedObservationEvidence(
  tx: Prisma.TransactionClient,
  scope: Pick<CompletedAttachmentScope, "tenantId" | "ownerProjectId">,
  artifactFilter: Prisma.ImportArtifactWhereInput,
): Promise<void> {
  const where: Prisma.ImportObservationWhereInput = {
    tenantId: scope.tenantId,
    ownerProjectId: scope.ownerProjectId,
    artifact: {
      AND: [
        artifactFilter,
        {
          references: {
            none: { state: { not: ImportSessionAttachmentState.RELEASED } },
          },
        },
      ],
    },
  };
  await tx.importObservation.deleteMany({
    where: {
      ...where,
      canonicalProjectId: null,
      canonicalExpenseId: null,
      canonicalReceiptId: null,
      canonicalIndex: null,
      claimSessionId: null,
      claimReceiptJson: null,
      claimedAt: null,
    },
  });
  await tx.importObservation.updateMany({
    where,
    data: { evidenceJson: PURGED_OBSERVATION_EVIDENCE_JSON },
  });
}

/** Only after a successful persisted terminal transition and reference release. */
export async function purgeCompletedSessionObservationEvidence(
  tx: Prisma.TransactionClient,
  scope: CompletedAttachmentScope,
): Promise<void> {
  await purgeUnreferencedObservationEvidence(tx, scope, {
    references: {
      some: {
        ...scope,
        session: { state: { in: TERMINAL_SESSION_STATES } },
      },
    },
  });
}

/**
 * The caller owns the writer transaction and has already transferred references
 * needed by a continuation. Never remove bytes here: a concurrent session may
 * still need the artifact, and finance/receipt must roll back on any failure.
 */
export async function releaseCompletedSessionAttachments(
  tx: Prisma.TransactionClient,
  scope: CompletedAttachmentScope,
  now: Date,
): Promise<void> {
  // Consent/provenance/cost survive; provider candidates/evidence do not.
  await tx.importOcrUsage.updateMany({
    where: {
      tenantId: scope.tenantId,
      ownerProjectId: scope.ownerProjectId,
      sessionId: scope.sessionId,
      outcome: PDF_OCR_USAGE_OUTCOME.SUCCEEDED,
      contentPurgedAt: null,
    },
    data: {
      contentPurgedAt: now,
      updatedAt: now,
    },
  });
  const live = {
    ...scope,
    state: { not: ImportSessionAttachmentState.RELEASED },
  };
  await tx.importSessionArtifact.updateMany({
    where: { ...live, temporaryStorageKey: { not: null } },
    data: { temporaryPurgePending: true },
  });
  await tx.importSessionArtifact.updateMany({
    where: live,
    data: releasedAttachmentData(now),
  });
}
