import { Logger } from "@nestjs/common";
import { VaultRetentionScheduler } from "./vault-retention.scheduler";

describe("vault retention runtime", () => {
  const scope = {
    tenantId: "tenant-retention",
    ownerProjectId: "project-retention",
  };
  const create = () => {
    const prisma = {
      importSession: { groupBy: jest.fn().mockResolvedValue([scope]) },
    };
    const reaper = {
      runCycle: jest.fn().mockResolvedValue({ sessions: [], purges: [] }),
    };
    const gate = { boot: { runtime: () => ({}), stopped: { aborted: false } } };
    const service = new VaultRetentionScheduler(
      prisma as never,
      reaper as never,
      gate as never,
    );
    return { prisma, reaper, gate, service };
  };
  it("runs bounded database-derived tenant/project scopes", async () => {
    const { prisma, reaper, service } = create();
    await service.run();
    expect(prisma.importSession.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        take: expect.any(Number),
        by: ["tenantId", "ownerProjectId"],
        orderBy: [{ tenantId: "asc" }, { ownerProjectId: "asc" }],
      }),
    );
    expect(reaper.runCycle).toHaveBeenCalledWith({
      ...scope,
      limit: expect.any(Number),
    });
  });
  it("fails closed when vault is off", async () => {
    const { prisma, gate, service } = create();
    gate.boot.runtime = () => null as never;
    await service.run();
    expect(prisma.importSession.groupBy).not.toHaveBeenCalled();
  });
  it("reports opaque failures and propagates them for runtime observability", async () => {
    const { reaper, service } = create();
    const failure = new Error("private-content");
    reaper.runCycle.mockRejectedValue(failure);
    const log = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
    try {
      await expect(service.run()).rejects.toThrow(
        "Import vault retention failed",
      );
      expect(log).toHaveBeenCalledWith({
        event: "import_vault_retention",
        outcome: "FAILED",
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-content");
    } finally {
      log.mockRestore();
    }
  });
});
