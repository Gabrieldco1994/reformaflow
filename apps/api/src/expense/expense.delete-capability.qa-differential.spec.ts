/**
 * #704 R3 QA — differential against the PRE-refactor tree.
 *
 * `__tests__/r3-baseline-differential.json` holds what `ad851b49` (per-source prepareRemoval, real
 * PrismaService + SQLite) answered for every scenario below: canDelete, the real DELETE status and
 * message, and the DELETE side effects (soft-deletes, CFEs, allocations, settlements). The candidate
 * must reproduce them. The fixture is data captured from the old tree — never regenerate it from the
 * code under test (DELETE now shares its validator with the capability read).
 *
 * Known, intentional divergences (tightening only, capability true -> false while DELETE was already
 * refusing) are the "stale list object" rows: they are pinned separately below.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import {
  seedBankAccount,
  seedCardWithClosingDue,
  seedStatementImport,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { refundFixture } from "./__tests__/refund-purpose.fixture";
import { ExpenseService } from "./expense.service";

type Fixture = Awaited<ReturnType<typeof refundFixture>>;
type Actor = "owner" | "limited" | "limited-none";
type Built = {
  id: string;
  projectId: string;
  actor: Actor;
  labels: Record<string, string>;
};

const db = new PrismaClient();
const prisma = new PrismaService();
const expenses = new ExpenseService(prisma, new ConciliacaoService(prisma));

class Ctx {
  n = 0;
  cardId = "";
  other = "";
  otherProject = "";
  constructor(readonly f: Fixture) {}
  get tenantId() {
    return this.f.tenantId;
  }
  get personal() {
    return this.f.projectId;
  }
  get reform() {
    return this.f.targetProjectId;
  }
  tag() {
    return `${++this.n}`;
  }
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
  async purpose(sourceOver: Record<string, unknown> = {}) {
    const t = this.tag();
    const { id: _i, createdAt: _c, updatedAt: _u, ...base } = this.f.source;
    const source = await db.expense.create({
      data: { ...base, externalId: `diff-${t}`, ...sourceOver } as never,
    });
    const { id: _ci, createdAt: _cc, updatedAt: _cu, ...cfe } = this.f.cfe;
    await db.cashFlowEntry.create({
      data: { ...cfe, expenseId: source.id } as never,
    });
    const preview = await this.f.service.execute(
      this.tenantId,
      this.personal,
      source.id,
      this.f.requester,
      {
        mode: "preview",
        targetProjectId: this.reform,
        roomId: null,
      },
    );
    await this.f.service.execute(
      this.tenantId,
      this.personal,
      source.id,
      this.f.requester,
      {
        mode: "apply",
        targetProjectId: this.reform,
        roomId: null,
        expectedRevision: preview.revision,
        expectedFingerprint: preview.fingerprint,
      },
    );
    const edge = await db.rateioAllocation.findFirstOrThrow({
      where: { sourceExpenseId: source.id },
    });
    return { source, targetId: edge.targetExpenseId };
  }
  async claim(purchaseExpenseId: string, over: Record<string, unknown> = {}) {
    const cfe = await db.cashFlowEntry.findFirstOrThrow({
      where: { expenseId: purchaseExpenseId },
    });
    await db.importedInvoiceLiquidation.create({
      data: {
        tenantId: this.tenantId,
        paymentExpenseId: purchaseExpenseId,
        importId: `${this.tenantId}-imp`,
        purchaseExpenseId,
        cashFlowEntryId: cfe.id,
        cardId: this.cardId,
        prevStatus: "PLANEJADO",
        entryValorCents: 100,
        dueMonth: "2026-09",
        ...over,
      } as never,
    });
  }
  allocate(
    sourceExpenseId: string,
    targetExpenseId: string,
    over: Record<string, unknown> = {},
  ) {
    return db.rateioAllocation.create({
      data: {
        tenantId: this.tenantId,
        sourceExpenseId,
        targetExpenseId,
        allocation: -1000,
        plannedStatus: "PLANEJADO",
        ...over,
      } as never,
    });
  }
  settle(
    sourceExpenseId: string,
    targetExpenseId: string,
    mode: string,
    o: { reversed?: boolean; tenantId?: string } = {},
  ) {
    const t = this.tag();
    const tenantId = o.tenantId ?? this.tenantId;
    return db.crossProjectSettlement.create({
      data: {
        tenantId,
        sourceExpenseId,
        targetExpenseId,
        parcelaIndex: 0,
        realValor: 1000,
        plannedValor: 5000,
        plannedStatus: "PLANEJADO",
        mode,
        ...(mode === "ADDITIVE"
          ? {
              requestId: `req-${t}`,
              createdByUserId: `${this.tenantId}-owner`,
              snapshot: "{}",
              sourceCashFlowEntryId: `sc-${t}`,
              targetPaidCashFlowEntryId: `tp-${t}`,
              targetPendingCashFlowEntryId: `tn-${t}`,
            }
          : {}),
        ...(o.reversed
          ? {
              reversedAt: new Date("2026-09-20T00:00:00Z"),
              reversedByUserId: `${this.tenantId}-owner`,
            }
          : {}),
      } as never,
    });
  }
  b(
    id: string,
    projectId: string,
    actor: Actor = "owner",
    labels: Record<string, string> = {},
  ): Built {
    return { id, projectId, actor, labels: { subject: id, ...labels } };
  }
}

const SCENARIOS: Array<{ name: string; build: (c: Ctx) => Promise<Built> }> = [
  {
    name: "add-active-source",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await c.settle(s.id, t.id, "ADDITIVE");
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "add-active-source-limited",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await c.settle(s.id, t.id, "ADDITIVE");
      return c.b(s.id, c.personal, "limited", { t: t.id });
    },
  },
  {
    name: "add-reversed-source",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await c.settle(s.id, t.id, "ADDITIVE", { reversed: true });
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "add-reversed-plus-active-source",
    build: async (c) => {
      const s = await c.neg();
      const t1 = await c.plain(c.reform);
      const t2 = await c.plain(c.reform);
      await c.settle(s.id, t1.id, "ADDITIVE", { reversed: true });
      await c.settle(s.id, t2.id, "ADDITIVE");
      return c.b(s.id, c.personal, "owner", { t1: t1.id, t2: t2.id });
    },
  },
  {
    name: "legacy-active-source",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await c.settle(s.id, t.id, "LEGACY_REPLACEMENT");
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "legacy-reversed-source",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await c.settle(s.id, t.id, "LEGACY_REPLACEMENT", { reversed: true });
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "legacy-active-plus-add-reversed-source",
    build: async (c) => {
      const s = await c.neg();
      const t1 = await c.plain(c.reform);
      const t2 = await c.plain(c.reform);
      await c.settle(s.id, t1.id, "ADDITIVE", { reversed: true });
      await c.settle(s.id, t2.id, "LEGACY_REPLACEMENT");
      return c.b(s.id, c.personal, "owner", { t1: t1.id, t2: t2.id });
    },
  },
  {
    name: "legacy-active-plus-add-active-source",
    build: async (c) => {
      const s = await c.neg();
      const t1 = await c.plain(c.reform);
      const t2 = await c.plain(c.reform);
      await c.settle(s.id, t1.id, "ADDITIVE");
      await c.settle(s.id, t2.id, "LEGACY_REPLACEMENT");
      return c.b(s.id, c.personal, "owner", { t1: t1.id, t2: t2.id });
    },
  },
  {
    name: "legacy-reversed-plus-add-active-source",
    build: async (c) => {
      const s = await c.neg();
      const t1 = await c.plain(c.reform);
      const t2 = await c.plain(c.reform);
      await c.settle(s.id, t1.id, "LEGACY_REPLACEMENT", { reversed: true });
      await c.settle(s.id, t2.id, "ADDITIVE");
      return c.b(s.id, c.personal, "owner", { t1: t1.id, t2: t2.id });
    },
  },
  {
    name: "legacy-active-target-also-add-reversed",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await c.settle(s.id, t.id, "LEGACY_REPLACEMENT");
      await c.settle((await c.plain(c.personal)).id, t.id, "ADDITIVE", {
        reversed: true,
      });
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "legacy-active-target-also-add-active",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await c.settle(s.id, t.id, "LEGACY_REPLACEMENT");
      await c.settle((await c.plain(c.personal)).id, t.id, "ADDITIVE");
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "mirror-soft-deleted-with-invoice-key",
    build: async (c) => {
      const s = await c.neg();
      const m = await c.plain(c.personal, {
        linkedExpenseId: s.id,
        settlesInvoiceKey: "m1:sd",
        deletedAt: new Date(),
      });
      return c.b(s.id, c.personal, "owner", { m: m.id });
    },
  },
  {
    name: "mirror-soft-deleted-with-documented-schedule",
    build: async (c) => {
      const s = await c.neg();
      const m = await c.plain(c.personal, {
        linkedExpenseId: s.id,
        documentedSchedule: "{}",
        deletedAt: new Date(),
      });
      return c.b(s.id, c.personal, "owner", { m: m.id });
    },
  },
  {
    name: "mirror-soft-deleted-in-add-active",
    build: async (c) => {
      const s = await c.neg();
      const m = await c.plain(c.personal, {
        linkedExpenseId: s.id,
        deletedAt: new Date(),
      });
      await c.settle(m.id, (await c.plain(c.reform)).id, "ADDITIVE");
      return c.b(s.id, c.personal, "owner", { m: m.id });
    },
  },
  {
    name: "mirror-soft-deleted-rateio-source",
    build: async (c) => {
      const s = await c.neg();
      const m = await c.plain(c.personal, {
        linkedExpenseId: s.id,
        deletedAt: new Date(),
      });
      await c.allocate(m.id, (await c.plain(c.reform)).id);
      return c.b(s.id, c.personal, "owner", { m: m.id });
    },
  },
  {
    name: "add-active-target",
    build: async (c) => {
      const t = await c.neg();
      const s = await c.plain(c.personal);
      await c.settle(s.id, t.id, "ADDITIVE");
      return c.b(t.id, c.personal, "owner", { s: s.id });
    },
  },
  {
    name: "add-reversed-target",
    build: async (c) => {
      const t = await c.neg();
      const s = await c.plain(c.personal);
      await c.settle(s.id, t.id, "ADDITIVE", { reversed: true });
      return c.b(t.id, c.personal, "owner", { s: s.id });
    },
  },
  {
    name: "legacy-reversed-target",
    build: async (c) => {
      const t = await c.neg();
      const s = await c.plain(c.personal);
      await c.settle(s.id, t.id, "LEGACY_REPLACEMENT", { reversed: true });
      return c.b(t.id, c.personal, "owner", { s: s.id });
    },
  },
  {
    name: "add-active-target-source-soft-deleted",
    build: async (c) => {
      const t = await c.neg();
      const s = await c.plain(c.personal);
      await c.settle(s.id, t.id, "ADDITIVE");
      await db.expense.update({
        where: { id: s.id },
        data: { deletedAt: new Date() },
      });
      return c.b(t.id, c.personal, "owner", { s: s.id });
    },
  },
  {
    name: "add-active-source-target-soft-deleted",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await c.settle(s.id, t.id, "ADDITIVE");
      await db.expense.update({
        where: { id: t.id },
        data: { deletedAt: new Date() },
      });
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "add-active-foreign-tenant-row",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await c.settle(s.id, t.id, "ADDITIVE", { tenantId: c.other });
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "legacy-active-foreign-tenant-row",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await c.settle(s.id, t.id, "LEGACY_REPLACEMENT", { tenantId: c.other });
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "purpose-target-add-active",
    build: async (c) => {
      const p = await c.purpose();
      await c.settle((await c.plain(c.personal)).id, p.targetId, "ADDITIVE");
      return c.b(p.source.id, c.personal, "owner", { t: p.targetId });
    },
  },
  {
    name: "purpose-target-add-reversed",
    build: async (c) => {
      const p = await c.purpose();
      await c.settle((await c.plain(c.personal)).id, p.targetId, "ADDITIVE", {
        reversed: true,
      });
      return c.b(p.source.id, c.personal, "owner", { t: p.targetId });
    },
  },
  {
    name: "purpose-target-legacy-active",
    build: async (c) => {
      const p = await c.purpose();
      await c.settle(
        (await c.plain(c.personal)).id,
        p.targetId,
        "LEGACY_REPLACEMENT",
      );
      return c.b(p.source.id, c.personal, "owner", { t: p.targetId });
    },
  },
  {
    name: "purpose-target-legacy-reversed",
    build: async (c) => {
      const p = await c.purpose();
      await c.settle(
        (await c.plain(c.personal)).id,
        p.targetId,
        "LEGACY_REPLACEMENT",
        { reversed: true },
      );
      return c.b(p.source.id, c.personal, "owner", { t: p.targetId });
    },
  },
  {
    name: "purpose-target-add-active-limited",
    build: async (c) => {
      const p = await c.purpose();
      await c.settle((await c.plain(c.personal)).id, p.targetId, "ADDITIVE");
      return c.b(p.source.id, c.personal, "limited", { t: p.targetId });
    },
  },
  {
    name: "purpose-source-as-settlement-source-add-active",
    build: async (c) => {
      const p = await c.purpose();
      await c.settle(p.source.id, (await c.plain(c.reform)).id, "ADDITIVE");
      return c.b(p.source.id, c.personal, "owner", { t: p.targetId });
    },
  },
  {
    name: "purpose-source-as-settlement-source-add-reversed",
    build: async (c) => {
      const p = await c.purpose();
      await c.settle(p.source.id, (await c.plain(c.reform)).id, "ADDITIVE", {
        reversed: true,
      });
      return c.b(p.source.id, c.personal, "owner", { t: p.targetId });
    },
  },
  {
    name: "purpose-target-soft-deleted",
    build: async (c) => {
      const p = await c.purpose();
      await db.expense.update({
        where: { id: p.targetId },
        data: { deletedAt: new Date() },
      });
      return c.b(p.source.id, c.personal, "owner", { t: p.targetId });
    },
  },
  {
    name: "purpose-source-foreign-tenant-allocation",
    build: async (c) => {
      const p = await c.purpose();
      await c.allocate(p.source.id, (await c.plain(c.reform)).id, {
        tenantId: c.other,
      });
      return c.b(p.source.id, c.personal, "owner", { t: p.targetId });
    },
  },
  {
    name: "purpose-source-incoming-mirror",
    build: async (c) => {
      const p = await c.purpose();
      const m = await c.plain(c.personal, { linkedExpenseId: p.source.id });
      return c.b(p.source.id, c.personal, "owner", { t: p.targetId, m: m.id });
    },
  },
  {
    name: "purpose-source-claim-soft-deleted-ledger",
    build: async (c) => {
      const p = await c.purpose();
      await c.claim(p.source.id, { deletedAt: new Date() });
      return c.b(p.source.id, c.personal, "owner", { t: p.targetId });
    },
  },
  {
    name: "purpose-source-claim-foreign-tenant-ledger",
    build: async (c) => {
      const p = await c.purpose();
      await c.claim(p.source.id, { tenantId: c.other });
      return c.b(p.source.id, c.personal, "owner", { t: p.targetId });
    },
  },
  {
    name: "purpose-target-protected-source-soft-deleted",
    build: async (c) => {
      const p = await c.purpose();
      await db.expense.update({
        where: { id: p.source.id },
        data: { deletedAt: new Date() },
      });
      return c.b(p.targetId, c.reform, "owner", { s: p.source.id });
    },
  },
  {
    name: "purpose-target-protected-limited",
    build: async (c) => {
      const p = await c.purpose();
      return c.b(p.targetId, c.reform, "limited", { s: p.source.id });
    },
  },
  {
    name: "rateio-source-target-add-active",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await c.allocate(s.id, t.id);
      await c.settle((await c.plain(c.personal)).id, t.id, "ADDITIVE");
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "rateio-source-target-add-reversed",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await c.allocate(s.id, t.id);
      await c.settle((await c.plain(c.personal)).id, t.id, "ADDITIVE", {
        reversed: true,
      });
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "rateio-source-refund-flag-plain",
    build: async (c) => {
      const s = await c.neg();
      const t = await c.plain(c.reform);
      await c.allocate(s.id, t.id, { isRefundCredit: true });
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "rateio-target-refund-flag-plain",
    build: async (c) => {
      const t = await c.neg();
      const s = await c.plain(c.personal);
      await c.allocate(s.id, t.id, { isRefundCredit: true });
      return c.b(t.id, c.personal, "owner", { s: s.id });
    },
  },
  {
    name: "rateio-source-foreign-tenant-alloc",
    build: async (c) => {
      const s = await c.neg();
      await c.allocate(s.id, (await c.plain(c.reform)).id, {
        tenantId: c.other,
      });
      return c.b(s.id, c.personal);
    },
  },
  {
    name: "linked-target-add-active",
    build: async (c) => {
      const t = await c.plain(c.personal);
      const s = await c.neg({ linkedExpenseId: t.id });
      await c.settle((await c.plain(c.personal)).id, t.id, "ADDITIVE");
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "linked-target-add-reversed",
    build: async (c) => {
      const t = await c.plain(c.personal);
      const s = await c.neg({ linkedExpenseId: t.id });
      await c.settle((await c.plain(c.personal)).id, t.id, "ADDITIVE", {
        reversed: true,
      });
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "linked-target-legacy-active",
    build: async (c) => {
      const t = await c.plain(c.personal);
      const s = await c.neg({ linkedExpenseId: t.id });
      await c.settle(
        (await c.plain(c.personal)).id,
        t.id,
        "LEGACY_REPLACEMENT",
      );
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "mirror-add-active",
    build: async (c) => {
      const s = await c.neg();
      const m = await c.plain(c.personal, { linkedExpenseId: s.id });
      await c.settle(m.id, (await c.plain(c.reform)).id, "ADDITIVE");
      return c.b(s.id, c.personal, "owner", { m: m.id });
    },
  },
  {
    name: "mirror-add-reversed",
    build: async (c) => {
      const s = await c.neg();
      const m = await c.plain(c.personal, { linkedExpenseId: s.id });
      await c.settle(m.id, (await c.plain(c.reform)).id, "ADDITIVE", {
        reversed: true,
      });
      return c.b(s.id, c.personal, "owner", { m: m.id });
    },
  },
  {
    name: "mirror-legacy-reversed",
    build: async (c) => {
      const s = await c.neg();
      const m = await c.plain(c.personal, { linkedExpenseId: s.id });
      await c.settle(m.id, (await c.plain(c.reform)).id, "LEGACY_REPLACEMENT", {
        reversed: true,
      });
      return c.b(s.id, c.personal, "owner", { m: m.id });
    },
  },
  {
    name: "mirror-is-rateio-source",
    build: async (c) => {
      const s = await c.neg();
      const m = await c.plain(c.personal, { linkedExpenseId: s.id });
      await c.allocate(m.id, (await c.plain(c.reform)).id);
      return c.b(s.id, c.personal, "owner", { m: m.id });
    },
  },
  {
    name: "mirror-other-tenant",
    build: async (c) => {
      const s = await c.neg();
      const m = await c.plain(c.otherProject, {
        tenantId: c.other,
        linkedExpenseId: s.id,
      });
      return c.b(s.id, c.personal, "owner", { m: m.id });
    },
  },
  {
    name: "linked-cycle-pair",
    build: async (c) => {
      const a = await c.neg();
      const b = await c.neg({ linkedExpenseId: a.id });
      await db.expense.update({
        where: { id: a.id },
        data: { linkedExpenseId: b.id },
      });
      return c.b(a.id, c.personal, "owner", { b: b.id });
    },
  },
  {
    name: "linked-self",
    build: async (c) => {
      const a = await c.neg();
      await db.expense.update({
        where: { id: a.id },
        data: { linkedExpenseId: a.id },
      });
      return c.b(a.id, c.personal);
    },
  },
  {
    name: "linked-target-negative-claimed",
    build: async (c) => {
      const t = await c.neg();
      await db.cashFlowEntry.create({
        data: {
          tenantId: c.tenantId,
          projectId: c.personal,
          expenseId: t.id,
          valor: t.valorTotal,
          tipo: "DESPESA",
          data: t.dataPagamento!,
          categoria: "OUTROS",
          formaPagamento: "A_VISTA",
          status: "PAGO",
        } as never,
      });
      await c.claim(t.id);
      const s = await c.neg({ linkedExpenseId: t.id });
      return c.b(s.id, c.personal, "owner", { t: t.id });
    },
  },
  {
    name: "claim-soft-deleted-ledger-plain",
    build: async (c) => {
      const s = await c.neg();
      await db.cashFlowEntry.create({
        data: {
          tenantId: c.tenantId,
          projectId: c.personal,
          expenseId: s.id,
          valor: s.valorTotal,
          tipo: "DESPESA",
          data: s.dataPagamento!,
          categoria: "OUTROS",
          formaPagamento: "A_VISTA",
          status: "PAGO",
        } as never,
      });
      await c.claim(s.id, { deletedAt: new Date() });
      return c.b(s.id, c.personal);
    },
  },
  {
    name: "claim-foreign-tenant-ledger-plain",
    build: async (c) => {
      const s = await c.neg();
      await db.cashFlowEntry.create({
        data: {
          tenantId: c.tenantId,
          projectId: c.personal,
          expenseId: s.id,
          valor: s.valorTotal,
          tipo: "DESPESA",
          data: s.dataPagamento!,
          categoria: "OUTROS",
          formaPagamento: "A_VISTA",
          status: "PAGO",
        } as never,
      });
      await c.claim(s.id, { tenantId: c.other });
      return c.b(s.id, c.personal);
    },
  },
  {
    name: "neg-with-add-active-and-ledger-claim",
    build: async (c) => {
      const s = await c.neg();
      await db.cashFlowEntry.create({
        data: {
          tenantId: c.tenantId,
          projectId: c.personal,
          expenseId: s.id,
          valor: s.valorTotal,
          tipo: "DESPESA",
          data: s.dataPagamento!,
          categoria: "OUTROS",
          formaPagamento: "A_VISTA",
          status: "PAGO",
        } as never,
      });
      await c.claim(s.id);
      await c.settle(s.id, (await c.plain(c.reform)).id, "LEGACY_REPLACEMENT");
      return c.b(s.id, c.personal);
    },
  },
  {
    name: "reform-project-negative-owner",
    build: async (c) =>
      c.b((await c.neg({ projectId: c.reform })).id, c.reform),
  },
  {
    name: "reform-project-negative-limited",
    build: async (c) =>
      c.b((await c.neg({ projectId: c.reform })).id, c.reform, "limited"),
  },
  {
    name: "neg-in-soft-deleted-project",
    build: async (c) => {
      const p = await db.project.create({
        data: { tenantId: c.tenantId, type: "PESSOAL", name: "gone" },
      });
      const s = await c.neg({ projectId: p.id });
      await db.project.update({
        where: { id: p.id },
        data: { deletedAt: new Date() },
      });
      return c.b(s.id, p.id);
    },
  },
  {
    name: "zero-value-row",
    build: async (c) =>
      c.b((await c.neg({ valor: 0, valorTotal: 0 })).id, c.personal),
  },
  {
    name: "invoice-undo-and-schedule",
    build: async (c) =>
      c.b(
        (
          await c.neg({
            invoiceUndoState: "PROCESSED_NONE",
            documentedSchedule: "{}",
          })
        ).id,
        c.personal,
      ),
  },
  {
    name: "documented-schedule-with-linked-live-target",
    build: async (c) => {
      const t = await c.plain(c.personal);
      return c.b(
        (await c.neg({ documentedSchedule: "{}", linkedExpenseId: t.id })).id,
        c.personal,
        "owner",
        { t: t.id },
      );
    },
  },
  {
    name: "manual-key-with-mirror",
    build: async (c) => {
      const s = await c.neg({ settlesInvoiceKey: "m1:y" });
      const m = await c.plain(c.personal, { linkedExpenseId: s.id });
      return c.b(s.id, c.personal, "owner", { m: m.id });
    },
  },
  {
    name: "mirror-has-documented-schedule",
    build: async (c) => {
      const s = await c.neg();
      const m = await c.plain(c.personal, {
        linkedExpenseId: s.id,
        documentedSchedule: "{}",
      });
      return c.b(s.id, c.personal, "owner", { m: m.id });
    },
  },
  {
    name: "mirror-has-invoice-key",
    build: async (c) => {
      const s = await c.neg();
      const m = await c.plain(c.personal, {
        linkedExpenseId: s.id,
        settlesInvoiceKey: "m1:z",
      });
      return c.b(s.id, c.personal, "owner", { m: m.id });
    },
  },
];

const BASELINE = JSON.parse(
  readFileSync(
    join(__dirname, "__tests__", "r3-baseline-differential.json"),
    "utf8",
  ),
) as {
  capsSingle: Record<string, boolean>;
  deletes: Record<string, unknown>;
  staleBaseline: Record<string, { caps: boolean; del: "ok" | number }>;
};
// A list object read before the row changed. The candidate re-reads inside the tx, so capability
// follows the CURRENT row and agrees with the real DELETE; the baseline trusted the stale object.
const STALE_CANDIDATE: Record<string, { caps: boolean; del: "ok" | number }> = {
  "stale-soft-deleted-after-read": { caps: false, del: 404 },
  "stale-hard-deleted": { caps: false, del: 404 },
  "stale-tenant-moved": { caps: false, del: 404 },
  "stale-project-moved-to-hidden": { caps: false, del: 404 },
  "stale-became-positive": { caps: true, del: "ok" },
  "stale-gained-documented-schedule": { caps: false, del: 409 },
  "stale-gained-invoice-key": { caps: false, del: 409 },
  "stale-gained-link-to-soft-deleted": { caps: false, del: 404 },
  "stale-gained-link-to-hidden": { caps: false, del: 404 },
  "stale-gained-additive-funding": { caps: false, del: 409 },
  "stale-gained-claim": { caps: false, del: 409 },
  "stale-linked-cleared": { caps: true, del: "ok" },
};

const norm = (s: string) =>
  s
    .replace(/c[a-z0-9]{24}/g, "<id>")
    .replace(new RegExp(`${tenantOf()}[a-z0-9-]*`, "g"), "<t>");
let TENANT = "";
function tenantOf() {
  return TENANT || "@@";
}

const snapshot = async (tenantId: string) =>
  JSON.stringify({
    e: await db.expense.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    c: await db.cashFlowEntry.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    a: await db.rateioAllocation.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    s: await db.crossProjectSettlement.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    l: await db.importedInvoiceLiquidation.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
  });

describe("#704 R3 QA differential vs pre-refactor baseline (real DB)", () => {
  let ctx: Ctx;
  const built = new Map<string, Built>();
  const requesterFor = (actor: Actor) =>
    actor === "owner"
      ? ctx.f.requester
      : {
          id: `${ctx.tenantId}-${actor === "limited" ? "personal-only" : "none"}`,
          role: "USER",
        };

  beforeAll(async () => {
    const f = await refundFixture(db, prisma, "refund-r3diff");
    TENANT = f.tenantId;
    ctx = new Ctx(f);
    ctx.other = `${f.tenantId}-b`;
    await db.expense.deleteMany({ where: { tenantId: ctx.other } });
    await db.project.deleteMany({ where: { tenantId: ctx.other } });
    await db.tenant.deleteMany({ where: { id: ctx.other } });
    await db.tenant.create({
      data: { id: ctx.other, name: "diff other tenant" },
    });
    ctx.otherProject = (
      await db.project.create({
        data: { tenantId: ctx.other, type: "PESSOAL", name: "other" },
      })
    ).id;
    const account = await seedBankAccount(db, {
      tenantId: ctx.tenantId,
      projectId: ctx.personal,
      last4: "0705",
    });
    ctx.cardId = f.card.id;
    await seedStatementImport(db, {
      tenantId: ctx.tenantId,
      accountId: account.id,
      id: `${ctx.tenantId}-imp`,
    });
    for (const [id, projects, types] of [
      ["personal-only", [ctx.personal], ["PESSOAL"]],
      ["none", [ctx.reform], ["REFORMA"]],
    ] as const) {
      await db.user.create({
        data: {
          id: `${ctx.tenantId}-${id}`,
          tenantId: ctx.tenantId,
          username: id,
          name: id,
          role: "USER",
          allowedProjects: JSON.stringify(projects),
          allowedProjectTypes: JSON.stringify(types),
          allowedModules: JSON.stringify(["expenses", "monthlyOverview"]),
        },
      });
    }
    // liquidation rows for the foreign tenant need their own import; reuse the local one (FK only)
    for (const s of SCENARIOS) {
      try {
        built.set(s.name, await s.build(ctx));
      } catch (e) {
        throw new Error(`build ${s.name}: ${String(e).slice(0, 500)}`);
      }
    }
  }, 240000);

  afterAll(async () => {
    await db.expense.updateMany({
      where: { tenantId: { in: [ctx.tenantId, ctx.other] } },
      data: { linkedExpenseId: null },
    });
    await db.crossProjectSettlement.deleteMany({
      where: { tenantId: ctx.other },
    });
    await db.rateioAllocation.deleteMany({ where: { tenantId: ctx.other } });
    await db.importedInvoiceLiquidation.deleteMany({
      where: { tenantId: ctx.other },
    });
    await db.expense.deleteMany({ where: { tenantId: ctx.other } });
    await db.project.deleteMany({ where: { tenantId: ctx.other } });
    await db.tenant.deleteMany({ where: { id: ctx.other } });
    await ctx.f.cleanup();
    await db.$disconnect();
    await prisma.$disconnect();
  });

  const row = (name: string) =>
    db.expense.findUniqueOrThrow({ where: { id: built.get(name)!.id } });

  it("capabilities: single, batch per actor, reversed+duplicated batch; zero writes", async () => {
    const before = await snapshot(ctx.tenantId);
    const single: Record<string, boolean | undefined> = {};
    for (const s of SCENARIOS) {
      const b = built.get(s.name)!;
      const [r] = await expenses.withDeleteCapabilities(
        ctx.tenantId,
        [await row(s.name)],
        requesterFor(b.actor) as never,
      );
      single[s.name] = (r as { canDelete?: boolean }).canDelete;
    }
    const batch: Record<string, boolean | undefined> = {};
    const batchRev: Record<string, boolean | undefined> = {};
    for (const actor of ["owner", "limited", "limited-none"] as const) {
      const names = SCENARIOS.filter(
        (s) => built.get(s.name)!.actor === actor,
      ).map((s) => s.name);
      if (!names.length) continue;
      const rows = await Promise.all(names.map(row));
      const res = await expenses.withDeleteCapabilities(
        ctx.tenantId,
        rows,
        requesterFor(actor) as never,
      );
      names.forEach((n, i) => {
        batch[n] = (res[i] as { canDelete?: boolean }).canDelete;
      });
      const dup = [...rows].reverse().concat(rows);
      const res2 = await expenses.withDeleteCapabilities(
        ctx.tenantId,
        dup,
        requesterFor(actor) as never,
      );
      const rev = [...names].reverse().concat(names);
      rev.forEach((n, i) => {
        const v = (res2[i] as { canDelete?: boolean }).canDelete;
        if (n in batchRev && batchRev[n] !== v)
          batchRev[n] = undefined as never;
        else batchRev[n] = v;
      });
    }
    expect(await snapshot(ctx.tenantId)).toBe(before);
    const asJson = (v: unknown) => JSON.parse(JSON.stringify(v));
    expect(asJson(single)).toEqual(BASELINE.capsSingle);
    expect(asJson(batch)).toEqual(BASELINE.capsSingle);
    expect(asJson(batchRev)).toEqual(BASELINE.capsSingle);
  }, 240000);

  it("DELETE outcome + effects per scenario", async () => {
    const deletes: Record<string, unknown> = {};
    for (const s of SCENARIOS) {
      const b = built.get(s.name)!;
      const ids = Object.values(b.labels);
      const nameOf = new Map(Object.entries(b.labels).map(([k, v]) => [v, k]));
      let outcome: "ok" | { status?: number; message: string };
      try {
        await expenses.remove(
          ctx.tenantId,
          b.projectId,
          b.id,
          requesterFor(b.actor) as never,
        );
        outcome = "ok";
      } catch (e) {
        outcome = {
          status: (e as { status?: number }).status ?? -1,
          message: norm(String((e as Error).message)),
        };
      }
      const exp = await db.expense.findMany({ where: { id: { in: ids } } });
      const cfe = await db.cashFlowEntry.findMany({
        where: { expenseId: { in: ids } },
      });
      const alloc = await db.rateioAllocation.findMany({
        where: {
          OR: [
            { sourceExpenseId: { in: ids } },
            { targetExpenseId: { in: ids } },
          ],
        },
      });
      const sett = await db.crossProjectSettlement.findMany({
        where: {
          OR: [
            { sourceExpenseId: { in: ids } },
            { targetExpenseId: { in: ids } },
          ],
        },
      });
      const lab = (id: string) => nameOf.get(id) ?? "?";
      deletes[s.name] = {
        outcome,
        expenses: Object.fromEntries(
          exp
            .map((e) => [
              lab(e.id),
              {
                deleted: !!e.deletedAt,
                linked: e.linkedExpenseId ? lab(e.linkedExpenseId) : null,
                status: e.status,
                valorTotal: e.valorTotal,
              },
            ])
            .sort(),
        ),
        cfe: Object.fromEntries(
          Object.entries(
            cfe.reduce<Record<string, string>>((a, c) => {
              a[lab(c.expenseId!)] ??= "";
              a[lab(c.expenseId!)] +=
                `${c.deletedAt ? "d" : "l"}${c.valor}${c.status};`;
              return a;
            }, {}),
          ).sort(),
        ),
        alloc: alloc
          .map(
            (a) =>
              `${lab(a.sourceExpenseId)}>${lab(a.targetExpenseId)}:${a.tenantId === ctx.tenantId ? "t" : "x"}:${a.isRefundCredit}`,
          )
          .sort(),
        sett: sett
          .map(
            (x) =>
              `${lab(x.sourceExpenseId)}>${lab(x.targetExpenseId)}:${x.mode}:${x.reversedAt ? "rev" : "act"}:${x.tenantId === ctx.tenantId ? "t" : "x"}`,
          )
          .sort(),
      };
    }
    expect(Object.keys(deletes)).toHaveLength(SCENARIOS.length);
    expect(JSON.parse(JSON.stringify(deletes))).toEqual(BASELINE.deletes);
  }, 240000);

  it("stale list objects: capability vs the current DB and vs the real DELETE", async () => {
    type Mut = {
      name: string;
      make: () => Promise<{
        obj: any;
        mutate: () => Promise<void>;
        actor?: Actor;
        projectId?: string;
      }>;
    };
    const MUTS: Mut[] = [
      {
        name: "stale-soft-deleted-after-read",
        make: async () => {
          const r = await ctx.neg();
          return {
            obj: r,
            mutate: async () => {
              await db.expense.update({
                where: { id: r.id },
                data: { deletedAt: new Date() },
              });
            },
          };
        },
      },
      {
        name: "stale-hard-deleted",
        make: async () => {
          const r = await ctx.neg();
          return {
            obj: r,
            mutate: async () => {
              await db.expense.deleteMany({ where: { id: r.id } });
            },
          };
        },
      },
      {
        name: "stale-tenant-moved",
        make: async () => {
          const r = await ctx.neg();
          return {
            obj: r,
            mutate: async () => {
              await db.expense.update({
                where: { id: r.id },
                data: { tenantId: ctx.other, projectId: ctx.otherProject },
              });
            },
          };
        },
      },
      {
        name: "stale-project-moved-to-hidden",
        make: async () => {
          const r = await ctx.neg();
          return {
            obj: r,
            actor: "limited" as Actor,
            mutate: async () => {
              await db.expense.update({
                where: { id: r.id },
                data: { projectId: ctx.reform },
              });
            },
          };
        },
      },
      {
        name: "stale-became-positive",
        make: async () => {
          const r = await ctx.neg();
          return {
            obj: r,
            mutate: async () => {
              await db.expense.update({
                where: { id: r.id },
                data: { valor: 1000, valorTotal: 1000 },
              });
            },
          };
        },
      },
      {
        name: "stale-gained-documented-schedule",
        make: async () => {
          const r = await ctx.neg();
          return {
            obj: r,
            mutate: async () => {
              await db.expense.update({
                where: { id: r.id },
                data: { documentedSchedule: "{}" },
              });
            },
          };
        },
      },
      {
        name: "stale-gained-invoice-key",
        make: async () => {
          const r = await ctx.neg();
          return {
            obj: r,
            mutate: async () => {
              await db.expense.update({
                where: { id: r.id },
                data: { settlesInvoiceKey: "m1:s" },
              });
            },
          };
        },
      },
      {
        name: "stale-gained-link-to-soft-deleted",
        make: async () => {
          const r = await ctx.neg();
          const t = await ctx.plain(ctx.personal, { deletedAt: new Date() });
          return {
            obj: r,
            mutate: async () => {
              await db.expense.update({
                where: { id: r.id },
                data: { linkedExpenseId: t.id },
              });
            },
          };
        },
      },
      {
        name: "stale-gained-link-to-hidden",
        make: async () => {
          const r = await ctx.neg();
          const t = await ctx.plain(ctx.reform);
          return {
            obj: r,
            actor: "limited" as Actor,
            mutate: async () => {
              await db.expense.update({
                where: { id: r.id },
                data: { linkedExpenseId: t.id },
              });
            },
          };
        },
      },
      {
        name: "stale-gained-additive-funding",
        make: async () => {
          const r = await ctx.neg();
          const t = await ctx.plain(ctx.reform);
          return {
            obj: r,
            mutate: async () => {
              await ctx.settle(r.id, t.id, "ADDITIVE");
            },
          };
        },
      },
      {
        name: "stale-gained-claim",
        make: async () => {
          const r = await ctx.neg();
          await db.cashFlowEntry.create({
            data: {
              tenantId: ctx.tenantId,
              projectId: ctx.personal,
              expenseId: r.id,
              valor: r.valorTotal,
              tipo: "DESPESA",
              data: r.dataPagamento!,
              categoria: "OUTROS",
              formaPagamento: "A_VISTA",
              status: "PAGO",
            } as never,
          });
          return {
            obj: r,
            mutate: async () => {
              await ctx.claim(r.id);
            },
          };
        },
      },
      {
        name: "stale-linked-cleared",
        make: async () => {
          const t = await ctx.plain(ctx.reform);
          const r = await ctx.neg({ linkedExpenseId: t.id });
          return {
            obj: r,
            actor: "limited" as Actor,
            mutate: async () => {
              await db.expense.update({
                where: { id: r.id },
                data: { linkedExpenseId: null },
              });
            },
          };
        },
      },
    ];
    const res: Record<string, { caps: boolean; del: "ok" | number }> = {};
    for (const m of MUTS) {
      const { obj, mutate, actor = "owner" } = await m.make();
      const list = { ...obj };
      await mutate();
      const [c] = await expenses.withDeleteCapabilities(
        ctx.tenantId,
        [list] as never,
        requesterFor(actor) as never,
      );
      let del: "ok" | number;
      try {
        await expenses.remove(
          ctx.tenantId,
          obj.projectId,
          obj.id,
          requesterFor(actor) as never,
        );
        del = "ok";
      } catch (e) {
        del = (e as { status?: number }).status ?? -1;
      }
      res[m.name] = {
        caps: (c as { canDelete?: boolean }).canDelete as boolean,
        del,
      };
    }
    expect(res).toEqual(STALE_CANDIDATE);
    for (const [name, v] of Object.entries(
      res as Record<string, { caps: boolean; del: "ok" | number }>,
    )) {
      // the real DELETE never changed, and capability must agree with it
      expect([name, v.del]).toEqual([name, BASELINE.staleBaseline[name].del]);
      expect([name, v.caps]).toEqual([name, v.del === "ok"]);
      // tightening only: the candidate never grants what the baseline refused
      if (BASELINE.staleBaseline[name].caps === false)
        expect([name, v.caps]).toEqual([name, false]);
    }
  }, 240000);
});
