import type { Prisma } from "@prisma/client";
import { releaseCompletedSessionAttachments } from "./completed-retention";

describe("completed document retention", () => {
  const now = new Date("2026-10-09T20:00:00.000Z");
  const scope = {
    tenantId: "tenant-retention",
    ownerProjectId: "project-retention",
    sessionId: "session-retention",
  };

  it("releases only remaining refs of the completed session within its transaction", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      importSessionArtifact: { updateMany },
    } as unknown as Prisma.TransactionClient;
    await releaseCompletedSessionAttachments(tx, scope, now);
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        ...scope,
        state: { not: "RELEASED" },
        temporaryStorageKey: { not: null },
      },
      data: { temporaryPurgePending: true },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { ...scope, state: { not: "RELEASED" } },
      data: {
        state: "RELEASED",
        fileName: "document",
        releasedAt: now,
        uploadGeneration: { increment: 1 },
        uploadSessionVersion: null,
        uploadLeaseExpiresAt: null,
        uploadTokenExpiresAt: null,
      },
    });
  });

  it("propagates failures so receipt and finance roll back with reference release", async () => {
    const failure = new Error("transaction failed");
    const updateMany = jest.fn().mockRejectedValue(failure);
    const tx = {
      importSessionArtifact: { updateMany },
    } as unknown as Prisma.TransactionClient;
    await expect(
      releaseCompletedSessionAttachments(tx, scope, now),
    ).rejects.toBe(failure);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
