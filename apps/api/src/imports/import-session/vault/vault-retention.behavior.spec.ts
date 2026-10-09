import type { PrismaService } from "../../../prisma/prisma.service";
import { PurgeCoordinator } from "./vault-purger";
import { VaultReaper } from "./vault-reaper";
import { projectSession } from "../import-session.projection";

describe("private document retention behavior", () => {
  const now = new Date("2026-10-09T20:00:00.000Z");
  const scope = {
    tenantId: "tenant-retention",
    ownerProjectId: "project-retention",
  };
  const runtime = {};
  const boot = {
    runtime: () => runtime,
    stopped: { aborted: false },
    recheckLock: jest.fn().mockResolvedValue({ ok: true, runtime }),
  };
  const make = (attached = 0) => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      importSession: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      importSessionArtifact: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(attached),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      importArtifact: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          id: "artifact-retention",
          state: "EXTRACTED",
          storageKey: "a/part/hash/document",
        }),
        count: jest.fn().mockResolvedValue(1),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (work: (value: typeof tx) => Promise<unknown>) => work(tx),
      ),
    } as unknown as PrismaService;
    const storage = { eraseCaptured: jest.fn().mockResolvedValue(undefined) };
    const registry = {
      fence: jest.fn(),
      releaseFence: jest.fn(),
      abortAndDrain: jest.fn().mockResolvedValue("DRAINED"),
    };
    const purger = new PurgeCoordinator(
      prisma,
      { now: () => now },
      boot as never,
      registry as never,
      storage as never,
      100,
    );
    const raw = { abortOwned: jest.fn() };
    const reaper = new VaultReaper(
      prisma,
      { now: () => now },
      {
        boot,
        requirePurger: () => purger,
      } as never,
      raw as never,
    );
    return { tx, prisma, purger, storage, reaper, raw };
  };

  it("refuses to delete originals while another session retains an attached reference", async () => {
    const { purger, storage } = make(1);
    expect(
      await purger.purge({
        kind: "artifact",
        ...scope,
        id: "artifact-retention",
      }),
    ).toBe("NOT_ELIGIBLE");
    expect(storage.eraseCaptured).not.toHaveBeenCalled();
  });

  it("rechecks references after fencing; a changed capture never erases bytes", async () => {
    const { tx, purger, storage } = make();
    tx.importSessionArtifact.count
      .mockResolvedValueOnce(0)
      .mockResolvedValue(1);
    expect(
      await purger.purge({
        kind: "artifact",
        ...scope,
        id: "artifact-retention",
      }),
    ).toBe("STALE_CAPTURE");
    expect(storage.eraseCaptured).not.toHaveBeenCalled();
  });

  it("purges unreferenced originals and extraction content but preserves observation/receipt rows", async () => {
    const { tx, purger, storage } = make();
    expect(
      await purger.purge({
        kind: "artifact",
        ...scope,
        id: "artifact-retention",
      }),
    ).toBe("PURGED");
    expect(storage.eraseCaptured).toHaveBeenCalledTimes(1);
    expect(tx.importArtifact.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { state: "PURGED", storageKey: null, extractionJson: null },
      }),
    );
    expect(tx.importSession.updateMany).not.toHaveBeenCalled();
  });

  it("reaps expired drafts under the writer without renewing their deadline", async () => {
    const { tx, reaper, raw } = make();
    tx.importSession.findMany.mockResolvedValue([
      { id: "session-retention" },
    ] as never);
    tx.importSession.findFirst.mockResolvedValue({
      id: "session-retention",
      state: "DRAFT",
      revision: 1,
      expiresAt: new Date(now.getTime() - 1),
      financialRequestId: null,
    });
    await reaper.runCycle({ ...scope, limit: 4 });
    expect(tx.importSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ...scope,
          state: "DRAFT",
          revision: 1,
          expiresAt: { lte: now },
        }),
        data: expect.objectContaining({ state: "EXPIRED" }),
      }),
    );
    expect(
      tx.importSession.updateMany.mock.calls[0][0].data,
    ).not.toHaveProperty("expiresAt");
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.importSession.findFirst.mock.invocationCallOrder[0],
    );
    expect(raw.abortOwned).toHaveBeenCalledWith([], "EXPIRE");
  });

  it("runtime cleanup includes already cancelled/applied unreferenced artifacts", async () => {
    const { tx, reaper, storage } = make();
    tx.importArtifact.findMany.mockResolvedValue([
      { id: "artifact-retention" },
    ] as never);
    await reaper.runCycle({ ...scope, limit: 4 });
    expect(storage.eraseCaptured).toHaveBeenCalledTimes(1);
    expect(tx.importSession.updateMany).not.toHaveBeenCalled();
  });

  it.each(["APPLIED", "CANCELLED", "EXPIRED"])(
    "terminal %s does not parse or disclose draft/proposal/originals",
    (state) => {
      const row = {
        id: "session-retention",
        ownerProjectId: scope.ownerProjectId,
        cardId: "card-retention",
        state,
        revision: 2,
        expiresAt: now,
        createdAt: now,
        draftJson: "{private-corrupt-original",
        proposalJson: "{private-proposal",
        searchJson: null,
        financialRequestId: null,
        confirmedRevision: null,
        proposalHash: null,
      };
      const projected = projectSession(row as never, [], now, {
        includeReceipt: false,
      });
      expect(projected.view.lines).toEqual([]);
      expect(projected.view.selectedLineIds).toEqual([]);
      expect(projected.view.attachments).toEqual([]);
      expect(projected.view.proposal).toBeNull();
      expect(projected.view.expiresAt).toBeNull();
    },
  );
});
