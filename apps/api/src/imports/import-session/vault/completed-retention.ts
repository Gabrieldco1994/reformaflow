import type { Prisma } from "@prisma/client";
import { ImportSessionAttachmentState } from "@reformaflow/domain";

const RELEASED_ATTACHMENT_FILE_NAME = "document";

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
