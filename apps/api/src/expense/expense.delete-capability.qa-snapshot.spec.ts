/**
 * #704 R3 QA — the capability read is one transaction. A writer that lands while the read is between
 * its loaders (soft-deleting every purpose target with ONE statement) must never produce a mixed answer:
 * the read returns the state it started with for every row, and the next read returns the new state.
 * Writers: a second connection (another process) and the same PrismaService client. Runs on the
 * per-worker test DB (journal_mode=delete); a WAL variant was measured by hand, see the QA report.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { refundFixture } from "./__tests__/refund-purpose.fixture";
import { ExpenseService } from "./expense.service";
import { RemovalContext } from "./removal-context";

const db = new PrismaClient();
const writerDb = new PrismaClient();
const prisma = new PrismaService();
const expenses = new ExpenseService(prisma, new ConciliacaoService(prisma));
const N = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("#704 R3 QA capability read is a snapshot under a concurrent writer", () => {
  let f: Awaited<ReturnType<typeof refundFixture>>;
  let targetIds: string[] = [];
  let sourceIds: string[] = [];
  beforeAll(async () => {
    f = await refundFixture(db, prisma, "refund-r3-snap");
    await f.apply();
    const src = await db.expense.findUniqueOrThrow({
      where: { id: f.source.id },
    });
    const srcCfe = await db.cashFlowEntry.findMany({
      where: { expenseId: src.id },
    });
    const edge = await db.rateioAllocation.findFirstOrThrow({
      where: { sourceExpenseId: src.id },
    });
    const tgt = await db.expense.findUniqueOrThrow({
      where: { id: edge.targetExpenseId },
    });
    const tgtCfe = await db.cashFlowEntry.findMany({
      where: { expenseId: tgt.id },
    });
    const S: any[] = [],
      T: any[] = [],
      C: any[] = [],
      E: any[] = [];
    sourceIds = [src.id];
    targetIds = [tgt.id];
    for (let i = 1; i < N; i++) {
      const sid = `r3s-${i}-s`,
        tid = `r3s-${i}-t`;
      const at = new Date(Date.UTC(2026, 8, 1, 0, 0, i));
      S.push({
        ...src,
        id: sid,
        externalId: `r3s-${i}`,
        linkedExpenseId: tid,
        createdAt: at,
        updatedAt: at,
      });
      T.push({ ...tgt, id: tid, createdAt: at, updatedAt: at });
      for (const c of srcCfe)
        C.push({ ...c, id: `${sid}-c${c.id.slice(-4)}`, expenseId: sid });
      for (const c of tgtCfe)
        C.push({ ...c, id: `${tid}-c${c.id.slice(-4)}`, expenseId: tid });
      E.push({
        ...edge,
        id: `r3s-${i}-e`,
        sourceExpenseId: sid,
        targetExpenseId: tid,
      });
      sourceIds.push(sid);
      targetIds.push(tid);
    }
    await db.expense.createMany({ data: [...S, ...T] });
    await db.cashFlowEntry.createMany({ data: C });
    await db.rateioAllocation.createMany({ data: E });
  }, 300000);
  afterAll(async () => {
    await f.cleanup();
    await db.$disconnect();
    await writerDb.$disconnect();
    await prisma.$disconnect();
  });

  const caps = async () => {
    const rows = await db.expense.findMany({
      where: { id: { in: sourceIds } },
      orderBy: { id: "asc" },
    });
    const res = await expenses.withDeleteCapabilities(
      f.tenantId,
      rows,
      f.requester as never,
    );
    return {
      t: res.filter((r: any) => r.canDelete === true).length,
      f: res.filter((r: any) => r.canDelete === false).length,
    };
  };

  it.each([
    ["early", "loadAllocations", "other-connection"],
    ["late", "loadCards", "other-connection"],
    ["early", "loadAllocations", "same-client"],
  ] as const)(
    "%s hook %s writer=%s",
    async (when, method, who) => {
      const writer = who === "same-client" ? prisma : writerDb;
      const before = await caps();
      expect(before).toEqual({ t: N, f: 0 });
      let writerP: Promise<unknown> | null = null;
      let writerErr: unknown = null;
      const orig = (RemovalContext.prototype as any)[method];
      let fired = false;
      const spy = jest
        .spyOn(RemovalContext.prototype as any, method)
        .mockImplementation(async function (this: any, ...a: any[]) {
          if (!fired) {
            fired = true;
            writerP = (writer as any).expense
              .updateMany({
                where: { id: { in: targetIds } },
                data: { deletedAt: new Date() },
              })
              .then(
                () => undefined,
                (e: unknown) => {
                  writerErr = e;
                },
              );
            await sleep(400);
          }
          return orig.apply(this, a);
        });
      let mid: any;
      let readErr: any = null;
      try {
        mid = await caps();
      } catch (e) {
        readErr = e;
      }
      spy.mockRestore();
      await writerP;
      const after = await caps().catch((e) => ({
        err: String(e).slice(0, 200),
      }));
      expect(readErr).toBeNull();
      expect(writerErr).toBeNull();
      expect(mid).toEqual({ t: N, f: 0 }); // the state at the start of the read, for every row
      expect(after).toEqual({ t: 0, f: N }); // the writer did land, and the next read sees it for every row
      expect(fired).toBe(true);
      // restore targets for the next case
      await db.expense.updateMany({
        where: { id: { in: targetIds } },
        data: { deletedAt: null },
      });
    },
    120000,
  );
});
