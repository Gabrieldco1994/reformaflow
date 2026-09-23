import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Expense, PrismaClient } from "@prisma/client";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { request as playwrightRequest } from "@playwright/test";
import { PrismaService } from "../prisma/prisma.service";
import { RestoreImportedExpensesService } from "./restore-imported-expenses.service";
import { RestoreImportedExpensesController } from "./restore-imported-expenses.controller";
import { BankAccountModule } from "./bank-account.module";
import { JwtStrategy } from "../auth/jwt.strategy";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ProjectAccessGuard } from "../common/guards/project-access.guard";
import {
  resetTenant,
  seedPessoal,
  seedBankAccount,
  makeExpenseService,
  seedCardWithClosingDue,
  makeBankAccountService,
  commitStatement,
} from "./__tests__/invoice-undo.fixtures";

const tenantId = "synthetic-700";
const projectId = "synthetic-700-project";
const requester = { id: "synthetic-700-user", role: "USER" };
const posted = new Date("2026-08-10T00:00:00Z");
const deleted = new Date("2026-08-11T18:20:46.479Z");
const created = new Date("2026-08-10T12:00:00Z");
const now = new Date("2026-09-23T12:00:00Z");
const db = new PrismaClient();
const prisma = new PrismaService();
const service = new RestoreImportedExpensesService(prisma);
let accountId: string;
let importId: string;
let root: Expense;
let failAudit = false;
let failSecondCfe = false;
let writes = 0;
let events: string[] = [];
prisma.$use(async (params, next) => {
  events.push(`${params.model ?? "raw"}:${params.action}`);
  if (
    failAudit &&
    params.model === "UserActivityLog" &&
    params.action === "create"
  )
    throw new Error("synthetic audit failure");
  if (
    failSecondCfe &&
    params.model === "CashFlowEntry" &&
    params.action === "updateMany" &&
    ++writes === 2
  ) {
    params.args.where.id = "synthetic-missing";
  }
  return next(params);
});
const scope = () => ({ tenantId, projectId, accountId });
const selection = () => [root.externalId!];
const preview = (externalIds = selection()) =>
  service.restore(scope(), requester, { mode: "preview", externalIds });
const apply = (fingerprint: string, externalIds = selection()) =>
  service.restore(scope(), requester, {
    mode: "apply",
    externalIds,
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
  imports: await db.bankStatementImport.findMany({
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

async function history(externalId: string) {
  const expense = await db.expense.create({
    data: {
      tenantId,
      projectId,
      externalId,
      importId,
      tipoDespesa: "TRANSFERENCIA_TED",
      valor: 12345,
      quantidade: 1,
      valorTotal: 12345,
      titulo: "Synthetic12345c",
      formaPagamento: "A_VISTA",
      dataPagamento: posted,
      status: "PAGO",
      bankLast4: "1234",
      accountId: null,
      origin: "none",
      createdAt: created,
      deletedAt: deleted,
    },
  });
  await db.cashFlowEntry.create({
    data: {
      tenantId,
      projectId,
      expenseId: expense.id,
      tipo: "DESPESA",
      categoria: "TRANSFERENCIA_TED",
      subcategoria: "Synthetic account",
      valor: 12345,
      data: posted,
      status: "PAGO",
      formaPagamento: "A_VISTA",
      createdAt: created,
      deletedAt: deleted,
    },
  });
  return expense;
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
  failAudit = false;
  failSecondCfe = false;
  writes = 0;
  events = [];
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
      allowedProjectTypes: '["PESSOAL"]',
      allowedModules: '["bankAccounts","expenses"]',
      lastActivityAt: new Date(),
    },
  });
  ({ id: accountId } = await seedBankAccount(db, {
    tenantId,
    projectId,
    last4: "1234",
  }));
  await seedBankAccount(db, { tenantId, projectId, last4: "1234" });
  const batch = await db.bankStatementImport.create({
    data: {
      tenantId,
      accountId,
      source: "OFX",
      periodLabel: "2026-08",
      createdAt: created,
    },
  });
  importId = batch.id;
  root = await history("synthetic-external-700");
});
afterEach(() => jest.useRealTimers());
afterAll(async () => {
  await db.userActivityLog.deleteMany({ where: { tenantId } });
  await db.user.deleteMany({ where: { tenantId } });
  await resetTenant(db, tenantId);
  await prisma.$disconnect();
  await db.$disconnect();
});

describe("bank debit selective restoration #700", () => {
  it("restores legacy transfer with null account FK and duplicate last4, preserving every other field", async () => {
    const before = await snapshot();
    const plan = await preview();
    expect(await snapshot()).toEqual(before);
    expect(plan.entries).toEqual([
      {
        expenseId: root.id,
        cashFlowEntryId: before.entries[0].id,
        externalId: root.externalId,
        importId,
        valorCents: 12345,
        date: posted.toISOString(),
        status: "PAGO",
      },
    ]);
    expect(plan.bankCashDeltaCents).toBe(-12345);
    events = [];
    await apply(plan.fingerprint);
    const after = await snapshot();
    expect(after.expenses).toEqual(
      before.expenses.map((row) => ({
        ...row,
        deletedAt: null,
        updatedAt: after.expenses[0].updatedAt,
      })),
    );
    expect(after.entries).toEqual(
      before.entries.map((row) => ({
        ...row,
        deletedAt: null,
        updatedAt: after.entries[0].updatedAt,
      })),
    );
    expect(after.imports).toEqual(before.imports);
    expect(after.ledger).toEqual([]);
    expect(after.audit).toHaveLength(1);
    expect(events.indexOf("User:findUnique")).toBeGreaterThan(
      events.indexOf("raw:executeRaw"),
    );
    await expect(apply(plan.fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await snapshot()).toEqual(after);
  });

  it("never revives older generations", async () => {
    const entry = (await snapshot()).entries[0];
    const old = await db.cashFlowEntry.create({
      data: {
        ...entry,
        id: "synthetic-obsolete",
        deletedAt: new Date("2026-08-11T10:00:00Z"),
      },
    });
    const plan = await preview();
    await apply(plan.fingerprint);
    expect(
      await db.cashFlowEntry.findUnique({ where: { id: old.id } }),
    ).toEqual(old);
  });

  it.each([
    {},
    { mode: "preview", externalIds: [] },
    { mode: "preview", externalIds: ["x", "x"] },
    { mode: "preview", externalIds: [" "] },
    { mode: "preview", externalIds: ["x"], valor: 12345 },
    { mode: "apply", externalIds: ["x"] },
    {
      mode: "preview",
      externalIds: Array.from({ length: 51 }, (_, i) => `x${i}`),
    },
  ])("rejects invalid body %j", async (body) => {
    const before = await snapshot();
    await expect(
      service.restore(scope(), requester, body),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    "root-without-cfe",
    "cfe-only-amount",
    "ambiguous-identity",
    "original-import",
  ] as const)("rejects active equivalent: %s", async (kind) => {
    const competing = await db.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        valor: kind === "cfe-only-amount" ? 54321 : 12345,
        quantidade: 1,
        valorTotal: kind === "cfe-only-amount" ? 54321 : 12345,
        formaPagamento: "A_VISTA",
        dataPagamento: posted,
        status: "PAGO",
        bankLast4: "1234",
        accountId: ["ambiguous-identity", "original-import"].includes(kind)
          ? null
          : accountId,
        importId: kind === "original-import" ? importId : null,
      },
    });
    if (kind === "cfe-only-amount") {
      await db.cashFlowEntry.create({
        data: {
          tenantId,
          projectId,
          expenseId: competing.id,
          tipo: "DESPESA",
          categoria: "Synthetic",
          valor: 12345,
          data: posted,
          status: "PAGO",
        },
      });
    }
    const before = await snapshot();
    await expect(preview()).rejects.toBeInstanceOf(ConflictException);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    "grant",
    "project",
    "account",
    "batch",
    "root",
    "entry",
    "relation",
    "competing",
  ] as const)("rechecks stale %s after writer reservation", async (kind) => {
    const plan = await preview();
    if (kind === "grant")
      await db.user.update({
        where: { id: requester.id },
        data: { allowedProjects: '["hidden"]' },
      });
    if (kind === "project")
      await db.project.update({
        where: { id: projectId },
        data: { deletedAt: new Date() },
      });
    if (kind === "account")
      await db.bankAccount.update({
        where: { id: accountId },
        data: { deletedAt: new Date() },
      });
    if (kind === "batch")
      await db.bankStatementImport.update({
        where: { id: importId },
        data: { deletedAt: new Date() },
      });
    if (kind === "root")
      await db.expense.update({
        where: { id: root.id },
        data: { titulo: "changed" },
      });
    if (kind === "entry")
      await db.cashFlowEntry.updateMany({
        where: { expenseId: root.id },
        data: { categoria: "changed" },
      });
    if (kind === "relation")
      await db.expense.update({
        where: { id: root.id },
        data: { linkedExpenseId: "synthetic-link" },
      });
    if (kind === "competing")
      await db.expense.create({
        data: {
          tenantId,
          projectId,
          tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
          valor: 12345,
          quantidade: 1,
          valorTotal: 12345,
          formaPagamento: "A_VISTA",
          dataPagamento: posted,
          status: "PAGO",
          bankLast4: "1234",
          accountId,
        },
      });
    const before = await snapshot();
    await expect(apply(plan.fingerprint)).rejects.toBeInstanceOf(
      ["grant", "project", "account", "batch"].includes(kind)
        ? NotFoundException
        : ConflictException,
    );
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    "card",
    "five-installments",
    "stamped",
    "missing",
    "ambiguous",
    "wrong-amount",
  ] as const)("rejects unsupported history %s", async (kind) => {
    if (kind === "card")
      await db.expense.update({
        where: { id: root.id },
        data: { cardLast4: "9876" },
      });
    if (kind === "five-installments")
      await db.expense.update({
        where: { id: root.id },
        data: { formaPagamento: "PARCELADO", quantidadeParcela: 5 },
      });
    if (kind === "stamped")
      await db.expense.update({
        where: { id: root.id },
        data: { invoiceUndoState: "PROCESSED_NONE" },
      });
    if (kind === "missing")
      await db.cashFlowEntry.deleteMany({ where: { expenseId: root.id } });
    if (kind === "ambiguous") {
      const entry = (await snapshot()).entries[0];
      await db.cashFlowEntry.create({
        data: { ...entry, id: "synthetic-duplicate" },
      });
    }
    if (kind === "wrong-amount")
      await db.cashFlowEntry.updateMany({
        where: { expenseId: root.id },
        data: { valor: 12346 },
      });
    const before = await snapshot();
    await expect(preview()).rejects.toBeInstanceOf(ConflictException);
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back all records when transactional audit fails", async () => {
    const plan = await preview();
    const before = await snapshot();
    failAudit = true;
    await expect(apply(plan.fingerprint)).rejects.toThrow(
      "synthetic audit failure",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back first selection on second conditional CFE failure", async () => {
    const second = await history("synthetic-second");
    // A distinct bank day, not a competing representation.
    await db.expense.update({
      where: { id: second.id },
      data: { dataPagamento: new Date("2026-08-09") },
    });
    await db.cashFlowEntry.updateMany({
      where: { expenseId: second.id },
      data: { data: new Date("2026-08-09") },
    });
    const ids = [root.externalId!, second.externalId!];
    const plan = await preview(ids);
    const before = await snapshot();
    failSecondCfe = true;
    await expect(apply(plan.fingerprint, ids)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await snapshot()).toEqual(before);
  });

  it("two real clients restore exactly once", async () => {
    const other = new PrismaService();
    try {
      const plan = await preview();
      const results = await Promise.allSettled([
        apply(plan.fingerprint),
        new RestoreImportedExpensesService(other).restore(scope(), requester, {
          mode: "apply",
          externalIds: selection(),
          expectedFingerprint: plan.fingerprint,
        }),
      ]);
      expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(
        1,
      );
      for (const row of results)
        if (row.status === "rejected")
          expect(row.reason).toBeInstanceOf(ConflictException);
      expect((await snapshot()).audit).toHaveLength(1);
      expect(
        (await snapshot()).entries.filter((row) => row.deletedAt === null),
      ).toHaveLength(1);
    } finally {
      await other.$disconnect();
    }
  }, 20000);

  it("official classification keeps the debit identity and retry cannot resurrect its superseded CFE", async () => {
    const plan = await preview();
    await apply(plan.fingerprint);
    const card = await seedCardWithClosingDue(db, {
      tenantId,
      projectId,
      last4: "9876",
    });
    await makeExpenseService(prisma).update(
      tenantId,
      projectId,
      root.id,
      {
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        creditCardId: card.id,
      },
      {
        ...requester,
        allowedProjects: [projectId],
        allowedModules: ["expenses", "creditCards"],
        allowedProjectTypes: ["PESSOAL"],
      },
    );
    const after = await snapshot();
    expect(after.expenses[0]).toMatchObject({
      id: root.id,
      externalId: root.externalId,
      importId,
      valorTotal: 12345,
      dataPagamento: posted,
      bankLast4: "1234",
      invoiceUndoState: null,
    });
    expect(after.entries.every((row) => row.deletedAt !== null)).toBe(true);
    expect(after.ledger).toEqual([]);
    await expect(apply(plan.fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await snapshot()).toEqual(after);
  });

  it("selective restoration ignores blocked legacy batch undo and leaves siblings untouched", async () => {
    const bank = makeBankAccountService(prisma);
    const sibling = await db.expense.create({
      data: {
        tenantId,
        projectId,
        importId,
        externalId: "synthetic-legacy-payment",
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        valor: 54321,
        quantidade: 1,
        valorTotal: 54321,
        formaPagamento: "A_VISTA",
        dataPagamento: posted,
        status: "PAGO",
        bankLast4: "1234",
      },
    });
    const actor = {
      ...requester,
      allowedProjects: [projectId],
      allowedProjectTypes: ["PESSOAL"],
      allowedModules: ["bankAccounts", "expenses"],
    };
    expect(
      (
        await bank.getImportDetail(
          tenantId,
          projectId,
          accountId,
          importId,
          actor,
        )
      ).canUndo,
    ).toBe(false);
    const before = await snapshot();
    const plan = await preview();
    await apply(plan.fingerprint);
    const after = await snapshot();
    expect(after.expenses.find((row) => row.id === sibling.id)).toEqual(
      sibling,
    );
    expect(after.imports).toEqual(before.imports);
    expect(after.ledger).toEqual(before.ledger);
    expect(
      (
        await bank.getImportDetail(
          tenantId,
          projectId,
          accountId,
          importId,
          actor,
        )
      ).canUndo,
    ).toBe(false);
  });

  it("real bank importer deduplicates against whole history before and after restore", async () => {
    const bank = makeBankAccountService(prisma);
    const commit = () =>
      commitStatement(bank, {
        tenantId,
        projectId,
        accountId,
        bankLast4: "1234",
        debitCents: 12345,
        date: "20260809",
        memo: "Synthetic12345c",
        fitId: "synthetic-dedupe-fit",
        period: "2026-08",
        requester,
      });
    const imported = await commit();
    expect(imported.inserted).toBe(1);
    root = await db.expense.findFirstOrThrow({
      where: { tenantId, importId: imported.importId },
    });
    const tombstone = new Date("2026-09-24");
    await db.expense.update({
      where: { id: root.id },
      data: { deletedAt: tombstone },
    });
    await db.cashFlowEntry.updateMany({
      where: { expenseId: root.id },
      data: { deletedAt: tombstone },
    });
    const before = await snapshot();
    expect((await commit()).inserted).toBe(0);
    expect((await snapshot()).expenses).toEqual(before.expenses);
    const plan = await preview();
    await apply(plan.fingerprint);
    const after = await snapshot();
    expect((await commit()).inserted).toBe(0);
    expect((await snapshot()).expenses).toEqual(after.expenses);
    expect((await snapshot()).entries).toEqual(after.entries);
  });

  it.each(["external", "strong"] as const)(
    "rejects Receipt identity collision: %s, including history",
    async (kind) => {
      const strong = "synthetic-strong";
      if (kind === "strong")
        await db.expense.update({
          where: { id: root.id },
          data: { dedupeKeyStrong: strong },
        });
      await db.receipt.create({
        data: {
          tenantId,
          projectId,
          valor: 12345,
          data: posted,
          tipo: "OUTROS",
          externalId:
            kind === "external" ? root.externalId : "synthetic-receipt",
          dedupeKeyStrong: kind === "strong" ? strong : null,
          deletedAt: deleted,
        },
      });
      const before = await snapshot();
      await expect(preview()).rejects.toBeInstanceOf(NotFoundException);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    "tenant",
    "project",
    "account",
    "batch-account",
    "bank-final",
    "expense-project",
    "cfe-tenant",
  ] as const)("opaque identity denial: %s", async (kind) => {
    const altered = scope();
    if (kind === "tenant") altered.tenantId = "synthetic-foreign";
    if (kind === "project") altered.projectId = "synthetic-missing";
    if (kind === "account") altered.accountId = "synthetic-missing";
    if (kind === "batch-account") {
      const other = await db.bankAccount.findFirstOrThrow({
        where: { tenantId, id: { not: accountId } },
      });
      await db.bankStatementImport.update({
        where: { id: importId },
        data: { accountId: other.id },
      });
    }
    if (kind === "bank-final")
      await db.expense.update({
        where: { id: root.id },
        data: { bankLast4: "9999" },
      });
    if (kind === "expense-project") {
      const other = await db.project.create({
        data: { tenantId, name: "Synthetic", type: "PESSOAL" },
      });
      await db.expense.update({
        where: { id: root.id },
        data: { projectId: other.id },
      });
    }
    if (kind === "cfe-tenant")
      await db.cashFlowEntry.updateMany({
        where: { expenseId: root.id },
        data: { tenantId: "synthetic-malformed" },
      });
    const before = await snapshot();
    await expect(
      service.restore(altered, requester, {
        mode: "preview",
        externalIds: selection(),
      }),
    ).rejects.toMatchObject({
      status: 404,
      message: "Recurso não encontrado",
    });
    expect(await snapshot()).toEqual(before);
    if (kind === "cfe-tenant")
      await db.cashFlowEntry.updateMany({
        where: { expenseId: root.id },
        data: { tenantId },
      });
  });

  it("an old fingerprint cannot restore a later official deletion", async () => {
    const plan = await preview();
    await apply(plan.fingerprint);
    await makeExpenseService(prisma).remove(tenantId, projectId, root.id, {
      ...requester,
      role: "ADMIN",
    });
    const before = await snapshot();
    await expect(apply(plan.fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await snapshot()).toEqual(before);
  });

  it.each(["inbound", "rateio", "settlement", "ledger", "recurrence"] as const)(
    "rejects financial participation: %s",
    async (kind) => {
      const other = await history("synthetic-related");
      if (kind === "inbound")
        await db.expense.update({
          where: { id: other.id },
          data: { linkedExpenseId: root.id },
        });
      if (kind === "rateio")
        await db.rateioAllocation.create({
          data: {
            tenantId,
            sourceExpenseId: other.id,
            targetExpenseId: root.id,
            allocation: 12345,
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
            realValor: 12345,
            plannedValor: 12345,
            plannedStatus: "PLANEJADO",
          },
        });
      if (kind === "ledger") {
        const card = await seedCardWithClosingDue(db, {
          tenantId,
          projectId,
          last4: "9876",
        });
        const entry = await db.cashFlowEntry.findFirstOrThrow({
          where: { expenseId: root.id },
        });
        await db.importedInvoiceLiquidation.create({
          data: {
            tenantId,
            importId,
            cardId: card.id,
            paymentExpenseId: other.id,
            purchaseExpenseId: root.id,
            cashFlowEntryId: entry.id,
            prevStatus: "PLANEJADO",
            entryValorCents: 12345,
            dueMonth: "2026-08",
            deletedAt: deleted,
          },
        });
      }
      if (kind === "recurrence")
        await db.expense.update({
          where: { id: root.id },
          data: { recurrenceKey: "synthetic-series" },
        });
      const before = await snapshot();
      await expect(preview()).rejects.toBeInstanceOf(ConflictException);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("does not partially restore a five-occurrence card history", async () => {
    await db.expense.update({
      where: { id: root.id },
      data: {
        cardLast4: "9876",
        bankLast4: null,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 5,
        valor: 61725,
        valorTotal: 61725,
        dataInicioParcela: posted,
      },
    });
    const initial = await db.cashFlowEntry.findFirstOrThrow({
      where: { expenseId: root.id },
    });
    await db.cashFlowEntry.update({
      where: { id: initial.id },
      data: { parcela: "1/5", formaPagamento: "CARTAO_CREDITO" },
    });
    for (let index = 1; index < 5; index++) {
      await db.cashFlowEntry.create({
        data: {
          ...initial,
          id: `synthetic-card-${index}`,
          parcela: `${index + 1}/5`,
          data: new Date(Date.UTC(2026, 7 + index, 10)),
          formaPagamento: "CARTAO_CREDITO",
        },
      });
    }
    const before = await snapshot();
    await expect(preview()).rejects.toBeInstanceOf(NotFoundException);
    expect(await snapshot()).toEqual(before);
  });

  it("changing the authorized selection or fingerprint cannot restore any row", async () => {
    const plan = await preview();
    const before = await snapshot();
    await expect(apply("0".repeat(64))).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      apply(plan.fingerprint, ["synthetic-missing"]),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await snapshot()).toEqual(before);
  });

  it("explicit original import identity does not confuse another account with the same final", async () => {
    const other = await db.bankAccount.findFirstOrThrow({
      where: { tenantId, id: { not: accountId } },
    });
    const batch = await db.bankStatementImport.create({
      data: {
        tenantId,
        accountId: other.id,
        source: "OFX",
        periodLabel: "2026-08",
      },
    });
    await db.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        valor: 12345,
        quantidade: 1,
        valorTotal: 12345,
        dataPagamento: posted,
        formaPagamento: "A_VISTA",
        bankLast4: "1234",
        status: "PAGO",
        importId: batch.id,
        accountId: null,
      },
    });
    const plan = await preview();
    expect((await apply(plan.fingerprint)).changed).toBe(1);
  });

  it("HTTP uses registered endpoint, real JWT/module/project guards and opaque identity denials", async () => {
    expect(Reflect.getMetadata("controllers", BankAccountModule)).toContain(
      RestoreImportedExpensesController,
    );
    const module = await Test.createTestingModule({
      controllers: [RestoreImportedExpensesController],
      providers: [
        RestoreImportedExpensesService,
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
    const endpoint = `/projects/${projectId}/bank-accounts/${accountId}/restore-imported-expenses`;
    const data = { mode: "preview", externalIds: selection() };
    try {
      expect((await http.post(endpoint, { data })).status()).toBe(401);
      const response = await http.post(endpoint, { headers, data });
      expect(response.status()).toBe(201);
      const plan = await response.json();
      expect(
        (
          await http.post(endpoint, { headers, data: { ...data, valor: 1 } })
        ).status(),
      ).toBe(400);
      await db.user.update({
        where: { id: requester.id },
        data: { allowedProjects: '["hidden"]' },
      });
      const hidden = await http.post(endpoint, { headers, data });
      const absent = await http.post(endpoint.replace(projectId, "missing"), {
        headers,
        data,
      });
      expect(hidden.status()).toBe(404);
      expect(await hidden.json()).toEqual(await absent.json());
      await db.user.update({
        where: { id: requester.id },
        data: {
          allowedProjects: JSON.stringify([projectId]),
          allowedModules: '["plantsAi"]',
          allowedProjectTypes: '["PLANTAS"]',
        },
      });
      expect((await http.post(endpoint, { headers, data })).status()).toBe(403);
      await db.user.update({
        where: { id: requester.id },
        data: {
          allowedModules: '["bankAccounts","expenses"]',
          allowedProjectTypes: '["PESSOAL"]',
        },
      });
      expect(
        (
          await http.post(endpoint, {
            headers,
            data: {
              ...data,
              mode: "apply",
              expectedFingerprint: plan.fingerprint,
            },
          })
        ).status(),
      ).toBe(201);
    } finally {
      await http.dispose();
      await app.close();
    }
  });
});
