import { TenantFinancialService } from "./tenant-financial.service";

describe("tenant financial objective scope", () => {
  function harness(projectRows: any[], cashRows: any[]) {
    const prisma: any = {
      project: { findMany: jest.fn().mockResolvedValue(projectRows) },
      cashFlowEntry: { findMany: jest.fn().mockResolvedValue(cashRows) },
      receipt: { findMany: jest.fn() },
      expense: { findMany: jest.fn() },
    };
    return {
      prisma,
      subject: new TenantFinancialService(prisma, {
        getCaixaConta: jest.fn(),
      } as any),
    };
  }

  it("an empty authorized scope cannot leak tenant totals", async () => {
    const { prisma, subject } = harness(
      [],
      [
        {
          valor: 999999,
          tipo: "DESPESA",
          status: "PAGO",
          data: new Date("2026-07-01T12:00:00Z"),
        },
      ],
    );

    const out = await subject.getOverview("t1", []);
    expect(out).toMatchObject({
      totalProjetos: 0,
      pagoMesAtual: 0,
      pagoYTD: 0,
      pagoTotal: 0,
      caixaTotal: null,
    });
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [] }, tenantId: "t1" }),
      }),
    );
    expect(prisma.cashFlowEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: { in: [] },
          tenantId: "t1",
        }),
      }),
    );
  });

  it("queries totals only for project ids remaining after type revocation", async () => {
    const { prisma, subject } = harness(
      [{ id: "casa", name: "Casa", type: "CASA" }],
      [],
    );

    const out = await subject.getOverview("t1", ["casa"]);
    expect(out.totalProjetos).toBe(1);
    expect(out.pagoTotal).toBe(0);
    expect(prisma.cashFlowEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: { in: ["casa"] } }),
      }),
    );
  });
});
