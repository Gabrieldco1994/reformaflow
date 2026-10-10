/**
 * #704 R3 — baseline corpus for `canDelete` / DELETE authorization.
 *
 * The expected values below are LITERALS pinned against the pre-refactor
 * per-source `prepareRemoval` path (a135), reviewed by hand. They are the
 * oracle for the batched read path: it must reproduce them, and capability must
 * agree with the real DELETE (true => DELETE succeeds, false => DELETE refuses).
 * A candidate that shares its validator with DELETE cannot be its own oracle, so
 * never regenerate these from the code under test.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { seedBankAccount, seedCardWithClosingDue, seedStatementImport } from "../bank-account/__tests__/invoice-undo.fixtures";
import { refundFixture } from "./__tests__/refund-purpose.fixture";
import { ExpenseService } from "./expense.service";
import { RemovalContext } from "./removal-context";

type Fixture = Awaited<ReturnType<typeof refundFixture>>;
type Actor = "owner" | "limited" | "limited-none";
type Subject = { id: string; projectId: string; actor: Actor };
type Scenario = { name: string; build: (ctx: Ctx) => Promise<Subject> };
type Outcome = { caps: boolean | undefined; del: "ok" | number };

const db = new PrismaClient();
const prisma = new PrismaService();
const expenses = new ExpenseService(prisma, new ConciliacaoService(prisma));

class Ctx {
  n = 0;
  accountId = "";
  cardId = "";
  constructor(readonly f: Fixture) {}
  get tenantId() { return this.f.tenantId; }
  get personal() { return this.f.projectId; }
  get reform() { return this.f.targetProjectId; }
  tag() { return `${++this.n}`; }
  neg(over: Record<string, unknown> = {}) {
    return db.expense.create({
      data: {
        tenantId: this.tenantId,
        projectId: this.personal,
        tipoDespesa: "OUTROS",
        valor: -1000,
        valorTotal: -1000,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PAGO",
        dataPagamento: new Date("2026-09-10T00:00:00Z"),
        ...over,
      } as never,
    });
  }
  plain(projectId: string, over: Record<string, unknown> = {}) {
    return this.neg({ projectId, valor: 5000, valorTotal: 5000, ...over });
  }
  /** A refund-eligible clone of the fixture source with its own CFE, optionally applied. */
  async purpose(apply: boolean, sourceOver: Record<string, unknown> = {}) {
    const t = this.tag();
    const { id: _id, createdAt: _c, updatedAt: _u, ...base } = this.f.source;
    const source = await db.expense.create({
      data: { ...base, externalId: `corpus-${t}`, ...sourceOver } as never,
    });
    const { id: _cid, createdAt: _cc, updatedAt: _cu, ...cfe } = this.f.cfe;
    await db.cashFlowEntry.create({ data: { ...cfe, expenseId: source.id } as never });
    if (!apply) return { source, targetId: null as string | null };
    const preview = await this.f.service.execute(this.tenantId, this.personal, source.id, this.f.requester, {
      mode: "preview", targetProjectId: this.reform, roomId: null,
    });
    await this.f.service.execute(this.tenantId, this.personal, source.id, this.f.requester, {
      mode: "apply", targetProjectId: this.reform, roomId: null,
      expectedRevision: preview.revision, expectedFingerprint: preview.fingerprint,
    });
    const edge = await db.rateioAllocation.findFirstOrThrow({ where: { sourceExpenseId: source.id } });
    return { source, targetId: edge.targetExpenseId };
  }
  /** Own card + import batch so scenarios that damage them never leak into others. */
  async ownBatch(last4: string) {
    const card = await seedCardWithClosingDue(db, { tenantId: this.tenantId, projectId: this.personal, last4 });
    const batch = await db.creditCardStatementImport.create({
      data: { tenantId: this.tenantId, cardId: card.id, source: "CSV_GENERIC", periodLabel: "2026-09" },
    });
    return { card, batch, over: { importId: batch.id, cardLast4: card.last4 } };
  }
  async claim(purchaseExpenseId: string) {
    const cfe = await db.cashFlowEntry.findFirstOrThrow({ where: { expenseId: purchaseExpenseId } });
    await db.importedInvoiceLiquidation.create({
      data: {
        tenantId: this.tenantId, paymentExpenseId: purchaseExpenseId, importId: `${this.tenantId}-imp`,
        purchaseExpenseId, cashFlowEntryId: cfe.id, cardId: this.cardId,
        prevStatus: "PLANEJADO", entryValorCents: 100, dueMonth: "2026-09",
      },
    });
  }
  allocate(sourceExpenseId: string, targetExpenseId: string) {
    return db.rateioAllocation.create({
      data: { tenantId: this.tenantId, sourceExpenseId, targetExpenseId, allocation: -1000, plannedStatus: "PLANEJADO" },
    });
  }
  settle(sourceExpenseId: string, targetExpenseId: string, mode: string) {
    return db.crossProjectSettlement.create({
      data: {
        tenantId: this.tenantId, sourceExpenseId, targetExpenseId, parcelaIndex: 0, realValor: 1000,
        plannedValor: 5000, plannedStatus: "PLANEJADO", mode,
        ...(mode === "ADDITIVE"
          ? {
              requestId: `req-${this.tag()}`, createdByUserId: `${this.tenantId}-owner`, snapshot: "{}",
              sourceCashFlowEntryId: `sc-${this.n}`, targetPaidCashFlowEntryId: `tp-${this.n}`,
              targetPendingCashFlowEntryId: `tn-${this.n}`,
            }
          : {}),
      },
    });
  }
  subject(id: string, projectId: string, actor: Actor = "owner"): Subject {
    return { id, projectId, actor };
  }
}

const SCENARIOS: Scenario[] = [
  { name: "plain-negative", build: async (c) => c.subject((await c.neg()).id, c.personal) },
  { name: "purpose-source-valid", build: async (c) => c.subject((await c.purpose(true)).source.id, c.personal) },
  {
    name: "purpose-target",
    build: async (c) => c.subject((await c.purpose(true)).targetId!, c.reform),
  },
  {
    name: "purpose-source-target-title-drift",
    build: async (c) => {
      const { source, targetId } = await c.purpose(true);
      await db.expense.update({ where: { id: targetId! }, data: { titulo: "drifted" } });
      return c.subject(source.id, c.personal);
    },
  },
  {
    name: "purpose-source-target-cfe-drift",
    build: async (c) => {
      const { source, targetId } = await c.purpose(true);
      await db.cashFlowEntry.updateMany({ where: { expenseId: targetId! }, data: { valor: -1 } });
      return c.subject(source.id, c.personal);
    },
  },
  {
    name: "purpose-source-extra-allocation",
    build: async (c) => {
      const { source } = await c.purpose(true);
      await c.allocate(source.id, (await c.plain(c.reform)).id);
      return c.subject(source.id, c.personal);
    },
  },
  {
    name: "purpose-source-hidden-target-project",
    build: async (c) => c.subject((await c.purpose(true)).source.id, c.personal, "limited"),
  },
  {
    name: "purpose-source-ledger-claim",
    build: async (c) => {
      const { source } = await c.purpose(true);
      await c.claim(source.id);
      return c.subject(source.id, c.personal);
    },
  },
  {
    name: "purpose-source-import-batch-not-completed",
    build: async (c) => {
      const own = await c.ownBatch("0998");
      const { source } = await c.purpose(true, own.over);
      await db.creditCardStatementImport.update({ where: { id: own.batch.id }, data: { status: "FAILED" } });
      return c.subject(source.id, c.personal);
    },
  },
  {
    name: "purpose-source-card-soft-deleted",
    build: async (c) => {
      const own = await c.ownBatch("0999");
      const { source } = await c.purpose(true, own.over);
      await db.creditCard.update({ where: { id: own.card.id }, data: { deletedAt: new Date() } });
      return c.subject(source.id, c.personal);
    },
  },
  {
    name: "purpose-source-ambiguous-last4-card",
    build: async (c) => {
      await seedCardWithClosingDue(db, { tenantId: c.tenantId, projectId: c.personal, last4: c.f.card.last4, nickname: "twin" });
      return c.subject((await c.purpose(true)).source.id, c.personal);
    },
  },
  {
    name: "linked-live-target",
    build: async (c) => {
      const target = await c.plain(c.personal);
      return c.subject((await c.neg({ linkedExpenseId: target.id })).id, c.personal);
    },
  },
  {
    name: "linked-soft-deleted-target",
    build: async (c) => {
      const target = await c.plain(c.personal, { deletedAt: new Date() });
      return c.subject((await c.neg({ linkedExpenseId: target.id })).id, c.personal);
    },
  },
  {
    name: "linked-target-hidden-project",
    build: async (c) => {
      const target = await c.plain(c.reform);
      return c.subject((await c.neg({ linkedExpenseId: target.id })).id, c.personal, "limited");
    },
  },
  {
    name: "linked-target-visible-other-project",
    build: async (c) => {
      const target = await c.plain(c.reform);
      return c.subject((await c.neg({ linkedExpenseId: target.id })).id, c.personal);
    },
  },
  {
    name: "linked-target-other-tenant",
    build: async (c) => {
      const other = `${c.tenantId}-b`;
      await db.tenant.create({ data: { id: other, name: "corpus other tenant" } });
      const project = await db.project.create({ data: { tenantId: other, type: "PESSOAL", name: "other" } });
      const target = await c.plain(project.id, { tenantId: other });
      return c.subject((await c.neg({ linkedExpenseId: target.id })).id, c.personal);
    },
  },
  {
    name: "mirror-visible",
    build: async (c) => {
      const s = await c.neg();
      await c.plain(c.personal, { linkedExpenseId: s.id });
      return c.subject(s.id, c.personal);
    },
  },
  {
    name: "mirror-hidden-project",
    build: async (c) => {
      const s = await c.neg();
      await c.plain(c.reform, { linkedExpenseId: s.id });
      return c.subject(s.id, c.personal, "limited");
    },
  },
  {
    name: "mirror-soft-deleted",
    build: async (c) => {
      const s = await c.neg();
      await c.plain(c.reform, { linkedExpenseId: s.id, deletedAt: new Date() });
      return c.subject(s.id, c.personal, "limited");
    },
  },
  {
    name: "mirror-in-settlement",
    build: async (c) => {
      const s = await c.neg();
      const m = await c.plain(c.personal, { linkedExpenseId: s.id });
      await c.settle(m.id, (await c.plain(c.reform)).id, "LEGACY_REPLACEMENT");
      return c.subject(s.id, c.personal);
    },
  },
  {
    name: "plain-negative-ledger-claim",
    build: async (c) => {
      const s = await c.neg();
      await db.cashFlowEntry.create({
        data: { tenantId: c.tenantId, projectId: c.personal, expenseId: s.id, valor: s.valorTotal, tipo: "DESPESA", data: s.dataPagamento!, categoria: "OUTROS", formaPagamento: "A_VISTA", status: "PAGO" },
      });
      await c.claim(s.id);
      return c.subject(s.id, c.personal);
    },
  },
  { name: "invoice-undo-state", build: async (c) => c.subject((await c.neg({ invoiceUndoState: "PROCESSED_NONE" })).id, c.personal) },
  { name: "manual-invoice-key", build: async (c) => c.subject((await c.neg({ settlesInvoiceKey: "m1:x" })).id, c.personal) },
  { name: "documented-schedule", build: async (c) => c.subject((await c.neg({ documentedSchedule: "{}" })).id, c.personal) },
  {
    name: "rateio-source-plain",
    build: async (c) => {
      const s = await c.neg();
      await c.allocate(s.id, (await c.plain(c.reform)).id);
      return c.subject(s.id, c.personal);
    },
  },
  {
    name: "rateio-source-hidden-target",
    build: async (c) => {
      const s = await c.neg();
      await c.allocate(s.id, (await c.plain(c.reform)).id);
      return c.subject(s.id, c.personal, "limited");
    },
  },
  {
    name: "rateio-source-target-claimed",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await db.cashFlowEntry.create({
        data: { tenantId: c.tenantId, projectId: c.reform, expenseId: t.id, valor: 5000, tipo: "DESPESA", data: new Date("2026-09-10T00:00:00Z"), categoria: "OUTROS", formaPagamento: "A_VISTA", status: "PAGO" },
      });
      await c.allocate(s.id, t.id);
      await c.claim(t.id);
      return c.subject(s.id, c.personal);
    },
  },
  {
    name: "rateio-source-target-soft-deleted",
    build: async (c) => {
      const s = await c.neg();
      await c.allocate(s.id, (await c.plain(c.reform, { deletedAt: new Date() })).id);
      return c.subject(s.id, c.personal);
    },
  },
  {
    name: "rateio-target-plain",
    build: async (c) => {
      const t = await c.neg();
      await c.allocate((await c.plain(c.personal)).id, t.id);
      return c.subject(t.id, c.personal);
    },
  },
  {
    name: "settlement-source-legacy",
    build: async (c) => {
      const s = await c.neg();
      await c.settle(s.id, (await c.plain(c.reform)).id, "LEGACY_REPLACEMENT");
      return c.subject(s.id, c.personal);
    },
  },
  {
    name: "settlement-source-hidden-target",
    build: async (c) => {
      const s = await c.neg();
      await c.settle(s.id, (await c.plain(c.reform)).id, "LEGACY_REPLACEMENT");
      return c.subject(s.id, c.personal, "limited");
    },
  },
  {
    name: "settlement-source-additive",
    build: async (c) => {
      const s = await c.neg();
      await c.settle(s.id, (await c.plain(c.reform)).id, "ADDITIVE");
      return c.subject(s.id, c.personal);
    },
  },
  {
    name: "settlement-source-reversed-additive-only",
    build: async (c) => {
      const s = await c.neg();
      const row = await c.settle(s.id, (await c.plain(c.reform)).id, "ADDITIVE");
      await db.crossProjectSettlement.update({ where: { id: row.id }, data: { reversedAt: new Date(), reversedByUserId: `${c.tenantId}-owner` } });
      return c.subject(s.id, c.personal);
    },
  },
  {
    name: "settlement-target",
    build: async (c) => {
      const t = await c.neg();
      await c.settle((await c.plain(c.personal)).id, t.id, "LEGACY_REPLACEMENT");
      return c.subject(t.id, c.personal);
    },
  },
  { name: "actor-without-project", build: async (c) => c.subject((await c.neg()).id, c.personal, "limited-none") },
];

/**
 * Pinned against a135 before the refactor. `del` is the real DELETE outcome
 * ("ok" or the HTTP status of the refusal); `caps` is the returned canDelete.
 */
const EXPECTED: Record<string, Outcome> = {
  "plain-negative": { caps: true, del: "ok" },
  "purpose-source-valid": { caps: true, del: "ok" },
  "purpose-target": { caps: false, del: 409 },
  "purpose-source-target-title-drift": { caps: false, del: 409 },
  "purpose-source-target-cfe-drift": { caps: false, del: 409 },
  "purpose-source-extra-allocation": { caps: false, del: 409 },
  "purpose-source-hidden-target-project": { caps: false, del: 404 },
  "purpose-source-ledger-claim": { caps: false, del: 409 },
  "purpose-source-import-batch-not-completed": { caps: false, del: 409 },
  "purpose-source-card-soft-deleted": { caps: false, del: 404 },
  "purpose-source-ambiguous-last4-card": { caps: true, del: "ok" },
  "linked-live-target": { caps: true, del: "ok" },
  "linked-soft-deleted-target": { caps: false, del: 404 },
  "linked-target-hidden-project": { caps: false, del: 404 },
  "linked-target-visible-other-project": { caps: true, del: "ok" },
  "linked-target-other-tenant": { caps: false, del: 404 },
  "mirror-visible": { caps: true, del: "ok" },
  "mirror-hidden-project": { caps: false, del: 404 },
  "mirror-soft-deleted": { caps: true, del: "ok" },
  "mirror-in-settlement": { caps: true, del: "ok" },
  "plain-negative-ledger-claim": { caps: false, del: 409 },
  "invoice-undo-state": { caps: false, del: 409 },
  "manual-invoice-key": { caps: false, del: 409 },
  "documented-schedule": { caps: false, del: 409 },
  "rateio-source-plain": { caps: true, del: "ok" },
  "rateio-source-hidden-target": { caps: false, del: 404 },
  "rateio-source-target-claimed": { caps: false, del: 409 },
  "rateio-source-target-soft-deleted": { caps: true, del: "ok" },
  "rateio-target-plain": { caps: false, del: 400 },
  "settlement-source-legacy": { caps: true, del: "ok" },
  "settlement-source-hidden-target": { caps: false, del: 404 },
  "settlement-source-additive": { caps: false, del: 409 },
  "settlement-source-reversed-additive-only": { caps: true, del: "ok" },
  "settlement-target": { caps: false, del: 400 },
  "actor-without-project": { caps: false, del: 404 },
};

/**
 * Two a135 baseline defects were fixed by the batched read (capability tightened
 * true -> false only, DELETE untouched):
 *  - "documented-schedule": the capability skipped the documented-schedule guard
 *    for rows with no related rows, so it said true while DELETE answered 409;
 *  - an id hard-deleted after the list was read inherited `true` from the stale
 *    list object. Rows are now re-read inside the same transaction.
 */
const STALE_GONE = false;

const bootstrap = async (ctx: Ctx) => {
  const account = await seedBankAccount(db, { tenantId: ctx.tenantId, projectId: ctx.personal, last4: "0705" });
  ctx.accountId = account.id;
  ctx.cardId = ctx.f.card.id;
  await seedStatementImport(db, { tenantId: ctx.tenantId, accountId: account.id, id: `${ctx.tenantId}-imp` });
  for (const [id, name, modules, projects, types] of [
    ["personal-only", "personal-only", ["expenses", "monthlyOverview"], [ctx.personal], ["PESSOAL"]],
    ["none", "none", ["expenses"], [ctx.reform], ["REFORMA"]],
  ] as const) {
    await db.user.create({
      data: {
        id: `${ctx.tenantId}-${id}`, tenantId: ctx.tenantId, username: name, name, role: "USER",
        allowedProjects: JSON.stringify(projects), allowedProjectTypes: JSON.stringify(types),
        allowedModules: JSON.stringify(modules),
      },
    });
  }
};
const requesterFor = (ctx: Ctx, actor: Actor) =>
  actor === "owner" ? ctx.f.requester
    : { id: `${ctx.tenantId}-${actor === "limited" ? "personal-only" : "none"}`, role: "USER" };
const snapshot = async (tenantId: string) =>
  JSON.stringify({
    e: await db.expense.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
    c: await db.cashFlowEntry.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
    a: await db.rateioAllocation.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
    s: await db.crossProjectSettlement.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
    l: await db.importedInvoiceLiquidation.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
  });

describe("#704 R3 canDelete baseline corpus (literal a135 expectations)", () => {
  let ctx: Ctx;
  let subjects: Map<string, Subject>;
  beforeAll(async () => {
    const f = await refundFixture(db, prisma, "refund-corpus");
    ctx = new Ctx(f);
    await bootstrap(ctx);
    subjects = new Map();
    for (const scenario of SCENARIOS) {
      try {
        subjects.set(scenario.name, await scenario.build(ctx));
      } catch (error) {
        throw new Error(`scenario ${scenario.name}: ${String(error).slice(0, 600)}`);
      }
    }
  }, 120000);
  afterAll(async () => {
    const other = `${ctx.tenantId}-b`;
    await db.expense.updateMany({ where: { tenantId: ctx.tenantId }, data: { linkedExpenseId: null } });
    await db.expense.deleteMany({ where: { tenantId: other } });
    await db.project.deleteMany({ where: { tenantId: other } });
    await db.tenant.deleteMany({ where: { id: other } });
    await ctx.f.cleanup();
    await db.$disconnect();
    await prisma.$disconnect();
  });

  const rowOf = (name: string) => db.expense.findUniqueOrThrow({ where: { id: subjects.get(name)!.id } });
  const capsOf = async (name: string) => {
    const s = subjects.get(name)!;
    const [out] = await expenses.withDeleteCapabilities(ctx.tenantId, [await rowOf(name)], requesterFor(ctx, s.actor) as never);
    return (out as { canDelete?: boolean }).canDelete;
  };

  it("capability per subject matches the pinned literals, one at a time, with zero writes", async () => {
    const before = await snapshot(ctx.tenantId);
    const observed: Record<string, boolean | undefined> = {};
    for (const scenario of SCENARIOS) observed[scenario.name] = await capsOf(scenario.name);
    expect(await snapshot(ctx.tenantId)).toBe(before);
    if (process.env.CORPUS_DUMP) console.log("CAPS " + JSON.stringify(observed));
    expect(observed).toEqual(Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, v.caps])));
  }, 120000);

  it("the whole corpus read in ONE batch per actor equals the one-at-a-time literals", async () => {
    const before = await snapshot(ctx.tenantId);
    const observed: Record<string, boolean | undefined> = {};
    for (const actor of ["owner", "limited", "limited-none"] as const) {
      const names = SCENARIOS.filter((scenario) => subjects.get(scenario.name)!.actor === actor).map((scenario) => scenario.name);
      if (!names.length) continue;
      const rows = await Promise.all(names.map(rowOf));
      const out = await expenses.withDeleteCapabilities(ctx.tenantId, rows, requesterFor(ctx, actor) as never);
      names.forEach((name, index) => {
        observed[name] = (out[index] as { canDelete?: boolean }).canDelete;
      });
    }
    expect(await snapshot(ctx.tenantId)).toBe(before);
    expect(observed).toEqual(Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, v.caps])));
  }, 120000);

  it("an unexpected error while loading or deciding propagates instead of becoming false", async () => {
    const [name] = SCENARIOS.map((scenario) => scenario.name);
    const row = await rowOf(name);
    const requester = requesterFor(ctx, subjects.get(name)!.actor) as never;
    const load = jest.spyOn(RemovalContext.prototype, "loadLedgerByExpense").mockRejectedValueOnce(new Error("boom-load"));
    const decide = jest.spyOn(RemovalContext.prototype, "activePurchaseTrail").mockImplementationOnce(() => {
      throw new TypeError("boom-decide");
    });
    try {
      await expect(expenses.withDeleteCapabilities(ctx.tenantId, [row], requester)).rejects.toThrow("boom-load");
      await expect(expenses.withDeleteCapabilities(ctx.tenantId, [row], requester)).rejects.toThrow("boom-decide");
    } finally {
      load.mockRestore();
      decide.mockRestore();
    }
    const [ok] = await expenses.withDeleteCapabilities(ctx.tenantId, [row], requester);
    expect((ok as { canDelete?: boolean }).canDelete).toBe(EXPECTED[name].caps);
  });

  it("stale, foreign, soft-deleted and positive rows never inherit a capability", async () => {
    const live = await ctx.neg();
    const gone = await ctx.neg();
    const softDeleted = await ctx.neg({ deletedAt: new Date() });
    const positive = await ctx.plain(ctx.personal);
    const staleGone = { ...gone };
    await db.expense.deleteMany({ where: { id: gone.id } });
    const other = await ctx.neg();
    const foreign = { ...other, tenantId: `${ctx.tenantId}-b` };
    // A row that changed tenant after the list was built must not keep the old object's capability.
    const foreignTenant = `${ctx.tenantId}-b`;
    await db.tenant.upsert({ where: { id: foreignTenant }, update: {}, create: { id: foreignTenant, name: "corpus other tenant" } });
    const foreignProject = await db.project.create({ data: { tenantId: foreignTenant, type: "PESSOAL", name: "moved" } });
    const staleMoved = await ctx.neg();
    await db.expense.update({ where: { id: staleMoved.id }, data: { tenantId: foreignTenant, projectId: foreignProject.id } });
    const out = await expenses.withDeleteCapabilities(
      ctx.tenantId,
      [live, staleGone, softDeleted, foreign, { ...staleMoved }, positive] as never,
      ctx.f.requester as never,
    );
    expect(out.map((row) => (row as { canDelete?: boolean }).canDelete)).toEqual([true, STALE_GONE, false, false, false, undefined]);
    expect("canDelete" in out[5]).toBe(false);
  });

  it("capability agrees with the real DELETE outcome literals (true => ok, false => refusal)", async () => {
    const observed: Record<string, "ok" | number> = {};
    const caps: Record<string, boolean | undefined> = {};
    for (const scenario of SCENARIOS) {
      const s = subjects.get(scenario.name)!;
      caps[scenario.name] = await capsOf(scenario.name);
      try {
        await expenses.remove(ctx.tenantId, s.projectId, s.id, requesterFor(ctx, s.actor) as never);
        observed[scenario.name] = "ok";
      } catch (error) {
        observed[scenario.name] = (error as { status?: number }).status ?? -1;
      }
    }
    if (process.env.CORPUS_DUMP) console.log("DEL " + JSON.stringify(observed));
    expect(observed).toEqual(Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, v.del])));
    // capability must never promise a DELETE that refuses
    for (const [name, del] of Object.entries(observed)) if (caps[name] === true) expect([name, del]).toEqual([name, "ok"]);
  }, 120000);
});
