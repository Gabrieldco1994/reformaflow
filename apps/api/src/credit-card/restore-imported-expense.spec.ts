import { ConflictException, NotFoundException } from "@nestjs/common";
import { Expense, Prisma, PrismaClient } from "@prisma/client";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { request as playwrightRequest } from "@playwright/test";
import { PrismaService } from "../prisma/prisma.service";
import { RestoreImportedExpenseService } from "./restore-imported-expense.service";
import { RestoreImportedExpenseController } from "./restore-imported-expense.controller";
import { CreditCardModule } from "./credit-card.module";
import { JwtStrategy } from "../auth/jwt.strategy";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ProjectAccessGuard } from "../common/guards/project-access.guard";
import { CreditCardService } from "./credit-card.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { parseStatement } from "./parsers";
import {
  makeMonthlyOverviewService,
  pessoalRequester,
  resetTenant,
  seedCardWithClosingDue,
  seedPessoal,
  seedBankAccount,
} from "../bank-account/__tests__/invoice-undo.fixtures";

const tenantId = "synthetic-card-restore-700";
const projectId = `${tenantId}-project`;
const requester = { ...pessoalRequester(projectId), id: `${tenantId}-user` };
const created = new Date("2026-01-01T12:00:00Z");
const earlier = new Date("2026-02-01T12:00:00Z");
const deleted = new Date("2026-03-01T12:00:00Z");
const now = new Date("2026-09-24T12:00:00Z");
const date = (index: number) => new Date(Date.UTC(2026, 7 + index, 10));
const db = new PrismaClient();
const prisma = new PrismaService();
const service = new RestoreImportedExpenseService(prisma);
const cards = new CreditCardService(
  prisma,
  new ConciliacaoService(prisma),
  new MerchantClassifierService(prisma),
);
const overview = makeMonthlyOverviewService(prisma);
let root: Expense;
let cardId: string;
let importId: string;
let terminalIds: string[];
let failAudit = false;
let failFifth = false;
let updates = 0;
let events: string[] = [];
let pauseImport: (() => Promise<void>) | null = null;
prisma.$use(async (params, next) => {
  events.push(`${params.model ?? "raw"}:${params.action}`);
  if (
    failAudit &&
    params.model === "UserActivityLog" &&
    params.action === "create"
  )
    throw new Error("synthetic audit failure");
  if (
    failFifth &&
    params.model === "CashFlowEntry" &&
    params.action === "updateMany" &&
    ++updates === 5
  )
    params.args.where.id = "synthetic-missing-cfe";
  const result = await next(params);
  if (
    pauseImport &&
    params.model === "CreditCardStatementImport" &&
    params.action === "create"
  )
    await pauseImport();
  return result;
});
const scope = () => ({
  tenantId,
  projectId,
  cardId,
  importId,
  expenseId: root.id,
});
const preview = () => service.restore(scope(), requester, { mode: "preview" });
const apply = (fingerprint: string) =>
  service.restore(scope(), requester, {
    mode: "apply",
    expectedFingerprint: fingerprint,
  });
const snapshot = async () => ({
  expenses: await db.expense.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
  }),
  entries: await db.cashFlowEntry.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
  }),
  imports: await db.creditCardStatementImport.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
  }),
  receipts: await db.receipt.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
  }),
  ledger: await db.importedInvoiceLiquidation.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
  }),
  audit: await db.userActivityLog.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
  }),
});
async function competitor(
  overrides: Partial<Prisma.ExpenseUncheckedCreateInput> = {},
) {
  return db.expense.create({
    data: {
      tenantId,
      projectId,
      tipoDespesa: "OUTROS",
      titulo: "Synthetic Store (4/5)",
      fornecedor: "Synthetic Store",
      valor: 20002,
      quantidade: 1,
      valorTotal: 20002,
      formaPagamento: "PARCELADO",
      quantidadeParcela: 2,
      dataInicioParcela: date(12),
      status: "PLANEJADO",
      cardLast4: "0700",
      seriesKey: `${cardId}|synthetic store|10001|5`,
      importId,
      externalId: "synthetic-companion",
      createdAt: created,
      updatedAt: created,
      ...overrides,
    },
  });
}
async function importCompanion(amount = "100.01") {
  const csv = `date,title,amount\n2027-08-10,Synthetic Store (4/5),${amount}\n`;
  const parsed = parseStatement(csv, cardId, "CSV_GENERIC", "synthetic.csv");
  return cards.commitImport(
    tenantId,
    projectId,
    cardId,
    csv,
    "synthetic.csv",
    "CSV_GENERIC",
    undefined,
    undefined,
    parsed.transactions.map((tx) => ({
      externalId: tx.externalId,
      action: "import" as const,
    })),
    requester.id,
    requester,
  );
}
beforeEach(async () => {
  jest.useFakeTimers({
    now,
    doNotFake: [
      "nextTick",
      "setImmediate",
      "clearImmediate",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "hrtime",
      "performance",
      "queueMicrotask",
    ],
  });
  failAudit = failFifth = false;
  updates = 0;
  events = [];
  pauseImport = null;
  await db.userActivityLog.deleteMany({ where: { tenantId } });
  await db.user.deleteMany({ where: { tenantId } });
  await resetTenant(db, tenantId);
  await seedPessoal(db, { tenantId, projectId });
  await db.user.create({
    data: {
      id: requester.id,
      tenantId,
      username: requester.id,
      name: "Synthetic",
      role: "USER",
      allowedProjects: JSON.stringify([projectId]),
      allowedModules: '["creditCards","expenses"]',
      allowedProjectTypes: '["PESSOAL"]',
    },
  });
  ({ id: cardId } = await seedCardWithClosingDue(db, {
    tenantId,
    projectId,
    last4: "0700",
  }));
  const batch = await db.creditCardStatementImport.create({
    data: {
      tenantId,
      cardId,
      source: "CSV_GENERIC",
      periodLabel: "2026-08",
      createdAt: created,
      updatedAt: created,
    },
  });
  importId = batch.id;
  root = await competitor({
    externalId: "synthetic-retained",
    titulo: "Synthetic Store (1/5)",
    valor: 50000,
    valorTotal: 50000,
    quantidadeParcela: 5,
    dataPagamento: date(0),
    dataInicioParcela: date(0),
    seriesKey: `${cardId}|synthetic store|10000|5`,
    deletedAt: deleted,
  });
  terminalIds = [];
  for (const generation of ["old", "terminal"]) {
    for (let index = 0; index < 5; index++) {
      const row = await db.cashFlowEntry.create({
        data: {
          id: `${tenantId}-${generation}-${index}`,
          tenantId,
          projectId,
          expenseId: root.id,
          tipo: "DESPESA",
          categoria: "Outros",
          subcategoria: "Synthetic card",
          valor: 10000,
          data: date(index),
          status: "PLANEJADO",
          formaPagamento: "CARTAO_CREDITO",
          parcela: `${index + 1}/5`,
          createdAt: generation === "old" ? created : earlier,
          updatedAt: generation === "old" ? earlier : deleted,
          deletedAt: generation === "old" ? earlier : deleted,
        },
      });
      if (generation === "terminal") terminalIds.push(row.id);
    }
  }
  for (let i = 0; i < 2; i++) {
    const siblingBatch = await db.creditCardStatementImport.create({
      data: {
        tenantId,
        cardId,
        source: "CSV_GENERIC",
        periodLabel: "2026-08",
        createdAt: created,
        updatedAt: created,
      },
    });
    await competitor({
      externalId: null,
      importId: siblingBatch.id,
      deletedAt: earlier,
      valor: 50000,
      valorTotal: 50000,
      quantidadeParcela: 5,
      dataInicioParcela: date(0),
      seriesKey: root.seriesKey,
    });
  }
  await competitor({
    externalId: "synthetic-negative-credit",
    valor: -10000,
    valorTotal: -10000,
    formaPagamento: "A_VISTA",
    quantidadeParcela: null,
    seriesKey: null,
  });
});
afterEach(() => jest.useRealTimers());
afterAll(async () => {
  await db.userActivityLog.deleteMany({ where: { tenantId } });
  await db.user.deleteMany({ where: { tenantId } });
  await resetTenant(db, tenantId);
  await prisma.$disconnect();
  await db.$disconnect();
});

describe("CARD historical restore #700 (real Prisma middleware)", () => {
  it("restores only the exact root and terminal five, preserving historical facts and zero BANK cash", async () => {
    const before = await snapshot();
    const cash = await overview.getCaixaConta(tenantId, projectId, now);
    const plan = await preview();
    expect(await snapshot()).toEqual(before);
    expect(plan.entries.map((row) => row.cashFlowEntryId).sort()).toEqual(
      [...terminalIds].sort(),
    );
    expect(plan.bankCashDeltaCents).toBe(0);
    expect(plan.changedExpenses).toBe(0);
    events = [];
    expect(await apply(plan.fingerprint)).toMatchObject({
      changedExpenses: 1,
      changedCashFlowEntries: 5,
      bankCashDeltaCents: 0,
    });
    expect(events.indexOf("raw:executeRaw")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("User:findUnique")).toBeGreaterThan(
      events.indexOf("raw:executeRaw"),
    );
    const after = await snapshot();
    expect(after.expenses).toHaveLength(before.expenses.length);
    expect(after.entries).toHaveLength(before.entries.length);
    for (const row of after.expenses) {
      const old = before.expenses.find((e) => e.id === row.id)!;
      expect(
        row.id === root.id
          ? { ...row, deletedAt: old.deletedAt, updatedAt: old.updatedAt }
          : row,
      ).toEqual(old);
    }
    for (const row of after.entries) {
      const old = before.entries.find((e) => e.id === row.id)!;
      expect(
        terminalIds.includes(row.id)
          ? { ...row, deletedAt: old.deletedAt, updatedAt: old.updatedAt }
          : row,
      ).toEqual(old);
    }
    expect(
      after.entries
        .filter((e) => !e.deletedAt)
        .map((e) => e.id)
        .sort(),
    ).toEqual([...terminalIds].sort());
    expect(after.imports).toEqual(before.imports);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.audit).toHaveLength(1);
    expect(await overview.getCaixaConta(tenantId, projectId, now)).toEqual(
      cash,
    );
    for (let index = 0; index < 5; index++) {
      const view = await overview.getAccountView(
        tenantId,
        projectId,
        date(index).toISOString().slice(0, 7),
      );
      expect(
        view.cartoes.find((card) => card.cardId === cardId)?.faturaAtual,
      ).toBe(10000);
    }
    await expect(apply(plan.fingerprint)).rejects.toMatchObject({
      status: 409,
      response: { code: "ALREADY_ACTIVE" },
    });
    expect(await snapshot()).toEqual(after);
  });

  it("explicitly restores a normalized null-externalId root without selecting the retained-id sibling", async () => {
    const sibling = await db.expense.findFirstOrThrow({
      where: { tenantId, externalId: null, deletedAt: earlier },
    });
    await db.expense.update({
      where: { id: root.id },
      data: { externalId: null },
    });
    await db.expense.update({
      where: { id: sibling.id },
      data: { externalId: root.externalId },
    });
    const before = await db.expense.findUniqueOrThrow({
      where: { id: sibling.id },
    });
    await apply((await preview()).fingerprint);
    expect(
      await db.expense.findUniqueOrThrow({ where: { id: sibling.id } }),
    ).toEqual(before);
    expect(
      await db.expense.findUniqueOrThrow({ where: { id: root.id } }),
    ).toMatchObject({ deletedAt: null, externalId: null });
  });

  it.each([
    {},
    { mode: "preview", valor: 50000 },
    { mode: "preview", entries: [] },
    { mode: "preview", status: "PLANEJADO" },
    { mode: "preview", date: "2026-08-10" },
    { mode: "apply" },
    { mode: "apply", expectedFingerprint: "bad" },
  ])("rejects strict-body violation %j", async (body) => {
    const before = await snapshot();
    await expect(
      service.restore(scope(), requester, body),
    ).rejects.toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    "tenantId",
    "projectId",
    "cardId",
    "importId",
    "expenseId",
  ] as const)("opaque route-scope denial: %s", async (key) => {
    const before = await snapshot();
    await expect(
      service.restore({ ...scope(), [key]: "synthetic-missing" }, requester, {
        mode: "preview",
      }),
    ).rejects.toMatchObject({ status: 404, message: "Recurso não encontrado" });
    expect(await snapshot()).toEqual(before);
  });

  it.each(["other-merchant", "other-explicit-card", "negative-credit"])(
    "does not block independent %s",
    async (kind) => {
      if (kind === "other-merchant")
        await competitor({
          fornecedor: "Other merchant",
          titulo: "Other merchant (1/5)",
          seriesKey: `${cardId}|other merchant|10000|5`,
        });
      if (kind === "other-explicit-card") {
        const other = await seedCardWithClosingDue(db, {
          tenantId,
          projectId,
          last4: "0700",
        });
        const batch = await db.creditCardStatementImport.create({
          data: {
            tenantId,
            cardId: other.id,
            source: "CSV_GENERIC",
            periodLabel: "2026-08",
          },
        });
        await competitor({
          importId: batch.id,
          seriesKey: `${other.id}|synthetic store|10000|5`,
        });
      }
      if (kind === "negative-credit")
        await competitor({
          externalId: "synthetic-independent-refund",
          valor: -50000,
          valorTotal: -50000,
        });
      const before = await snapshot();
      expect(
        (await apply((await preview()).fingerprint)).changedCashFlowEntries,
      ).toBe(5);
      const after = await snapshot();
      expect(after.expenses.filter((row) => row.id !== root.id)).toEqual(
        before.expenses.filter((row) => row.id !== root.id),
      );
    },
  );

  describe.each(["preview", "apply"])(
    "original CARD provenance at %s",
    (mode) => {
      it.each([
        "other-card-same-final",
        "foreign-batch",
        "deleted-card",
        "deleted-batch",
      ])("fails closed for %s without falling back to last4", async (kind) => {
        const plan = mode === "apply" ? await preview() : null;
        const originalBatch =
          await db.creditCardStatementImport.findUniqueOrThrow({
            where: { id: importId },
          });
        try {
          if (kind === "other-card-same-final") {
            const other = await seedCardWithClosingDue(db, {
              tenantId,
              projectId,
              last4: "0700",
            });
            await db.creditCardStatementImport.update({
              where: { id: importId },
              data: { cardId: other.id },
            });
          } else if (kind === "foreign-batch") {
            await db.creditCardStatementImport.update({
              where: { id: importId },
              data: { tenantId: "synthetic-foreign" },
            });
          } else if (kind === "deleted-card") {
            await db.creditCard.update({
              where: { id: cardId },
              data: { deletedAt: now },
            });
          } else {
            await db.creditCardStatementImport.update({
              where: { id: importId },
              data: { deletedAt: now },
            });
          }
          const before = await snapshot();
          await expect(
            plan ? apply(plan.fingerprint) : preview(),
          ).rejects.toMatchObject({
            status: 404,
          });
          expect(await snapshot()).toEqual(before);
        } finally {
          await db.creditCardStatementImport.update({
            where: { id: importId },
            data: { tenantId, cardId: originalBatch.cardId, deletedAt: null },
          });
        }
      });
    },
  );

  it.each([
    "neutral",
    "bank",
    "recurrence",
    "paid-root",
    "paid-index",
    "documented",
    "bad-series",
    "wrong-card",
    "later-created",
  ])("rejects unsupported root: %s", async (kind) => {
    await db.expense.update({
      where: { id: root.id },
      data:
        kind === "neutral"
          ? { tipoDespesa: "PAGAMENTO_FATURA_CARTAO" }
          : kind === "bank"
            ? { bankLast4: "1234" }
            : kind === "recurrence"
              ? { recorrente: true }
              : kind === "paid-root"
                ? { status: "PAGO" }
                : kind === "paid-index"
                  ? { paidParcelas: "[0]" }
                  : kind === "documented"
                    ? { documentedSchedule: "{}" }
                    : kind === "bad-series"
                      ? { seriesKey: `${cardId}|synthetic store|9999|5` }
                      : kind === "wrong-card"
                        ? { cardLast4: "9999" }
                        : { createdAt: now },
    });
    const before = await snapshot();
    await expect(preview()).rejects.toMatchObject({
      status: kind === "wrong-card" ? 404 : 409,
    });
    expect(await snapshot()).toEqual(before);
  });

  it.each(["rateio", "settlement", "historical-claim", "unowned-card-cfe"])(
    "rejects financial dependency: %s",
    async (kind) => {
      const other = await competitor({
        externalId: "synthetic-graph",
        fornecedor: "Other",
        titulo: "Other",
        seriesKey: null,
      });
      if (kind === "rateio")
        await db.rateioAllocation.create({
          data: {
            tenantId,
            sourceExpenseId: root.id,
            targetExpenseId: other.id,
            allocation: 50000,
            plannedStatus: "PLANEJADO",
          },
        });
      if (kind === "settlement")
        await db.crossProjectSettlement.create({
          data: {
            tenantId,
            sourceExpenseId: other.id,
            targetExpenseId: root.id,
            parcelaIndex: 0,
            realValor: 10000,
            plannedValor: 10000,
            plannedStatus: "PLANEJADO",
          },
        });
      if (kind === "historical-claim") {
        const account = await seedBankAccount(db, {
          tenantId,
          projectId,
          last4: "1234",
        });
        const batch = await db.bankStatementImport.create({
          data: {
            tenantId,
            accountId: account.id,
            source: "OFX",
            periodLabel: "2026-08",
          },
        });
        await db.importedInvoiceLiquidation.create({
          data: {
            tenantId,
            importId: batch.id,
            cardId,
            paymentExpenseId: other.id,
            purchaseExpenseId: root.id,
            cashFlowEntryId: `${tenantId}-old-0`,
            prevStatus: "PLANEJADO",
            entryValorCents: 10000,
            dueMonth: "2026-08",
            deletedAt: deleted,
          },
        });
      }
      if (kind === "unowned-card-cfe")
        await db.cashFlowEntry.create({
          data: {
            tenantId,
            projectId,
            tipo: "DESPESA",
            categoria: "Synthetic",
            valor: 10001,
            data: date(12),
            status: "PLANEJADO",
            formaPagamento: "CARTAO_CREDITO",
            parcela: "4/5",
          },
        });
      const before = await snapshot();
      await expect(preview()).rejects.toBeInstanceOf(ConflictException);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    "missing",
    "duplicate-label",
    "later",
    "active",
    "mixed-cohort",
    "wrong-date",
    "wrong-amount",
    "paid",
    "ownership",
  ])("rejects invalid terminal history: %s", async (kind) => {
    const entry = terminalIds[4];
    if (kind === "missing")
      await db.cashFlowEntry.delete({ where: { id: entry } });
    else
      await db.cashFlowEntry.update({
        where: { id: entry },
        data:
          kind === "duplicate-label"
            ? { parcela: "4/5" }
            : kind === "later"
              ? { deletedAt: now }
              : kind === "active"
                ? { deletedAt: null }
                : kind === "mixed-cohort"
                  ? { deletedAt: earlier }
                  : kind === "wrong-date"
                    ? { data: date(8) }
                    : kind === "wrong-amount"
                      ? { valor: 9999 }
                      : kind === "paid"
                        ? { status: "PAGO" }
                        : { tenantId: "synthetic-foreign" },
      });
    const before = await snapshot();
    await expect(preview()).rejects.toMatchObject({
      status: kind === "ownership" ? 404 : 409,
    });
    expect(await snapshot()).toEqual(before);
    if (kind === "ownership")
      await db.cashFlowEntry.update({
        where: { id: entry },
        data: { tenantId },
      });
  });

  describe.each(["preview", "apply"])("duplicates at %s", (mode) => {
    it.each([
      "root-only",
      "future-cfe",
      "other-live-project",
      "historical-live-cfe",
      "no-series",
      "unknown-merchant",
      "paid-future",
      "external",
      "strong",
      "negative-identity",
    ])("rejects %s even with changed cents", async (kind) => {
      const plan = mode === "apply" ? await preview() : null;
      const overrides: Partial<Prisma.ExpenseUncheckedCreateInput> = {};
      if (
        kind === "other-live-project" ||
        kind === "external" ||
        kind === "negative-identity"
      ) {
        const project = await db.project.create({
          data: { tenantId, type: "PESSOAL", name: "Synthetic other" },
        });
        overrides.projectId = project.id;
      }
      if (kind === "historical-live-cfe") overrides.deletedAt = deleted;
      if (kind === "no-series") overrides.seriesKey = null;
      if (kind === "unknown-merchant") {
        overrides.seriesKey = null;
        overrides.fornecedor = null;
        overrides.titulo = null;
      }
      if (kind === "paid-future") overrides.status = "PAGO";
      if (kind === "external" || kind === "negative-identity") {
        overrides.externalId = root.externalId;
        overrides.fornecedor = "Other merchant";
        overrides.seriesKey = null;
      }
      if (kind === "negative-identity")
        overrides.valor = overrides.valorTotal = -10000;
      if (kind === "strong") {
        await db.expense.update({
          where: { id: root.id },
          data: { dedupeKeyStrong: "synthetic-strong" },
        });
        await db.receipt.create({
          data: {
            tenantId,
            projectId,
            tipo: "OUTROS",
            valor: 1,
            data: date(0),
            dedupeKeyStrong: "synthetic-strong",
          },
        });
      } else {
        const other = await competitor(overrides);
        if (kind === "future-cfe" || kind === "historical-live-cfe")
          await db.cashFlowEntry.create({
            data: {
              tenantId,
              projectId,
              expenseId: other.id,
              tipo: "DESPESA",
              categoria: "Outros",
              valor: 10001,
              data: date(12),
              parcela: "4/5",
              status: "PLANEJADO",
              formaPagamento: "CARTAO_CREDITO",
            },
          });
      }
      const before = await snapshot();
      await expect(
        plan ? apply(plan.fingerprint) : preview(),
      ).rejects.toMatchObject({ status: 409 });
      expect(await snapshot()).toEqual(before);
    });
  });

  it.each([
    "root",
    "cfe",
    "category",
    "batch",
    "graph",
    "grant",
    "malformed-grant",
  ])(
    "rejects stale %s and preserves the immediate pre-apply snapshot",
    async (kind) => {
      const plan = await preview();
      if (kind === "root")
        await db.expense.update({
          where: { id: root.id },
          data: { fornecedor: "Changed" },
        });
      if (kind === "cfe" || kind === "category")
        await db.cashFlowEntry.update({
          where: { id: terminalIds[0] },
          data:
            kind === "cfe"
              ? { invoiceDueMonth: "2026-09" }
              : { categoria: "Changed" },
        });
      if (kind === "batch")
        await db.creditCardStatementImport.update({
          where: { id: importId },
          data: { periodLabel: "2026-09" },
        });
      if (kind === "graph")
        await competitor({
          externalId: "synthetic-related",
          fornecedor: "Other",
          seriesKey: null,
          linkedExpenseId: root.id,
        });
      if (kind === "grant" || kind === "malformed-grant")
        await db.user.update({
          where: { id: requester.id },
          data: {
            allowedProjects: kind === "grant" ? '["not-authorized"]' : "{}",
          },
        });
      const before = await snapshot();
      await expect(apply(plan.fingerprint)).rejects.toMatchObject({
        status: kind.includes("grant") ? 404 : 409,
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(["audit", "fifth-cfe"])(
    "rolls back the complete operation on %s failure",
    async (kind) => {
      const plan = await preview();
      const before = await snapshot();
      failAudit = kind === "audit";
      failFifth = kind === "fifth-cfe";
      await expect(apply(plan.fingerprint)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );

  it("two real clients restore at most once", async () => {
    const other = new PrismaService();
    try {
      const plan = await preview();
      const results = await Promise.allSettled([
        apply(plan.fingerprint),
        new RestoreImportedExpenseService(other).restore(scope(), requester, {
          mode: "apply",
          expectedFingerprint: plan.fingerprint,
        }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await snapshot()).audit).toHaveLength(1);
      expect(
        await db.cashFlowEntry.count({ where: { tenantId, deletedAt: null } }),
      ).toBe(5);
    } finally {
      await other.$disconnect();
    }
  });

  it("rejects an old preview after a later deletion", async () => {
    const plan = await preview();
    await apply(plan.fingerprint);
    await db.expense.update({
      where: { id: root.id },
      data: { deletedAt: now },
    });
    await db.cashFlowEntry.updateMany({
      where: { id: { in: terminalIds } },
      data: { deletedAt: now },
    });
    const before = await snapshot();
    await expect(apply(plan.fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await snapshot()).toEqual(before);
  });

  it("import first blocks restore; restore first blocks a changed-cent import", async () => {
    const plan = await preview();
    expect((await importCompanion()).inserted).toBe(1);
    await expect(apply(plan.fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("import paused after preflight cannot create after restoration wins", async () => {
    const plan = await preview();
    let resume!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    pauseImport = async () => {
      reached();
      await released;
    };
    const importing = importCompanion();
    try {
      await paused;
      // The independent import record is part of exclusion evidence: take a fresh preview.
      const fresh = await preview();
      await apply(fresh.fingerprint);
      resume();
      expect((await importing).inserted).toBe(0);
      expect(
        await db.expense.count({
          where: { tenantId, deletedAt: null, valorTotal: { gt: 0 } },
        }),
      ).toBe(1);
      expect(plan.bankCashDeltaCents).toBe(0);
    } finally {
      resume();
      pauseImport = null;
    }
  });

  it("exact series dedup after restoration does not create a new purchase", async () => {
    await apply((await preview()).fingerprint);
    expect((await importCompanion("100.00")).inserted).toBe(0);
    expect(
      await db.expense.count({
        where: { tenantId, deletedAt: null, valorTotal: { gt: 0 } },
      }),
    ).toBe(1);
  });

  it.each(["restore-first", "undo-first"])(
    "serializes import undo: %s",
    async (kind) => {
      const plan = await preview();
      if (kind === "restore-first") await apply(plan.fingerprint);
      await cards.undoImport(tenantId, projectId, cardId, importId, requester);
      const before = await snapshot();
      await expect(apply(plan.fingerprint)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(await snapshot()).toEqual(before);
      expect(
        await db.cashFlowEntry.count({
          where: { expenseId: root.id, deletedAt: null },
        }),
      ).toBe(0);
    },
  );

  it("concurrent import undo and restore never leave a partial live cohort", async () => {
    const plan = await preview();
    const outcomes = await Promise.allSettled([
      apply(plan.fingerprint),
      cards.undoImport(tenantId, projectId, cardId, importId, requester),
    ]);
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(
      true,
    );
    const active = await db.cashFlowEntry.count({
      where: { expenseId: root.id, deletedAt: null },
    });
    const expense = await db.expense.findUniqueOrThrow({
      where: { id: root.id },
    });
    const batch = await db.creditCardStatementImport.findUniqueOrThrow({
      where: { id: importId },
    });
    expect(active).toBe(expense.deletedAt ? 0 : 5);
    if (batch.deletedAt) expect(expense.deletedAt).not.toBeNull();
  });

  it("HTTP exercises registered route and real JWT/module/project guards via Playwright", async () => {
    expect(Reflect.getMetadata("controllers", CreditCardModule)).toContain(
      RestoreImportedExpenseController,
    );
    const module = await Test.createTestingModule({
      controllers: [RestoreImportedExpenseController],
      providers: [
        RestoreImportedExpenseService,
        JwtStrategy,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    const app = module.createNestApplication();
    const reflector = new Reflector();
    app.useGlobalGuards(
      new JwtAuthGuard(reflector),
      new RolesGuard(reflector),
      new ModulesGuard(reflector, prisma),
      new ProjectAccessGuard(prisma),
    );
    await app.listen(0, "127.0.0.1");
    const http = await playwrightRequest.newContext({
      baseURL: await app.getUrl(),
    });
    const jwt = new JwtService({
      secret: process.env.JWT_SECRET || "dev-secret-change-me",
    });
    const headers = {
      Authorization: `Bearer ${jwt.sign({ sub: requester.id, tenantId, sv: 0 })}`,
    };
    const endpoint = `/projects/${projectId}/credit-cards/${cardId}/imports/${importId}/expenses/${root.id}/restore`;
    try {
      expect(
        (await http.post(endpoint, { data: { mode: "preview" } })).status(),
      ).toBe(401);
      const response = await http.post(endpoint, {
        headers,
        data: { mode: "preview" },
      });
      expect(response.status()).toBe(201);
      expect(
        (
          await http.post(endpoint, {
            headers,
            data: { mode: "preview", entries: terminalIds },
          })
        ).status(),
      ).toBe(400);
      await db.user.update({
        where: { id: requester.id },
        data: { allowedProjects: '["hidden"]' },
      });
      const inaccessible = await http.post(endpoint, {
        headers,
        data: { mode: "preview" },
      });
      const missing = await http.post(endpoint.replace(projectId, "missing"), {
        headers,
        data: { mode: "preview" },
      });
      expect(inaccessible.status()).toBe(404);
      expect(await inaccessible.json()).toEqual(await missing.json());
      await db.user.update({
        where: { id: requester.id },
        data: {
          allowedProjects: JSON.stringify([projectId]),
          allowedProjectTypes: '["PLANTAS"]',
          allowedModules: '["plantsAi"]',
        },
      });
      expect(
        (
          await http.post(endpoint, { headers, data: { mode: "preview" } })
        ).status(),
      ).toBe(403);
      await db.user.update({
        where: { id: requester.id },
        data: {
          allowedProjectTypes: '["PESSOAL"]',
          allowedModules: '["creditCards","expenses"]',
        },
      });
      const fresh = await http.post(endpoint, {
        headers,
        data: { mode: "preview" },
      });
      const plan = await fresh.json();
      const applied = await http.post(endpoint, {
        headers,
        data: { mode: "apply", expectedFingerprint: plan.fingerprint },
      });
      expect(applied.status()).toBe(201);
      expect(await applied.json()).toMatchObject({
        changedExpenses: 1,
        changedCashFlowEntries: 5,
      });
    } finally {
      await http.dispose();
      await app.close();
    }
  });
});
