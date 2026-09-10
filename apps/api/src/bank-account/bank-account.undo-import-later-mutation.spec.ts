// PR: PR 1 (degrau) — guards B1–B6/B9 nos writers + pre-check B2
//     (`INVOICE_HAS_IMPORT_TRAIL`). PR 2 (feature) — o motivo ESPECÍFICO do drift no
//     `undoImport` (B1b `DRIFT`, B2d `MANUAL_PAYMENT_OVERLAP`, B8 `LEGACY_OR_MIXED`);
//     até o PR 2 esses casos já são 409 fail-closed genérico (trava).
// #569 §6.4 — mutações/adoções posteriores sobre parcelas liquidadas por importação (tabela B).
// Grupo A (RED por comportamento, executa e falha a asserção):
//   B1 (JÁ 404 hoje quando importId != null — PASSA, é trava), B2/B2c (payInvoice REAL
//   hoje cria o pagamento sem 409 → RED), B8 (lote adotado hoje 409 LEGACY — parte passa).
// Grupo B (RED por ausência — depende do schema aditivo do PR 1 (degrau), §3.3.1;
//   NÃO aplicar migration nesta rodada, decisão do PO): todo `it` que semeia
//   `ImportedInvoiceLiquidation` ou lê `invoiceUndoState`.
import { PrismaClient } from "@prisma/client";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { MonthlyOverviewMutationRequester } from "../monthly-overview/monthly-overview.service";
import {
  EXPECTED_TRAIL_VERSION,
  commitStatement,
  makeBankAccountService,
  makeExpenseService,
  makeMonthlyOverviewService,
  pessoalRequester,
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedInstallmentPurchase,
  seedPessoal,
  seedProject,
  seedSinglePurchase,
  seedStatementImport,
} from "./__tests__/invoice-undo.fixtures";

const TENANT = "iul-mut-tenant";
const PESSOAL = "iul-mut-pessoal";
const PESSOAL2 = "iul-mut-pessoal-2";
const CARD = "4400";
const BANK = "8400";
const R = pessoalRequester(PESSOAL);
/** Requester autorizado aos DOIS projetos PESSOAL (rateio cross-project do B6). */
const R2 = {
  role: "USER" as const,
  allowedProjects: [PESSOAL, PESSOAL2],
  allowedProjectTypes: ["PESSOAL"],
  allowedModules: ["expenses", "creditCards", "monthlyOverview", "bankAccounts"],
};
const ADMIN: MonthlyOverviewMutationRequester = { id: "iul-mut-admin", role: "ADMIN" };
/** Requester USER escopado SÓ a PESSOAL (não enxerga PESSOAL2). */
const USER_A: MonthlyOverviewMutationRequester = {
  id: "iul-mut-user-a",
  role: "USER",
  allowedProjects: [PESSOAL],
  allowedProjectTypes: ["PESSOAL"],
  allowedModules: ["expenses", "creditCards", "monthlyOverview", "bankAccounts"],
} as unknown as MonthlyOverviewMutationRequester;
const GENERIC_IMPORT_TRAIL_MESSAGE =
  "INVOICE_HAS_IMPORT_TRAIL: uma parcela desta fatura foi liquidada " +
  "por uma importação de extrato. Desfaça a importação para reabrir a fatura.";

const setup = new PrismaClient();
const prisma = new PrismaService();
let importSequence = 0;

describe("#569 §6.4 — later-mutation guards (PR 1)", () => {
  let bank: ReturnType<typeof makeBankAccountService>;
  let mo: ReturnType<typeof makeMonthlyOverviewService>;
  let expenses: ReturnType<typeof makeExpenseService>;
  let accountId: string;
  let cardId: string;
  let cardIdNoCycle: string;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PESSOAL });
    await seedProject(setup, { tenantId: TENANT, projectId: PESSOAL2, type: "PESSOAL", name: "Pessoal 2" });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT, projectId: PESSOAL, last4: CARD, closingDay: 20, dueDay: 1,
    }));
    ({ id: cardIdNoCycle } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT, projectId: PESSOAL, last4: "4499", closingDay: null, dueDay: null,
    }));
    ({ id: accountId } = await seedBankAccount(setup, { tenantId: TENANT, projectId: PESSOAL, last4: BANK }));
    bank = makeBankAccountService(prisma);
    mo = makeMonthlyOverviewService(prisma);
    expenses = makeExpenseService(prisma);
  });

  afterEach(async () => {
    const l = (setup as unknown as { importedInvoiceLiquidation?: { deleteMany: (a: unknown) => Promise<unknown> } }).importedInvoiceLiquidation;
    if (l) await l.deleteMany({ where: { tenantId: TENANT } });
    await setup.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
    await setup.crossProjectSettlement.deleteMany({ where: { tenantId: TENANT } });
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  });

  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  /**
   * Compra 1x semeada NO ciclo que fecha 20/06 e vence 2026-07 (`primeiraData`
   * 2026-06-10, ≤ dia 20) + commit de um pagamento importado em julho
   * (`payMonth=2026-07` ⇒ janela `{2026-07, 2026-08}` ⊇ `dueMonth 2026-07`),
   * `debitCents` = total exato da fatura (1 parcela). Devolve ids e, para a
   * precondição financeira do §6.4, assevera a parcela EFETIVAMENTE PAGO.
   */
  async function importSettled(valorCents = 30_000, primeiraData = new Date("2026-06-10T12:00:00.000Z")) {
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD, parcelas: 1, valorCents, primeiraData,
    });
    const commit = await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK, cardLast4: CARD,
      debitCents: valorCents, date: "20260705", period: "2026-07", requester: R,
      fitId: `settled-${++importSequence}`,
    });
    const payment = await setup.expense.findFirst({
      where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", importId: commit.importId },
    });
    // precondição financeira: a parcela do ciclo virou PAGO pela importação, valor exato.
    const entry = await setup.cashFlowEntry.findUnique({ where: { id: purchase.entryIds[0] } });
    expect(entry?.status).toBe("PAGO");
    expect(entry?.valor).toBe(valorCents);
    return { purchaseId: purchase.id, entryId: purchase.entryIds[0], importId: commit.importId, paymentId: payment!.id };
  }

  const ledger = () => setup.importedInvoiceLiquidation;

  it("B1 undoInvoicePayment (REAL, monthly-overview.service.ts) já responde 404 quando o pagamento casado tem importId != null (:3548-3558); ledger intacto", async () => {
    const { importId } = await importSettled();
    await expect(
      mo.undoInvoicePayment(TENANT, PESSOAL, { cardId, dueMonth: "2026-07" }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await ledger().count({ where: { tenantId: TENANT, deletedAt: null } })).toBeGreaterThan(0);
    expect(importId).toBeTruthy();
  });

  it("B1 (cross-project) undoInvoicePayment manual NÃO reabre parcela com claim de importação ativo (cartão compartilhado; claim ancorado em OUTRO projeto) → 409, parcela segue PAGO", async () => {
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD, parcelas: 1, valorCents: 30_000,
      primeiraData: new Date("2026-06-10T12:00:00.000Z"),
    });
    await setup.cashFlowEntry.update({ where: { id: purchase.entryIds[0] }, data: { status: "PAGO" } });
    await setup.expense.update({ where: { id: purchase.id }, data: { status: "PAGO" } });
    await setup.expense.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", titulo: "manual",
        valor: 30_000, quantidade: 1, valorTotal: 30_000, formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-06-28T12:00:00.000Z"), status: "PAGO",
        cardLast4: CARD, bankLast4: BANK,
      },
    });
    const foreign = await setup.expense.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL2, tipoDespesa: "OUTROS", titulo: "foreign",
        valor: 30_000, quantidade: 1, valorTotal: 30_000, formaPagamento: "A_VISTA", status: "PAGO",
      },
    });
    await seedStatementImport(setup, { tenantId: TENANT, accountId, id: "imp-cross-x" });
    await setup.importedInvoiceLiquidation.create({
      data: {
        tenantId: TENANT, paymentExpenseId: foreign.id, importId: "imp-cross-x",
        purchaseExpenseId: foreign.id, cashFlowEntryId: purchase.entryIds[0],
        cardId, prevStatus: "PLANEJADO", entryValorCents: 30_000, dueMonth: "2026-07",
      },
    });
    await expect(
      mo.undoInvoicePayment(TENANT, PESSOAL, { cardId, dueMonth: "2026-07" }, ADMIN),
    ).rejects.toThrow(/INVOICE_HAS_IMPORT_TRAIL/);
    expect((await setup.cashFlowEntry.findUnique({ where: { id: purchase.entryIds[0] } }))?.status).toBe("PAGO");
  });

  it("SEC-1 undoInvoicePayment: compra PAGA do ciclo em projeto INVISÍVEL — ator RESTRITO recebe 404 de ACL (idêntico com/sem claim, sem oráculo); ator AUTORIZADO recebe 409 INVOICE_HAS_IMPORT_TRAIL; zero escrita nos dois", async () => {
    // CONTRATO REVISADO (#569 SEC-1): a autorização (`prepareUnsettleInvoice`)
    // precede a consulta de trilha. A versão anterior deste teste esperava 409
    // TAMBÉM para o ator restrito (USER_A) — isso vazava a EXISTÊNCIA de uma
    // liquidação ancorada em projeto invisível: o requester sem ACL distinguia
    // "compra oculta liquidada" (409) de "sem liquidação/ACL" (404), um oráculo.
    // Agora quem NÃO enxerga a compra recebe SEMPRE o mesmo 404 `Fatura não
    // encontrada`; só quem a enxerga (R2 identificado / ADMIN) chega ao 409.
    // compra VISÍVEL (A) — fecha a fatura 2026-07, casa com o pagamento manual
    const visible = await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD, parcelas: 1, valorCents: 30_000,
      primeiraData: new Date("2026-06-10T12:00:00.000Z"),
    });
    await setup.cashFlowEntry.update({ where: { id: visible.entryIds[0] }, data: { status: "PAGO" } });
    await setup.expense.update({ where: { id: visible.id }, data: { status: "PAGO" } });
    // compra INVISÍVEL (B, PESSOAL2) — parcela PAGO no MESMO dueMonth, carrega o claim
    const hidden = await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL2, cardLast4: CARD, parcelas: 1, valorCents: 15_000,
      primeiraData: new Date("2026-06-12T12:00:00.000Z"),
    });
    await setup.cashFlowEntry.update({ where: { id: hidden.entryIds[0] }, data: { status: "PAGO" } });
    await setup.expense.update({ where: { id: hidden.id }, data: { status: "PAGO" } });
    // pagamento MANUAL em A (importId null) casando com a fatura 2026-07
    await setup.expense.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", titulo: "manual-A",
        valor: 30_000, quantidade: 1, valorTotal: 30_000, formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-06-28T12:00:00.000Z"), status: "PAGO",
        cardLast4: CARD, bankLast4: BANK,
      },
    });
    await seedStatementImport(setup, { tenantId: TENANT, accountId, id: "imp-sec1-B" });
    await setup.importedInvoiceLiquidation.create({
      data: {
        tenantId: TENANT, paymentExpenseId: hidden.id, importId: "imp-sec1-B",
        purchaseExpenseId: hidden.id, cashFlowEntryId: hidden.entryIds[0],
        cardId, prevStatus: "PLANEJADO", entryValorCents: 15_000, dueMonth: "2026-07",
      },
    });

    // ── ator RESTRITO (USER_A NÃO enxerga PESSOAL2) → 404 de ACL, mensagem
    //    genérica que não menciona a compra/liquidação oculta.
    let restricted: Error | null = null;
    try {
      await mo.undoInvoicePayment(TENANT, PESSOAL, { cardId, dueMonth: "2026-07" }, USER_A);
    } catch (e) {
      restricted = e as Error;
    }
    expect(restricted).toBeInstanceOf(NotFoundException);
    expect(restricted?.message).toBe("Fatura não encontrada");
    expect(restricted?.message).not.toMatch(/IMPORT_TRAIL|liquidad|import|PESSOAL2|projectId|15|30/i);

    // ── ator AUTORIZADO (R2 identificado enxerga PESSOAL2) → a claim
    //    cross-project bloqueia o desfazer manual ⇒ 409 genérico.
    const R2_IDENTIFIED = { ...R2, id: "iul-mut-user-r2" } as unknown as MonthlyOverviewMutationRequester;
    let authorized: Error | null = null;
    try {
      await mo.undoInvoicePayment(TENANT, PESSOAL, { cardId, dueMonth: "2026-07" }, R2_IDENTIFIED);
    } catch (e) {
      authorized = e as Error;
    }
    expect(authorized).toBeInstanceOf(ConflictException);
    expect(authorized?.message).toBe(GENERIC_IMPORT_TRAIL_MESSAGE);
    expect(authorized?.message).not.toMatch(/PESSOAL2|projectId|slug|15|30/i);

    // ── zero escrita nos DOIS caminhos: parcelas seguem PAGO, claim intacto.
    expect((await setup.cashFlowEntry.findUnique({ where: { id: visible.entryIds[0] } }))?.status).toBe("PAGO");
    expect((await setup.cashFlowEntry.findUnique({ where: { id: hidden.entryIds[0] } }))?.status).toBe("PAGO");
    expect(await ledger().count({ where: { tenantId: TENANT, deletedAt: null } })).toBe(1);
  });

  // Removidos desta branch (PR 1): `B1b` (undoImport 409 `DRIFT` por parcela
  // revertida fora de banda), `B2d` (undoImport 409 `MANUAL_PAYMENT_OVERLAP`) e
  // `drift por entry soft-deletada → 409 DRIFT` — todos asseveram o MOTIVO
  // específico do drift-check do `undoImport` via ledger, que é PR 2. Vivem
  // inteiros em `test/569-pr2-red`. As guardas de escrita PR 1 (B2/B2c pre-check,
  // B3–B6/B9) permanecem abaixo.

  it("B2 payInvoice REAL (não fabrica carimbo): trilha PROCESSED_SETTLED + itens ATIVOS no card+dueMonth alvo → 409 INVOICE_HAS_IMPORT_TRAIL; zero PAGAMENTO_FATURA_CARTAO novo; entries seguem PAGO; ledger e carimbo intactos", async () => {
    const { entryId, paymentId } = await importSettled();
    const paymentsBefore = await setup.expense.count({ where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" } });
    await expect(
      mo.payInvoice(
        TENANT, PESSOAL,
        // 06/07 ≠ 05/07 da importação: evita a deduplicação de pagamento idêntico
        // (mesma data+valor) e força o caminho até o pre-check ausente.
        { cardId, month: "2026-07", amountCents: 30_000, bankLast4: BANK, paymentDate: "2026-07-06" },
        ADMIN,
      ),
    ).rejects.toThrow(/INVOICE_HAS_IMPORT_TRAIL/);
    expect(await setup.expense.count({ where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" } })).toBe(paymentsBefore);
    expect((await setup.cashFlowEntry.findUnique({ where: { id: entryId } }))?.status).toBe("PAGO");
    expect(await ledger().count({ where: { tenantId: TENANT, deletedAt: null } })).toBeGreaterThan(0);
    expect(paymentId).toBeTruthy();
  });

  it("B2b payInvoice REAL: trilha PROCESSED_NONE (zero liquidações) no MESMO card+dueMonth → payInvoice PERMITE (não 409); cria o PAGAMENTO_FATURA_CARTAO manual normalmente", async () => {
    // pagamento importado que NÃO liquidou nada (nenhuma fatura compatível)
    await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK, cardLast4: CARD,
      debitCents: 88_888, date: "20260630", period: "2026-06", requester: R,
    });
    await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD, valorCents: 20_000,
      data: new Date("2026-07-03T12:00:00.000Z"), status: "PAGO", titulo: "compra-julho",
    });
    const result = await mo.payInvoice(
      TENANT, PESSOAL,
      { cardId, month: "2026-07", amountCents: 20_000, bankLast4: BANK, paymentDate: "2026-07-10" },
      ADMIN,
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("B2c importar+liquidar a fatura inteira → prepared do payInvoice VAZIO; payInvoice manual em OUTRA data → 409 INVOICE_HAS_IMPORT_TRAIL (dueMonth do DTO); zero PAGAMENTO_FATURA_CARTAO novo; nenhuma saída nova no caixa", async () => {
    await importSettled(30_000);
    const paymentsBefore = await setup.expense.count({ where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" } });
    const cashOutBefore = await setup.cashFlowEntry.count({ where: { tenantId: TENANT, tipo: "DESPESA" } });
    await expect(
      mo.payInvoice(
        TENANT, PESSOAL,
        { cardId, month: "2026-07", amountCents: 30_000, bankLast4: BANK, paymentDate: "2026-07-20" },
        ADMIN,
      ),
    ).rejects.toThrow(/INVOICE_HAS_IMPORT_TRAIL/);
    expect(await setup.expense.count({ where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" } })).toBe(paymentsBefore);
    expect(await setup.cashFlowEntry.count({ where: { tenantId: TENANT, tipo: "DESPESA" } })).toBe(cashOutBefore);
  });

  it("B2 (CORREÇÃO DO PLANO) payInvoice com dto.month ERRADO ('2026-08') mas cuja resolução real por valor/compras/data fecha a fatura 2026-07 já liquidada → 409 INVOICE_HAS_IMPORT_TRAIL; zero pagamento novo", async () => {
    await importSettled(); // liquida a fatura dueMonth 2026-07 (total 30_000)
    const paymentsBefore = await setup.expense.count({ where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" } });
    await expect(
      mo.payInvoice(
        TENANT, PESSOAL,
        // month mentiroso; paymentDate 25/06 → janela {2026-06,2026-07} + valor exato ⇒ resolve 2026-07
        { cardId, month: "2026-08", amountCents: 30_000, bankLast4: BANK, paymentDate: "2026-06-25" },
        ADMIN,
      ),
    ).rejects.toThrow(/INVOICE_HAS_IMPORT_TRAIL/);
    expect(await setup.expense.count({ where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" } })).toBe(paymentsBefore);
  });

  it("SEC-3 payInvoice legítimo no cartão B NÃO é bloqueado por trilha de OUTRO cartão de mesmo last4 (resolveEffectiveDueMonths filtra por importId do cartão)", async () => {
    // dois cartões do MESMO tenant com last4 idêntico ao CARD
    const SHARED = "4477";
    const { id: cardA } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT, projectId: PESSOAL, last4: SHARED, closingDay: 20, dueDay: 1, nickname: "A-shared",
    });
    const { id: cardB } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT, projectId: PESSOAL, last4: SHARED, closingDay: 20, dueDay: 1, nickname: "B-shared",
    });
    // compra do cartão A, importada (importId != null) → fatura dueMonth 2026-09
    const purchaseA = await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: SHARED, valorCents: 40_000,
      data: new Date("2026-08-05T12:00:00.000Z"), status: "PAGO", titulo: "compra-A-importada",
    });
    await seedStatementImport(setup, { tenantId: TENANT, accountId, id: "imp-sec3-A" });
    await setup.expense.update({ where: { id: purchaseA.id }, data: { importId: "imp-sec3-A" } });
    // trilha ATIVA atribuída (por ambiguidade de last4) ao cartão B, dueMonth 2026-09
    await setup.importedInvoiceLiquidation.create({
      data: {
        tenantId: TENANT, paymentExpenseId: purchaseA.id, importId: "imp-sec3-A",
        purchaseExpenseId: purchaseA.id, cashFlowEntryId: purchaseA.entryId,
        cardId: cardB, prevStatus: "PLANEJADO", entryValorCents: 40_000, dueMonth: "2026-09",
      },
    });
    // pagamento legítimo da fatura 2026-10 do cartão B; paymentDate 25/09 → janela {2026-09,2026-10}
    // faz resolveEffectiveDueMonths (pré-fix) vazar o 2026-09 da compra do cartão A.
    const result = await mo.payInvoice(
      TENANT, PESSOAL,
      { cardId: cardB, month: "2026-10", amountCents: 40_000, bankLast4: BANK, paymentDate: "2026-09-25" },
      ADMIN,
    );
    expect(result).toMatchObject({ ok: true });
    expect(cardA).toBeTruthy();
    // os cartões extras (last4 4477) são limpos pelo resetTenant do afterAll;
    // a linha de ledger (card_id RESTRICT) é removida antes, no afterEach.
  });

  it("B2c-neg payInvoice REAL: cartão sem closingDay/dueDay e sem match de valor → nenhum dueMonth alvo resolvível → pre-check não dispara (a rede é MANUAL_PAYMENT_OVERLAP no undoImport)", async () => {
    await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: "4499", valorCents: 12_000,
      data: new Date("2026-07-01T12:00:00.000Z"), status: "PAGO",
    });
    const result = await mo.payInvoice(
      TENANT, PESSOAL,
      { cardId: cardIdNoCycle, month: "2026-07", amountCents: 12_000, bankLast4: BANK, paymentDate: "2026-07-10" },
      ADMIN,
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("B3 PATCH /expenses/:id muda valor da compra liquidada → 409 ConflictException no update; ledger intacto", async () => {
    const { purchaseId } = await importSettled();
    await expect(
      expenses.update(TENANT, PESSOAL, purchaseId, { valor: 45_000 } as never, R),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await ledger().count({ where: { tenantId: TENANT, deletedAt: null } })).toBeGreaterThan(0);
  });

  it("B4a PATCH creditCardId de pagamento PROCESSED_SETTLED (itens ativos) para outro cartão → 409 ConflictException; ledger intacto", async () => {
    const { paymentId } = await importSettled();
    await expect(
      expenses.update(TENANT, PESSOAL, paymentId, { creditCardId: cardIdNoCycle } as never, R),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("B4b PATCH creditCardId de pagamento PROCESSED_NONE sem cartão e sem itens → PERMITIDO; carimbo preservado; ledger continua vazio", async () => {
    const commit = await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK,
      debitCents: 12_345, date: "20260630", period: "2026-06", memo: "PAGTO CART CRED", requester: R,
    });
    const payment = await setup.expense.findFirst({
      where: { tenantId: TENANT, importId: commit.importId, tipoDespesa: { in: ["PAGAMENTO_FATURA_CARTAO", "PAGAMENTO_FATURA_SEM_CARTAO"] } },
    });
    // precondição: pagamento M8 sem cartão criado, carimbo PROCESSED_NONE, zero itens
    expect(payment).not.toBeNull();
    expect(payment!.cardLast4).toBeNull();
    const purchase = await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD, valorCents: 12_345,
      data: new Date("2026-06-10T12:00:00.000Z"), status: "PLANEJADO",
      titulo: "M8 não pode liquidar por associação posterior",
    });
    const paymentCashBefore = await setup.cashFlowEntry.findMany({
      where: { tenantId: TENANT, expenseId: payment!.id, deletedAt: null },
      select: { id: true, valor: true, tipo: true, status: true, data: true },
      orderBy: { id: "asc" },
    });
    expect(paymentCashBefore).toEqual([]);
    const accountViewBefore = (await mo.getAccountView(
      TENANT, PESSOAL, "2026-06", R as never,
    )) as unknown as Record<string, unknown>;
    const cashBefore = {
      caixaHoje: accountViewBefore.caixaHoje,
      saiuMes: accountViewBefore.saiuMes,
    };
    await expect(
      expenses.update(TENANT, PESSOAL, payment!.id, { creditCardId: cardId } as never, R),
    ).resolves.toMatchObject({ id: payment!.id });
    const raw = (await setup.expense.findUnique({ where: { id: payment!.id } })) as Record<string, unknown> | null;
    expect(raw).not.toBeNull();
    expect(raw!.invoiceUndoState).toBe("PROCESSED_NONE");
    expect(raw!.invoiceUndoParcelaCount).toBe(0);
    expect(raw!.invoiceUndoDueMonth).toBeNull();
    expect(raw!.invoiceUndoCardId).toBeNull();
    expect(raw!.invoiceUndoTrailVersion).toBe(EXPECTED_TRAIL_VERSION);
    expect(raw!.cardLast4).toBe(CARD);
    expect(await ledger().count({ where: { tenantId: TENANT, deletedAt: null } })).toBe(0);
    expect(await setup.cashFlowEntry.findMany({
      where: { tenantId: TENANT, expenseId: payment!.id, deletedAt: null },
      select: { id: true, valor: true, tipo: true, status: true, data: true },
      orderBy: { id: "asc" },
    })).toEqual(paymentCashBefore);
    const accountViewAfter = (await mo.getAccountView(
      TENANT, PESSOAL, "2026-06", R as never,
    )) as unknown as Record<string, unknown>;
    expect({
      caixaHoje: accountViewAfter.caixaHoje,
      saiuMes: accountViewAfter.saiuMes,
    }).toEqual(cashBefore);
    expect(await setup.cashFlowEntry.findUnique({ where: { id: purchase.entryId } }))
      .toMatchObject({ status: "PLANEJADO", valor: 12_345 });
    const detail = await bank.getImportDetail(TENANT, PESSOAL, accountId, commit.importId, R);
    expect(detail).toMatchObject({ canUndo: true, blockReason: null });
    await expect(bank.undoImport(TENANT, PESSOAL, accountId, commit.importId, R))
      .resolves.toMatchObject({
        ok: true,
        revertedInvoiceParcelas: 0,
        notRevertedInvoiceLiquidations: 0,
      });
    expect(await setup.cashFlowEntry.findUnique({ where: { id: purchase.entryId } }))
      .toMatchObject({ status: "PLANEJADO", valor: 12_345, deletedAt: null });
  });

  it("B5a DELETE da compra liquidada → 409 no remove; B5b DELETE do pagamento carimbado → 409", async () => {
    const { purchaseId, paymentId } = await importSettled();
    await expect(expenses.remove(TENANT, PESSOAL, purchaseId, R)).rejects.toBeInstanceOf(ConflictException);
    await expect(expenses.remove(TENANT, PESSOAL, paymentId, R)).rejects.toBeInstanceOf(ConflictException);
  });

  it("B6a ratear a compra EFETIVAMENTE liquidada (parcela PAGO) → 409 ConflictException antes do rateio", async () => {
    // entrypoint REAL: ExpenseService.ratear → prisma.$transaction → ConciliacaoService.ratearSource.
    // NÃO tocar o delegate ausente (importedInvoiceLiquidation) antes do `act` — TypeError
    // mascararia o resultado do guard. Alvo = despesa PLANEJADO em OUTRO projeto PESSOAL
    // que o requester (R2) pode ver; alocação = valorTotal exato da fonte (30_000).
    const { purchaseId } = await importSettled(30_000);
    const target = await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL2, cardLast4: CARD, valorCents: 30_000,
      data: new Date("2026-07-01T12:00:00.000Z"), titulo: "alvo-rateio", status: "PLANEJADO",
    });
    await expect(
      expenses.ratear(TENANT, PESSOAL, purchaseId, [{ targetExpenseId: target.id, allocation: 30_000 }] as never, R2 as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("B6b a linha exata do ledger e todos os participantes continuam intactos após a tentativa de rateio", async () => {
    const { purchaseId } = await importSettled(30_000);
    const target = await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL2, cardLast4: CARD, valorCents: 30_000,
      data: new Date("2026-07-01T12:00:00.000Z"), titulo: "alvo-rateio-2", status: "PLANEJADO",
    });
    const snapshot = async () => ({
      source: await setup.expense.findUnique({ where: { id: purchaseId } }),
      target: await setup.expense.findUnique({ where: { id: target.id } }),
      entries: await setup.cashFlowEntry.findMany({
        where: { expenseId: { in: [purchaseId, target.id] } }, orderBy: { id: "asc" },
      }),
      ledger: await setup.importedInvoiceLiquidation.findMany({
        where: { tenantId: TENANT }, orderBy: { id: "asc" },
      }),
      allocations: await setup.rateioAllocation.findMany({
        where: { tenantId: TENANT }, orderBy: { id: "asc" },
      }),
    });
    const before = await snapshot();
    expect(before.ledger).toHaveLength(1);
    expect(before.ledger[0]).toMatchObject({
      tenantId: TENANT,
      purchaseExpenseId: purchaseId,
      prevStatus: "PLANEJADO",
      entryValorCents: 30_000,
      dueMonth: "2026-07",
      deletedAt: null,
    });
    let error: unknown;
    try {
      await expenses.ratear(
        TENANT, PESSOAL, purchaseId,
        [{ targetExpenseId: target.id, allocation: 30_000 }] as never,
        R2 as never,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toBe(
      "Compra liquidada por pagamento importado; desfaça a importação primeiro.",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("B9a PATCH tipoDespesa do PAGAMENTO_FATURA_CARTAO com carimbo ATIVO → 409 em hasProtectedChange; carimbo/importId/cardLast4 intactos", async () => {
    const { paymentId, importId } = await importSettled();
    await expect(
      expenses.update(TENANT, PESSOAL, paymentId, { tipoDespesa: "OUTROS" } as never, R),
    ).rejects.toBeInstanceOf(ConflictException);
    const raw = (await setup.expense.findUnique({ where: { id: paymentId } })) as Record<string, unknown> | null;
    expect(raw?.importId).toBe(importId);
    expect(raw?.cardLast4).toBe(CARD);
  });

  it("B9b PATCH cardLast4/bankLast4/settlesInvoiceKey do pagamento carimbado → 409 ConflictException", async () => {
    const { paymentId } = await importSettled();
    await expect(
      expenses.update(TENANT, PESSOAL, paymentId, { settlesInvoiceKey: "9999:2026-07" } as never, R),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("B8 PAGAMENTO_FATURA_CARTAO adotado na dedup (sem carimbo) → lote fica canUndo:false / undoImport 409 LEGACY_OR_MIXED", async () => {
    const imp = await setup.bankStatementImport.create({
      data: { tenantId: TENANT, accountId, periodLabel: "2026-06", source: "OFX", inserted: 1, totalAmountCents: 30_000 },
    });
    await setup.expense.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", titulo: "adotado",
        valor: 30_000, quantidade: 1, valorTotal: 30_000, formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-06-28T12:00:00.000Z"), status: "PAGO", importId: imp.id,
        cardLast4: CARD, createdAt: new Date("2026-06-01T12:00:00.000Z"),
      },
    });
    const detail = (await (bank as unknown as { getImportDetail: (...a: unknown[]) => Promise<Record<string, unknown>> })
      .getImportDetail(TENANT, PESSOAL, accountId, imp.id, R)) as Record<string, unknown>;
    expect(detail.canUndo).toBe(false);
    await expect(bank.undoImport(TENANT, PESSOAL, accountId, imp.id, R)).rejects.toThrow(/LEGACY_OR_MIXED/);
  });
});
