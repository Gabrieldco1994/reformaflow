/**
 * #704 RG5 — characterization of every clause of the refund plan (`planRefundFrom`) that a
 * future read-only projection may extract. All expectations are literal (status + body) and
 * describe the CURRENT behavior; nothing here derives an expectation from the code under test.
 * Real PrismaService (soft-delete middleware) + disposable DB. No private function is exported
 * for these tests: the owned-branch clauses go through the already public
 * `prepareRefundPurposeCleanup`.
 *
 * Clause -> test map (E = existing literal coverage kept where it is, N = new in this file):
 *  ACL source project / card module / target project ........ N "ACL and existence"
 *  source missing / deleted / other tenant / other project ... N "ACL and existence"
 *  room live + belongs to destination ........................ E expense.refund-purpose.spec.ts "room must be live…"
 *  importId absent ........................................... E refund-purpose.spec.ts "ineligible source…"
 *  batch/card deleted or foreign import ...................... E adversarial.spec.ts "explicit provenance is reauthorized…"
 *  batch not COMPLETED, card of another project/tenant ....... N "import batch and card"
 *  sign, amount, category, payment form, origin, identity,
 *    recurrence, schedule, invoice-undo stamp ................ E (subset, refund-purpose.spec.ts) + N "source facts"
 *  same project as destination ............................... N "source facts"
 *  cash-flow occurrence (count, project, value, status, kind,
 *    receipt, budget, date; history) ......................... N "cash-flow occurrence"
 *  graph: settlement, ledger, financing, marker, allocation,
 *    incoming pointers, source pointers ...................... N "visible graph" (E for funding: qa-guards/interplay)
 *  graph participant not visible / foreign / missing ......... E refund-purpose.spec.ts "an unauthorized incoming…" + N "participants"
 *  owned branch (edge, target recipe, target cash flow) ...... E adversarial "retry normalization…" + N "owned branch"
 */
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  RefundPurposeService,
  prepareRefundPurposeCleanup,
} from "./refund-purpose.service";
import {
  resetTenant,
  seedPessoal,
  seedCardWithClosingDue,
  seedBankAccount,
  seedStatementImport,
} from "../bank-account/__tests__/invoice-undo.fixtures";

const T = "rg5-clauses";
const P = `${T}-personal`;
const R = `${T}-renovation`;
const C = `${T}-third`;
const H = `${T}-hidden`;
const OTHER_TENANT = `${T}-other-tenant`;
const OWNER = { id: `${T}-owner`, role: "OWNER" };
const LIMITED = { id: `${T}-limited`, role: "USER" };
const NOT_FOUND = "Recurso não encontrado";
const CONFLICT =
  "Dados do crédito alterados ou incompatíveis. Confira os dados e faça uma nova prévia.";
const DATE = new Date("2026-09-10T00:00:00Z");

describe("#704 RG5 refund plan clauses (real PrismaService)", () => {
  const db = new PrismaClient();
  const prisma = new PrismaService();
  const service = new RefundPurposeService(prisma);
  let sourceId: string;
  let cfeId: string;
  let cardId: string;
  let importId: string;

  const preview = (
    actor: { id: string; role: string } = OWNER,
    targetProjectId = R,
    projectId = P,
    expenseId = sourceId,
  ) =>
    service.execute(T, projectId, expenseId, actor, {
      mode: "preview",
      targetProjectId,
      roomId: null,
    });
  const snapshot = async () => ({
    expenses: await db.expense.findMany({
      where: { tenantId: { in: [T, OTHER_TENANT] } },
      orderBy: { id: "asc" },
    }),
    cashflow: await db.cashFlowEntry.findMany({
      where: { tenantId: T },
      orderBy: { id: "asc" },
    }),
    allocations: await db.rateioAllocation.findMany({
      where: { tenantId: T },
      orderBy: { id: "asc" },
    }),
    settlements: await db.crossProjectSettlement.findMany({
      where: { tenantId: T },
    }),
    ledger: await db.importedInvoiceLiquidation.findMany({
      where: { tenantId: T },
    }),
  });
  const refuse = async (
    status: 404 | 409,
    run: () => Promise<unknown> = () => preview(),
  ) => {
    const before = await snapshot();
    await expect(run()).rejects.toMatchObject({
      status,
      response: { message: status === 404 ? NOT_FOUND : CONFLICT },
    });
    expect(await snapshot()).toEqual(before);
  };
  const peer = (
    projectId: string,
    data: Record<string, unknown> = {},
    tenantId = T,
  ) =>
    db.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: "OUTROS",
        valor: 100,
        valorTotal: 100,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
        ...data,
      },
    });
  const patchSource = (data: Record<string, unknown>) =>
    db.expense.update({ where: { id: sourceId }, data });
  const patchCfe = (data: Record<string, unknown>) =>
    db.cashFlowEntry.update({ where: { id: cfeId }, data });

  const wipe = async () => {
    await db.floorPlanMarker.deleteMany({
      where: { floorPlan: { tenantId: T } },
    });
    await db.floorPlan.deleteMany({ where: { tenantId: T } });
    await db.financingInstallment.deleteMany({ where: { tenantId: T } });
    await db.financing.deleteMany({ where: { tenantId: T } });
    await db.expense.deleteMany({ where: { tenantId: OTHER_TENANT } });
    // rows a test moved to the other tenant go back so resetTenant removes them in FK order
    await db.creditCardStatementImport.updateMany({
      where: { tenantId: OTHER_TENANT },
      data: { tenantId: T },
    });
    await db.creditCard.updateMany({
      where: { tenantId: OTHER_TENANT },
      data: { tenantId: T },
    });
    await db.project.updateMany({
      where: { tenantId: OTHER_TENANT },
      data: { tenantId: T },
    });
    await db.tenant.deleteMany({ where: { id: OTHER_TENANT } });
    await db.cashFlowEntry.updateMany({
      where: { tenantId: T },
      data: { budgetAllocationId: null },
    });
    await db.budgetAllocation.deleteMany({ where: { tenantId: T } });
    await db.room.deleteMany({ where: { project: { tenantId: T } } });
    await db.user.deleteMany({ where: { tenantId: T } });
    await resetTenant(db, T);
  };

  beforeEach(async () => {
    await wipe();
    await seedPessoal(db, { tenantId: T, projectId: P });
    await db.tenant.create({ data: { id: OTHER_TENANT, name: "RG5 other" } });
    for (const [id, type] of [
      [R, "REFORMA"],
      [C, "CASA"],
      [H, "CASA"],
    ] as const)
      await db.project.create({
        data: { id, tenantId: T, type, name: id },
      });
    await db.user.create({
      data: { ...OWNER, tenantId: T, username: "owner", name: "Owner" },
    });
    await db.user.create({
      data: {
        ...LIMITED,
        tenantId: T,
        username: "limited",
        name: "Limited",
        allowedProjects: JSON.stringify([P, R, C]),
        allowedProjectTypes: JSON.stringify(["PESSOAL", "REFORMA", "CASA"]),
        allowedModules: JSON.stringify(["expenses", "creditCards"]),
      },
    });
    const card = await seedCardWithClosingDue(db, {
      tenantId: T,
      projectId: P,
      last4: "1234",
    });
    cardId = card.id;
    const batch = await db.creditCardStatementImport.create({
      data: {
        tenantId: T,
        cardId,
        source: "CSV_GENERIC",
        periodLabel: "2026-09",
        status: "COMPLETED",
      },
    });
    importId = batch.id;
    const source = await db.expense.create({
      data: {
        tenantId: T,
        projectId: P,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valor: -12345,
        valorTotal: -12345,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PAGO",
        origin: "import",
        cardLast4: card.last4,
        importId,
        externalId: "rg5-refund",
        dataPagamento: DATE,
        dataCompra: new Date("2026-08-26T00:00:00Z"),
      },
    });
    sourceId = source.id;
    const cfe = await db.cashFlowEntry.create({
      data: {
        tenantId: T,
        projectId: P,
        expenseId: sourceId,
        valor: -12345,
        tipo: "DESPESA",
        data: DATE,
        categoria: "Material",
        formaPagamento: "CARTAO_CREDITO",
        status: "PAGO",
      },
    });
    cfeId = cfe.id;
  });
  afterAll(async () => {
    await wipe();
    await db.$disconnect();
    await prisma.$disconnect();
  });

  describe("baseline", () => {
    it("an eligible source previews the exact literal summary and writes nothing", async () => {
      const before = await snapshot();
      const plan = await preview();
      expect(plan).toMatchObject({
        mode: "preview",
        revision: 0,
        summary: {
          sourceExpenseId: sourceId,
          targetProjectId: R,
          roomId: null,
          tipoDespesa: "MATERIAL_CONSTRUCAO",
          allocationCents: -12345,
          dataCompra: "2026-08-26T00:00:00.000Z",
          dataPagamento: "2026-09-10T00:00:00.000Z",
          cashFlowDate: "2026-09-10T00:00:00.000Z",
          cardId,
          importId,
        },
      });
      expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("ACL and existence", () => {
    it("a missing, deleted, foreign-tenant or other-project source answers the opaque 404", async () => {
      await refuse(404, () => preview(OWNER, R, P, "rg5-nonexistent"));
      await refuse(404, () => preview(OWNER, R, C, sourceId));
      await db.expense.update({
        where: { id: sourceId },
        data: { tenantId: OTHER_TENANT },
      });
      await refuse(404);
      await db.expense.update({
        where: { id: sourceId },
        data: { tenantId: T, deletedAt: DATE },
      });
      await refuse(404);
    });

    it.each([
      ["source project not granted", { allowedProjects: [R] }],
      ["destination project not granted", { allowedProjects: [P] }],
      ["source project type not granted", { allowedProjectTypes: ["REFORMA"] }],
    ] as Array<[string, { allowedProjects?: string[]; allowedProjectTypes?: string[] }]>)(
      "%s answers the opaque 404",
      async (_label, grants) => {
        await db.user.update({
          where: { id: LIMITED.id },
          data: {
            ...(grants.allowedProjects && {
              allowedProjects: JSON.stringify(grants.allowedProjects),
            }),
            ...(grants.allowedProjectTypes && {
              allowedProjectTypes: JSON.stringify(grants.allowedProjectTypes),
            }),
          },
        });
        await refuse(404, () => preview(LIMITED));
      },
    );

    it.each([
      ["credit card", ["expenses"]],
      ["expenses", ["creditCards"]],
    ])(
      "dropping only the %s module from the stored grants does not deny: modules are reconciled from the allowed project types",
      async (_label, modules) => {
        await db.user.update({
          where: { id: LIMITED.id },
          data: { allowedModules: JSON.stringify(modules) },
        });
        await expect(preview(LIMITED)).resolves.toMatchObject({
          mode: "preview",
        });
      },
    );

    it("an absent, deleted or foreign destination project answers 404", async () => {
      await refuse(404, () => preview(OWNER, `${T}-no-such-project`));
      await db.project.update({ where: { id: R }, data: { deletedAt: DATE } });
      await refuse(404);
      await db.project.update({
        where: { id: R },
        data: { deletedAt: null, tenantId: OTHER_TENANT },
      });
      await refuse(404);
    });

    it("a source project whose type has no credit-card module answers 404 even when expenses are granted", async () => {
      await db.project.update({ where: { id: P }, data: { type: "CASA" } });
      await refuse(404, () => preview(LIMITED));
    });

    it("the source must belong to the requested project (card and cash flow moved along so only that scope clause decides)", async () => {
      await db.creditCard.update({ where: { id: cardId }, data: { projectId: C } });
      await refuse(404, () => preview(OWNER, R, C, sourceId));
    });

    it("the same project as destination is a 409, not an ACL answer", async () => {
      await refuse(409, () => preview(OWNER, P));
    });
  });

  describe("import batch and card", () => {
    it("a batch that is not COMPLETED is a 409", async () => {
      await db.creditCardStatementImport.update({
        where: { id: importId },
        data: { status: "PENDING" },
      });
      await refuse(409);
    });

    it("a card of another project or tenant answers 404", async () => {
      await db.creditCard.update({
        where: { id: cardId },
        data: { projectId: C },
      });
      await refuse(404);
      await db.creditCard.update({
        where: { id: cardId },
        data: { projectId: P, tenantId: OTHER_TENANT },
      });
      await refuse(404);
    });

    it("a card whose last4 differs from the source stamp is a 409", async () => {
      await patchSource({ cardLast4: "9999" });
      await refuse(409);
    });
  });

  describe("source facts (each one alone makes the plan a 409)", () => {
    it.each([
      ["quantity times value differs from the total", { quantidade: 2 }],
      ["unknown category", { tipoDespesa: "NAO_EXISTE" }],
      ["neutral category", { tipoDespesa: "MOVIMENTACAO_INTERNA" }],
      ["investment category", { tipoDespesa: "INVESTIMENTOS" }],
      ["fortnightly payment form", { formaPagamento: "QUINZENAL" }],
      ["origin other than none/import", { origin: "bank" }],
      ["recurrence end", { recorrenciaFim: DATE }],
      ["series key", { seriesKey: "rg5-series" }],
      ["installment count alone", { quantidadeParcela: 2 }],
      ["installment start", { dataInicioParcela: DATE }],
      ["paid installments", { paidParcelas: "[0]" }],
      ["installment date overrides", { installmentDateOverrides: "{}" }],
      ["invoice-undo due month", { invoiceUndoDueMonth: "2026-09" }],
      ["invoice-undo installment count", { invoiceUndoParcelaCount: 1 }],
      ["invoice-undo trail version", { invoiceUndoTrailVersion: 1 }],
      ["missing payment date", { dataPagamento: null }],
    ] as const)("%s", async (_label, data) => {
      await patchSource(data);
      await refuse(409);
    });

    it("a bank account link", async () => {
      const account = await db.bankAccount.create({
        data: {
          tenantId: T,
          projectId: P,
          institution: "OUTROS",
          nickname: "rg5",
          last4: "5555",
        },
      });
      await patchSource({ accountId: account.id });
      await refuse(409);
    });

    it("invoice-undo card stamp", async () => {
      await patchSource({ invoiceUndoCardId: cardId });
      await refuse(409);
    });

    it.each(["plannedExpenseId", "settledByExpenseId"] as const)(
      "source pointer %s to a visible expense",
      async (field) => {
        const other = await peer(C);
        await patchSource({ [field]: other.id });
        await refuse(409);
      },
    );
  });

  describe("cash-flow occurrence", () => {
    it("no live occurrence is a 409", async () => {
      await patchCfe({ deletedAt: DATE });
      await refuse(409);
    });

    it("two live occurrences are a 409", async () => {
      const { id, ...copy } = await db.cashFlowEntry.findUniqueOrThrow({
        where: { id: cfeId },
      });
      await db.cashFlowEntry.create({ data: copy });
      await refuse(409);
    });

    it.each([
      ["value differs", { valor: -1 }],
      ["still planned", { status: "PLANEJADO" }],
      ["is income", { tipo: "RECEITA" }],
      ["date differs from payment date", { data: new Date("2026-09-11T00:00:00Z") }],
      ["belongs to another project", { projectId: C }],
    ] as const)("the occurrence %s", async (_label, data) => {
      await patchCfe(data);
      await refuse(409);
    });

    it("the occurrence is bound to a receipt", async () => {
      const receipt = await db.receipt.create({
        data: { projectId: P, tenantId: T, valor: 1, data: DATE, tipo: "DESPESA" },
      });
      await patchCfe({ receiptId: receipt.id });
      await refuse(409);
    });

    it("the occurrence is bound to a budget allocation", async () => {
      const budget = await db.budgetAllocation.create({
        data: {
          tenantId: T,
          sourceProjectId: P,
          targetProjectId: R,
          valor: 1,
          mes: "2026-09",
        },
      });
      await patchCfe({ budgetAllocationId: budget.id });
      await refuse(409);
    });

    it("a deleted history row of the same project does not block; one of another project does", async () => {
      const { id, ...copy } = await db.cashFlowEntry.findUniqueOrThrow({
        where: { id: cfeId },
      });
      await db.cashFlowEntry.create({ data: { ...copy, deletedAt: DATE } });
      await expect(preview()).resolves.toMatchObject({ mode: "preview" });
      await db.cashFlowEntry.create({
        data: { ...copy, projectId: C, deletedAt: DATE },
      });
      await refuse(409);
    });
  });

  describe("visible graph (participants in a visible project: 409, in a hidden one: 404)", () => {
    type Kind = [
      string,
      (peerId: string) => Promise<unknown>,
    ];
    const settlement = (sourceExpenseId: string, targetExpenseId: string, reversed = false) =>
      db.crossProjectSettlement.create({
        data: {
          tenantId: T,
          sourceExpenseId,
          targetExpenseId,
          parcelaIndex: 0,
          realValor: 1,
          plannedValor: 1,
          plannedStatus: "PLANEJADO",
          ...(reversed && { reversedAt: DATE }),
        },
      });
    const ledger = async (paymentExpenseId: string, purchaseExpenseId: string) => {
      const account = await seedBankAccount(db, {
        tenantId: T,
        projectId: P,
        last4: "7777",
      });
      const statement = await seedStatementImport(db, {
        tenantId: T,
        accountId: account.id,
        id: `${T}-statement`,
      });
      return db.importedInvoiceLiquidation.create({
        data: {
          tenantId: T,
          paymentExpenseId,
          purchaseExpenseId,
          importId: statement,
          cashFlowEntryId: cfeId,
          cardId,
          prevStatus: "PLANEJADO",
          entryValorCents: 1,
          dueMonth: "2026-09",
        },
      });
    };
    const allocation = (sourceExpenseId: string, targetExpenseId: string) =>
      db.rateioAllocation.create({
        data: {
          tenantId: T,
          sourceExpenseId,
          targetExpenseId,
          allocation: 100,
          plannedStatus: "PLANEJADO",
        },
      });
    const kinds: Kind[] = [
      ["settlement with the source as origin", (p) => settlement(sourceId, p)],
      ["settlement with the source as target", (p) => settlement(p, sourceId)],
      ["reversed settlement", (p) => settlement(sourceId, p, true)],
      ["ledger claim with the source as purchase", (p) => ledger(p, sourceId)],
      ["ledger claim with the source as payment", (p) => ledger(sourceId, p)],
      ["ordinary allocation from the source", (p) => allocation(sourceId, p)],
      ["ordinary allocation into the source", (p) => allocation(p, sourceId)],
      [
        "incoming linkedExpenseId",
        (p) =>
          db.expense.update({ where: { id: p }, data: { linkedExpenseId: sourceId } }),
      ],
      [
        "incoming plannedExpenseId",
        (p) =>
          db.expense.update({ where: { id: p }, data: { plannedExpenseId: sourceId } }),
      ],
      [
        "incoming settledByExpenseId",
        (p) =>
          db.expense.update({ where: { id: p }, data: { settledByExpenseId: sourceId } }),
      ],
      [
        "source linkedExpenseId without an edge",
        (p) => patchSource({ linkedExpenseId: p }),
      ],
      [
        "source plannedExpenseId",
        (p) => patchSource({ plannedExpenseId: p }),
      ],
      [
        "source settledByExpenseId",
        (p) => patchSource({ settledByExpenseId: p }),
      ],
    ];

    it.each(kinds)("%s: visible participant is a 409", async (_label, attach) => {
      const other = await peer(C);
      await attach(other.id);
      await refuse(409, () => preview(LIMITED));
    });

    it.each(kinds)("%s: hidden participant is the opaque 404 before any conflict", async (_label, attach) => {
      const other = await peer(H);
      await attach(other.id);
      await refuse(404, () => preview(LIMITED));
    });

    it.each(kinds)("%s: an owner who sees the participant gets the 409", async (_label, attach) => {
      const other = await peer(H);
      await attach(other.id);
      await refuse(409, () => preview(OWNER));
    });

    it("a soft-deleted participant in a visible project still counts (409)", async () => {
      const other = await peer(C, { deletedAt: DATE });
      await allocation(sourceId, other.id);
      await refuse(409, () => preview(LIMITED));
    });

    it("financing installment on the source is a 409", async () => {
      const financing = await db.financing.create({
        data: {
          projectId: P,
          tenantId: T,
          valorTotalFinanciado: 1,
          taxaJurosMensalBps: 1,
          prazoMeses: 1,
          dataPrimeiraParcela: DATE,
          diaVencimento: 10,
        },
      });
      await db.financingInstallment.create({
        data: {
          financingId: financing.id,
          projectId: P,
          tenantId: T,
          numeroParcela: 1,
          dataVencimento: DATE,
          valorPrevisto: 1,
          saldoDevedorPrevisto: 1,
          expenseId: sourceId,
        },
      });
      await refuse(409, () => preview(LIMITED));
    });

    it("a floor-plan marker on the source is a 409", async () => {
      const plan = await db.floorPlan.create({
        data: { projectId: P, tenantId: T, name: "rg5", imageUrl: "x" },
      });
      await db.floorPlanMarker.create({
        data: { floorPlanId: plan.id, expenseId: sourceId, bounds: "{}" },
      });
      await refuse(409, () => preview(LIMITED));
    });
  });

  describe("participants that are not a plain visible/hidden row", () => {
    it("a dangling linkedExpenseId (no FK) is the opaque 404 (current behavior, gap G1)", async () => {
      await patchSource({ linkedExpenseId: "rg5-dangling" });
      await refuse(404);
    });

    it("a participant of another tenant is the opaque 404", async () => {
      const foreign = await peer(C, {}, OTHER_TENANT);
      await patchSource({ linkedExpenseId: foreign.id });
      await refuse(404);
    });

    it("a participant in a soft-deleted project is the opaque 404 (current behavior, gap G2)", async () => {
      const other = await peer(H);
      await db.rateioAllocation.create({
        data: {
          tenantId: T,
          sourceExpenseId: sourceId,
          targetExpenseId: other.id,
          allocation: 100,
          plannedStatus: "PLANEJADO",
        },
      });
      await db.project.update({ where: { id: H }, data: { deletedAt: DATE } });
      await refuse(404);
    });
  });

  describe("owned branch (through the public cleanup preparation)", () => {
    let targetId: string;
    let edgeId: string;
    const prepare = () =>
      prisma.$transaction((tx) =>
        prepareRefundPurposeCleanup(tx, T, sourceId, OWNER),
      );
    const refuseOwned = async () => {
      const before = await snapshot();
      await expect(prepare()).rejects.toMatchObject({
        status: 409,
        response: { message: CONFLICT },
      });
      expect(await snapshot()).toEqual(before);
    };
    const targetCfe = () =>
      db.cashFlowEntry.findFirstOrThrow({ where: { expenseId: targetId } });

    beforeEach(async () => {
      const plan = await preview();
      const applied = await service.execute(T, P, sourceId, OWNER, {
        mode: "apply",
        targetProjectId: R,
        roomId: null,
        expectedRevision: (plan as { revision: number }).revision,
        expectedFingerprint: (plan as { fingerprint: string }).fingerprint,
      });
      targetId = (applied as { targetExpenseId: string }).targetExpenseId;
      edgeId = (
        await db.rateioAllocation.findFirstOrThrow({
          where: { sourceExpenseId: sourceId },
        })
      ).id;
    });

    it("an untouched applied graph resolves to its edge, source and target", async () => {
      const prepared = await prepare();
      expect(prepared).toMatchObject({
        edge: { id: edgeId, isRefundCredit: true, allocation: -12345 },
        source: { id: sourceId },
        target: { id: targetId },
      });
    });

    it.each([
      ["edge planned status", () => db.rateioAllocation.update({ where: { id: edgeId }, data: { plannedStatus: "PLANEJADO" } })],
      ["edge planned value", () => db.rateioAllocation.update({ where: { id: edgeId }, data: { plannedValor: 1 } })],
      ["edge allocation differs from the total", () => db.rateioAllocation.update({ where: { id: edgeId }, data: { allocation: -1 } })],
      ["source pointer no longer names the target", () => patchSource({ linkedExpenseId: null })],
      ["target gained an origin", () => db.expense.update({ where: { id: targetId }, data: { cardLast4: "1234" } })],
      ["target payment form", () => db.expense.update({ where: { id: targetId }, data: { formaPagamento: "PIX" } })],
      ["target status", () => db.expense.update({ where: { id: targetId }, data: { status: "PLANEJADO" } })],
      ["target title", () => db.expense.update({ where: { id: targetId }, data: { titulo: "changed" } })],
      ["target project", () => db.expense.update({ where: { id: targetId }, data: { projectId: C } })],
      ["target payment date", () => db.expense.update({ where: { id: targetId }, data: { dataPagamento: new Date("2026-09-11T00:00:00Z") } })],
      ["target cash flow deleted (updatedAt untouched)", async () => {
        const row = await targetCfe();
        return db.cashFlowEntry.update({ where: { id: row.id }, data: { deletedAt: DATE, updatedAt: row.updatedAt } });
      }],
      ["target cash flow value", async () => db.cashFlowEntry.update({ where: { id: (await targetCfe()).id }, data: { valor: -1 } })],
      ["target cash flow date", async () => db.cashFlowEntry.update({ where: { id: (await targetCfe()).id }, data: { data: new Date("2026-09-11T00:00:00Z") } })],
      ["target cash flow category", async () => db.cashFlowEntry.update({ where: { id: (await targetCfe()).id }, data: { categoria: "Outra" } })],
      ["target cash flow status", async () => db.cashFlowEntry.update({ where: { id: (await targetCfe()).id }, data: { status: "PLANEJADO" } })],
      ["target cash flow touched after creation", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return db.cashFlowEntry.update({ where: { id: (await targetCfe()).id }, data: { parcela: null } });
      }],
      ["second target cash flow", async () => {
        const { id, ...copy } = await targetCfe();
        return db.cashFlowEntry.create({ data: copy });
      }],
      ["second allocation from the source", async () => allocationTo(await peer(C))],
      ["allocation into the source", async () => db.rateioAllocation.create({ data: { tenantId: T, sourceExpenseId: (await peer(C)).id, targetExpenseId: sourceId, allocation: 100, plannedStatus: "PLANEJADO" } })],
      ["incoming pointer other than the source", async () => db.expense.update({ where: { id: (await peer(C)).id }, data: { plannedExpenseId: targetId } })],
      ["source pointer null and another active expense points at the target", async () => {
        await patchSource({ linkedExpenseId: null });
        await db.expense.update({ where: { id: (await peer(C)).id }, data: { linkedExpenseId: targetId } });
      }],
    ] as const)("drift: %s is a 409", async (_label, mutate) => {
      await mutate();
      await refuseOwned();
    });

    const allocationTo = (other: { id: string }) =>
      db.rateioAllocation.create({
        data: {
          tenantId: T,
          sourceExpenseId: sourceId,
          targetExpenseId: other.id,
          allocation: 100,
          plannedStatus: "PLANEJADO",
        },
      });

    it("a soft-deleted target is a 409 and a hidden participant is a 404 (order: ACL before drift)", async () => {
      await db.user.update({
        where: { id: LIMITED.id },
        data: { allowedProjects: JSON.stringify([P, R, C]) },
      });
      const hidden = await peer(H);
      await db.rateioAllocation.create({
        data: {
          tenantId: T,
          sourceExpenseId: sourceId,
          targetExpenseId: hidden.id,
          allocation: 100,
          plannedStatus: "PLANEJADO",
        },
      });
      await expect(
        prisma.$transaction((tx) =>
          prepareRefundPurposeCleanup(tx, T, sourceId, LIMITED),
        ),
      ).rejects.toMatchObject({
        status: 404,
        response: { message: NOT_FOUND },
      });
      await db.expense.update({
        where: { id: targetId },
        data: { deletedAt: DATE },
      });
      await refuseOwned();
    });
  });
});
