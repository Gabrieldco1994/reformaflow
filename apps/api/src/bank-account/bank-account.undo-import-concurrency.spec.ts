// RED por ausência: depende do schema aditivo do PR 1 (degrau) — §3.3.1. NÃO aplicar migration nesta rodada (decisão do PO).
//
// PR: PR 2 (feature) — `undoImport` revertendo via ledger + recount import+itens na tx.
// #569 §6.6 — concorrência do undo via ledger (`PrismaService` real + SQLite real).
// Hoje `undoImport` faz 409 fail-closed em qualquer lote com pagamento de fatura,
// e `ImportedInvoiceLiquidation` / `invoiceUndoState` não existem — cada `it`
// executa o corpo real e estoura (TypeError de ausência) ou falha a asserção do
// desfecho de contenção. O doc NÃO afirma ordem de write-lock; a asserção é a
// disjunção do §2.4.
import { PrismaClient } from "@prisma/client";
import { ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  commitStatement,
  makeBankAccountService,
  pessoalRequester,
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedInstallmentPurchase,
  seedPessoal,
} from "./__tests__/invoice-undo.fixtures";

const TENANT = "iul-conc-tenant";
const PESSOAL = "iul-conc-pessoal";
const CARD = "4600";
const BANK = "8600";
const R = pessoalRequester(PESSOAL);

const setup = new PrismaClient();
const prisma = new PrismaService();

describe("#569 §6.6 — undo-import concurrency (RED)", () => {
  let bank: ReturnType<typeof makeBankAccountService>;
  let accountId: string;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PESSOAL });
    await seedCardWithClosingDue(setup, { tenantId: TENANT, projectId: PESSOAL, last4: CARD, closingDay: 20, dueDay: 1 });
    ({ id: accountId } = await seedBankAccount(setup, { tenantId: TENANT, projectId: PESSOAL, last4: BANK }));
    bank = makeBankAccountService(prisma);
  });

  afterEach(async () => {
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
    const l = (setup as unknown as { importedInvoiceLiquidation?: { deleteMany: (a: unknown) => Promise<unknown> } }).importedInvoiceLiquidation;
    if (l) await l.deleteMany({ where: { tenantId: TENANT } });
  });

  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  async function importSettled() {
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD, parcelas: 1, valorCents: 30_000,
      // ciclo que fecha 20/06 e vence 01/07 → dentro de {payMonth 2026-06, +1}
      primeiraData: new Date("2026-06-10T12:00:00.000Z"),
    });
    const commit = await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK, cardLast4: CARD,
      debitCents: 30_000, date: "20260630", period: "2026-06", requester: R,
    });
    return { importId: commit.importId, entryId: purchase.entryIds[0] };
  }

  const pagoCount = () => setup.cashFlowEntry.count({ where: { tenantId: TENANT, status: "PAGO", deletedAt: null } });

  it("dois undoImport simultâneos do mesmo lote: no máximo UM resultado com revertedInvoiceParcelas>0; o outro OU alreadyUndone:true OU 409; contagem de CashFlowEntry PAGO == baseline pós-undo", async () => {
    // O índice único parcial NÃO impede a 2ª tentativa (linhas já viram soft-deleted
    // no 1º commit) — a proteção asseverada é o recount import+itens na tx.
    const { importId } = await importSettled();
    const results = (await Promise.allSettled([
      bank.undoImport(TENANT, PESSOAL, accountId, importId, R),
      bank.undoImport(TENANT, PESSOAL, accountId, importId, R),
    ])) as Array<{ status: string; value?: Record<string, unknown>; reason?: unknown }>;
    const reverting = results.filter((r) => r.status === "fulfilled" && Number(r.value?.revertedInvoiceParcelas ?? 0) > 0);
    expect(reverting).toHaveLength(1);
    for (const r of results) {
      if (r.status === "fulfilled") {
        expect(Number(r.value?.revertedInvoiceParcelas ?? 0) > 0 || r.value?.alreadyUndone === true).toBe(true);
      } else {
        // o perdedor cai na disjunção do §2.4: 409 com motivo específico
        expect(r.reason).toBeInstanceOf(ConflictException);
        expect((r.reason as Error).message).toMatch(/INCOMPLETE_TRAIL|ALREADY_UNDONE/);
      }
    }
    expect(await pagoCount()).toBe(0);
  });

  it("re-undo serial → { ok:true, alreadyUndone:true }, zero parcelas revertidas de novo", async () => {
    const { importId } = await importSettled();
    await bank.undoImport(TENANT, PESSOAL, accountId, importId, R);
    const second = await bank.undoImport(TENANT, PESSOAL, accountId, importId, R);
    expect(second).toMatchObject({ ok: true, alreadyUndone: true });
    expect((second as { revertedInvoiceParcelas?: number }).revertedInvoiceParcelas ?? 0).toBe(0);
  });

  it("item do ledger soft-deletado por fora entre commit e undo → 409 INCOMPLETE_TRAIL (count != parcela_count), zero escrita", async () => {
    const { importId } = await importSettled();
    await (setup as unknown as {
      importedInvoiceLiquidation: { updateMany: (a: unknown) => Promise<unknown> };
    }).importedInvoiceLiquidation.updateMany({
      where: { tenantId: TENANT, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    const before = await setup.cashFlowEntry.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } });
    await expect(bank.undoImport(TENANT, PESSOAL, accountId, importId, R)).rejects.toThrow(/INCOMPLETE_TRAIL/);
    expect(await setup.cashFlowEntry.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } })).toEqual(before);
  });

  it("prova de já-desfeito não depende de count:0 — com import.deletedAt=null mas zero itens ativos e carimbo PROCESSED_SETTLED → 409, não no-op", async () => {
    const { importId } = await importSettled();
    await (setup as unknown as {
      importedInvoiceLiquidation: { updateMany: (a: unknown) => Promise<unknown> };
    }).importedInvoiceLiquidation.updateMany({
      where: { tenantId: TENANT, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    const result = await bank.undoImport(TENANT, PESSOAL, accountId, importId, R).catch((e) => e);
    expect((result as { alreadyUndone?: boolean }).alreadyUndone).not.toBe(true);
    expect(result).toBeInstanceOf(ConflictException);
    expect((result as Error).message).toMatch(/INCOMPLETE_TRAIL/);
  });
});
