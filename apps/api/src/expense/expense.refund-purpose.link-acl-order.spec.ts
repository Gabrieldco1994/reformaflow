/**
 * #704 R2 — ACL must be resolved BEFORE the refund-purpose guard when the id of
 * another project's expense comes from the request. An actor who cannot see the
 * owned refund target must get the very same answer as for a non-existent id,
 * never a 409 that confirms the hidden expense is marked.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { refundFixture } from "./__tests__/refund-purpose.fixture";
import { ExpenseService } from "./expense.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { REFUND_UNLINK_FIRST } from "./refund-purpose.service";

describe("#704 refund guard order behind the cross-project ACL", () => {
  const db = new PrismaClient();
  const prisma = new PrismaService();
  const expenses = new ExpenseService(prisma, new ConciliacaoService(prisma));
  let f: Awaited<ReturnType<typeof refundFixture>>;
  let targetId: string;
  let localId: string;
  let personalOnly: Record<string, unknown>;

  beforeEach(async () => {
    f = await refundFixture(db, prisma, "refund-link-order");
    targetId = (await f.apply()).targetExpenseId;
    localId = (
      await db.expense.create({
        data: {
          tenantId: f.tenantId,
          projectId: f.projectId,
          tipoDespesa: "OUTROS",
          valor: 1000,
          valorTotal: 1000,
          quantidade: 1,
          formaPagamento: "A_VISTA",
          status: "PLANEJADO",
        },
      })
    ).id;
    // A real, PESSOAL-only user: the write path re-reads the grants from the DB.
    const limited = await db.user.create({
      data: {
        id: `${f.tenantId}-personal-only`,
        tenantId: f.tenantId,
        username: "personal-only",
        name: "Synthetic personal-only user",
        role: "USER",
        allowedProjects: JSON.stringify([f.projectId]),
        allowedProjectTypes: JSON.stringify(["PESSOAL"]),
        allowedModules: JSON.stringify(["expenses", "monthlyOverview"]),
      },
    });
    personalOnly = { id: limited.id, role: "USER" };
  });
  afterEach(async () => {
    await f.cleanup();
  });
  afterAll(async () => {
    await db.$disconnect();
    await prisma.$disconnect();
  });

  const outcome = (run: () => Promise<unknown>) =>
    run().then(
      () => ({ ok: true as const }),
      (error: { status?: number; message?: string; getResponse?: () => unknown }) => ({
        ok: false as const,
        status: error.status,
        message: error.message,
        body: error.getResponse?.(),
      }),
    );
  const before = async () =>
    JSON.stringify({
      expenses: await db.expense.findMany({ orderBy: { id: "asc" } }),
      cash: await db.cashFlowEntry.findMany({ orderBy: { id: "asc" } }),
      allocations: await db.rateioAllocation.findMany({ orderBy: { id: "asc" } }),
    });

  it("editing linkedExpenseId: a hidden marked target is indistinguishable from a non-existent id", async () => {
    const snapshot = await before();
    const link = (id: string, actor: unknown) =>
      outcome(() =>
        expenses.update(
          f.tenantId,
          f.projectId,
          localId,
          { linkedExpenseId: id } as never,
          actor as never,
        ),
      );
    const hidden = await link(targetId, personalOnly);
    const missing = await link("does-not-exist", personalOnly);
    expect(hidden).toMatchObject({ ok: false });
    expect(hidden).toEqual(missing);
    expect(hidden).not.toMatchObject({ status: 409 });
    expect(await before()).toBe(snapshot);
    // a requester who CAN see the target keeps the existing restriction
    const visible = await link(targetId, f.requester);
    expect(visible).toMatchObject({ ok: false, status: 409 });
    expect(JSON.stringify(visible)).toContain(REFUND_UNLINK_FIRST);
    expect(await before()).toBe(snapshot);
  });

  it("per-parcel settlement: a hidden marked target answers like a non-existent one; a visible one keeps the 409", async () => {
    const snapshot = await before();
    const settle = (id: string, actor: unknown) =>
      outcome(() =>
        expenses.conciliarParcela(
          f.tenantId,
          f.projectId,
          localId,
          { targetExpenseId: id, parcelaIndex: 0 },
          actor as never,
        ),
      );
    const hidden = await settle(targetId, personalOnly);
    const missing = await settle("does-not-exist", personalOnly);
    expect(hidden).toMatchObject({ ok: false });
    expect(hidden).toEqual(missing);
    expect(hidden).not.toMatchObject({ status: 409 });
    expect(await before()).toBe(snapshot);
    const visible = await settle(targetId, f.requester);
    expect(visible).toMatchObject({ ok: false, status: 409 });
    expect(await before()).toBe(snapshot);
  });
});
