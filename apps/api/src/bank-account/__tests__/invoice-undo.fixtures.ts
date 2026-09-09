/**
 * Helpers compartilhados dos RED executáveis de #569 (design §6).
 * `scripts/test-db-env.cjs` já é carregado globalmente pelo `setupFiles` do jest
 * (ver `apps/api/package.json`) — não é preciso `require` aqui.
 *
 * Runner: `PrismaService` real + banco descartável. NUNCA `new PrismaClient()`
 * para o objeto sob teste (Scar #616 — o `$use` tem de rodar); o `setupPrisma`
 * cru abaixo é só para semear/inspecionar, no padrão dos specs vizinhos
 * (`bank-account.undo-import-invoice-window-mismatch.spec.ts`).
 */
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { BankAccountService } from "../bank-account.service";
import { CardInvoiceSettlementService } from "../../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../../merchant-classifier/merchant-classifier.service";
import { MonthlyOverviewService } from "../../monthly-overview/monthly-overview.service";
import { ExpenseService } from "../../expense/expense.service";
import type { RateioRequester } from "../../expense/rateio.types";

/**
 * Versão de protocolo esperada do carimbo (design §3.3 / §3.3.1). O valor real
 * será exportado por `card-invoice-settlement.service.ts` no GREEN
 * (`INVOICE_UNDO_TRAIL_VERSION`); aqui fica o valor que os RED asseveram.
 */
export const EXPECTED_TRAIL_VERSION = 1;

export const ADMIN_REQUESTER: RateioRequester & { id: string } = {
  id: "invoice-undo-admin",
  role: "ADMIN",
};

export function pessoalRequester(projectId: string): RateioRequester {
  return {
    role: "USER",
    allowedProjects: [projectId],
    allowedProjectTypes: ["PESSOAL"],
    allowedModules: ["expenses", "creditCards", "monthlyOverview", "bankAccounts"],
  };
}

export function makeBankAccountService(prisma: PrismaService): BankAccountService {
  return new BankAccountService(
    prisma,
    new MerchantClassifierService(prisma),
    new ConciliacaoService(prisma),
    new CardInvoiceSettlementService(prisma),
  );
}

export function makeSettlementService(prisma: PrismaService): CardInvoiceSettlementService {
  return new CardInvoiceSettlementService(prisma);
}

export function makeMonthlyOverviewService(prisma: PrismaService): MonthlyOverviewService {
  return new MonthlyOverviewService(prisma, new CardInvoiceSettlementService(prisma));
}

export function makeExpenseService(prisma: PrismaService): ExpenseService {
  return new ExpenseService(prisma, new ConciliacaoService(prisma));
}

// ─── seed ──────────────────────────────────────────────────────────────────

export async function resetTenant(setup: PrismaClient, tenantId: string): Promise<void> {
  // ordem: filhos → pais. Tolera modelos que ainda não existem no schema (§ Grupo B).
  const anyDb = setup as unknown as Record<string, { deleteMany?: (a: unknown) => Promise<unknown> }>;
  if (anyDb.importedInvoiceLiquidation?.deleteMany) {
    await anyDb.importedInvoiceLiquidation.deleteMany({ where: { tenantId } });
  }
  await setup.rateioAllocation.deleteMany({ where: { tenantId } });
  await setup.crossProjectSettlement.deleteMany({ where: { tenantId } });
  await setup.cashFlowEntry.deleteMany({ where: { tenantId } });
  await setup.receipt.deleteMany({ where: { tenantId } });
  await setup.expense.deleteMany({ where: { tenantId } });
  await setup.bankStatementImport.deleteMany({ where: { tenantId } });
  const cardImports = (setup as unknown as {
    creditCardStatementImport?: { deleteMany: (a: unknown) => Promise<unknown> };
  }).creditCardStatementImport;
  if (cardImports) await cardImports.deleteMany({ where: { tenantId } });
  await setup.creditCard.deleteMany({ where: { tenantId } });
  await setup.bankAccount.deleteMany({ where: { tenantId } });
  await setup.project.deleteMany({ where: { tenantId } });
  await setup.tenant.deleteMany({ where: { id: tenantId } });
}

export async function seedPessoal(
  setup: PrismaClient,
  opts: { tenantId: string; projectId: string; name?: string },
): Promise<void> {
  await setup.tenant.create({ data: { id: opts.tenantId, name: opts.name ?? "Invoice Undo" } });
  await setup.project.create({
    data: { id: opts.projectId, tenantId: opts.tenantId, type: "PESSOAL", name: opts.name ?? "Pessoal" },
  });
}

export async function seedProject(
  setup: PrismaClient,
  opts: { tenantId: string; projectId: string; type: string; name: string },
): Promise<void> {
  await setup.project.create({
    data: { id: opts.projectId, tenantId: opts.tenantId, type: opts.type, name: opts.name },
  });
}

export async function seedCardWithClosingDue(
  setup: PrismaClient,
  opts: {
    tenantId: string;
    projectId: string;
    last4: string;
    closingDay?: number | null;
    dueDay?: number | null;
    nickname?: string;
  },
): Promise<{ id: string; last4: string }> {
  const card = await setup.creditCard.create({
    data: {
      tenantId: opts.tenantId,
      projectId: opts.projectId,
      institution: "ITAU",
      brand: "Visa",
      nickname: opts.nickname ?? `Cartão ${opts.last4}`,
      last4: opts.last4,
      closingDay: opts.closingDay ?? null,
      dueDay: opts.dueDay ?? null,
    },
  });
  return { id: card.id, last4: card.last4 };
}

export async function seedBankAccount(
  setup: PrismaClient,
  opts: { tenantId: string; projectId: string; last4: string },
): Promise<{ id: string; last4: string }> {
  const acc = await setup.bankAccount.create({
    data: {
      tenantId: opts.tenantId,
      projectId: opts.projectId,
      institution: "ITAU",
      nickname: `Conta ${opts.last4}`,
      last4: opts.last4,
      openingBalanceCents: 0,
    },
  });
  return { id: acc.id, last4: acc.last4 };
}

/**
 * Cria (ou garante) um `BankStatementImport` real — necessário desde a FK
 * `imported_invoice_liquidations.import_id → bank_statement_imports(id)` (#569 SEC-2).
 */
export async function seedStatementImport(
  setup: PrismaClient,
  opts: { tenantId: string; accountId: string; id: string; periodLabel?: string },
): Promise<string> {
  await setup.bankStatementImport.upsert({
    where: { id: opts.id },
    update: {},
    create: {
      id: opts.id,
      tenantId: opts.tenantId,
      accountId: opts.accountId,
      periodLabel: opts.periodLabel ?? "2026-01",
      source: "OFX",
    },
  });
  return opts.id;
}

/**
 * Compra PARCELADA + N `CashFlowEntry` PLANEJADO, uma por parcela, com `parcela`
 * "k/N" e datas mensais a partir de `primeiraData`.
 */
export async function seedInstallmentPurchase(
  setup: PrismaClient,
  opts: {
    tenantId: string;
    projectId: string;
    cardLast4: string;
    parcelas: number;
    valorCents: number;
    primeiraData: Date;
    id?: string;
    titulo?: string;
  },
): Promise<{ id: string; entryIds: string[] }> {
  const total = opts.valorCents * opts.parcelas;
  const purchase = await setup.expense.create({
    data: {
      ...(opts.id ? { id: opts.id } : {}),
      tenantId: opts.tenantId,
      projectId: opts.projectId,
      tipoDespesa: "OUTROS",
      titulo: opts.titulo ?? "Compra parcelada",
      valor: opts.valorCents,
      quantidade: 1,
      valorTotal: total,
      formaPagamento: "PARCELADO",
      quantidadeParcela: opts.parcelas,
      dataInicioParcela: opts.primeiraData,
      dataCompra: opts.primeiraData,
      status: "PLANEJADO",
      cardLast4: opts.cardLast4,
      paidParcelas: null,
    },
  });
  const entryIds: string[] = [];
  for (let k = 0; k < opts.parcelas; k++) {
    const d = new Date(opts.primeiraData);
    d.setMonth(d.getMonth() + k);
    const entry = await setup.cashFlowEntry.create({
      data: {
        tenantId: opts.tenantId,
        projectId: opts.projectId,
        expenseId: purchase.id,
        valor: opts.valorCents,
        tipo: "DESPESA",
        data: d,
        categoria: "OUTROS",
        formaPagamento: "CARTAO_CREDITO",
        status: "PLANEJADO",
        parcela: `${k + 1}/${opts.parcelas}`,
      },
    });
    entryIds.push(entry.id);
  }
  return { id: purchase.id, entryIds };
}

/** Compra à vista PLANEJADO no cartão + 1 `CashFlowEntry` PLANEJADO. */
export async function seedSinglePurchase(
  setup: PrismaClient,
  opts: {
    tenantId: string;
    projectId: string;
    cardLast4: string;
    valorCents: number;
    data: Date;
    id?: string;
    status?: "PLANEJADO" | "PAGO";
    titulo?: string;
  },
): Promise<{ id: string; entryId: string }> {
  const status = opts.status ?? "PLANEJADO";
  const purchase = await setup.expense.create({
    data: {
      ...(opts.id ? { id: opts.id } : {}),
      tenantId: opts.tenantId,
      projectId: opts.projectId,
      tipoDespesa: "OUTROS",
      titulo: opts.titulo ?? "Compra",
      valor: opts.valorCents,
      quantidade: 1,
      valorTotal: opts.valorCents,
      formaPagamento: "A_VISTA",
      dataPagamento: opts.data,
      dataCompra: opts.data,
      status,
      cardLast4: opts.cardLast4,
      paidParcelas: null,
    },
  });
  const entry = await setup.cashFlowEntry.create({
    data: {
      tenantId: opts.tenantId,
      projectId: opts.projectId,
      expenseId: purchase.id,
      valor: opts.valorCents,
      tipo: "DESPESA",
      data: opts.data,
      categoria: "OUTROS",
      formaPagamento: "CARTAO_CREDITO",
      status,
    },
  });
  return { id: purchase.id, entryId: entry.id };
}

// ─── OFX sintético + commit ────────────────────────────────────────────────

export function ofxDebit(date: string, amountCents: number, memo: string, fitId: string): string {
  const amount = (amountCents / 100).toFixed(2);
  return [
    "<STMTTRN>",
    "<TRNTYPE>DEBIT</TRNTYPE>",
    `<DTPOSTED>${date}</DTPOSTED>`,
    `<TRNAMT>-${amount}</TRNAMT>`,
    `<FITID>${fitId}</FITID>`,
    `<MEMO>${memo}</MEMO>`,
    "</STMTTRN>",
  ].join("");
}

export function bankOfx(bankLast4: string, ...transactions: string[]): Buffer {
  return Buffer.from(
    [
      "OFXHEADER:100",
      "DATA:OFXSGML",
      "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>",
      `<BANKACCTFROM><ACCTID>${bankLast4}</ACCTID></BANKACCTFROM>`,
      "<BANKTRANLIST>",
      ...transactions,
      "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
    ].join("\n"),
  );
}

/**
 * Roda `commitImport` com um OFX de 1 débito. Por padrão o débito é um pagamento
 * de fatura de cartão (`PAGTO CART CRED <cardLast4>`).
 */
export function commitStatement(
  service: BankAccountService,
  opts: {
    tenantId: string;
    projectId: string;
    accountId: string;
    bankLast4: string;
    cardLast4?: string;
    debitCents: number;
    date: string; // YYYYMMDD
    memo?: string;
    fitId?: string;
    period: string; // YYYY-MM
    requester: RateioRequester;
  },
) {
  const memo = opts.memo ?? `PAGTO CART CRED ${opts.cardLast4 ?? ""}`.trim();
  const statement = bankOfx(
    opts.bankLast4,
    ofxDebit(opts.date, opts.debitCents, memo, opts.fitId ?? `FIT-${opts.date}-${opts.debitCents}`),
  );
  return service.commitImport(
    opts.tenantId,
    opts.projectId,
    opts.accountId,
    statement,
    "extrato-569.ofx",
    "OFX",
    opts.period,
    undefined,
    undefined,
    null,
    opts.requester,
  );
}

/** Snapshot centavo-a-centavo de `getAccountView` para deep-equal (design §6.3). */
export async function baselineAccountView(
  service: MonthlyOverviewService,
  opts: { tenantId: string; projectId: string; month: string; requester: RateioRequester },
) {
  const view = (await service.getAccountView(
    opts.tenantId,
    opts.projectId,
    opts.month,
    opts.requester as never,
  )) as Record<string, unknown>;
  return {
    caixaHoje: view.caixaHoje,
    devoCartaoTotal: view.devoCartaoTotal,
    saidas: view.saidas,
    comprasCartao: view.comprasCartao,
    faturas: view.faturas,
  };
}

/** Lê a linha crua de `Expense` (com colunas de carimbo, quando existirem). */
export async function readExpenseRaw(setup: PrismaClient, id: string) {
  return setup.expense.findUnique({ where: { id } }) as Promise<Record<string, unknown> | null>;
}
