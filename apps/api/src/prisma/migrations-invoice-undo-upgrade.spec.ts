// PR: PR 1 (degrau) — a migração aditiva + fixture de upgrade legado + guarda de
//     versão + fail-closed do legado. Nada aqui é PR 2.
// #569 §6.7 — upgrade da fixture legada. A migração aditiva
// (`imported_invoice_liquidations` + 5 colunas `invoice_undo_*` em `expenses` +
// índice único parcial + FKs `import_id`/`card_id`) JÁ está incluída neste PR e
// aplicada no banco de teste; estes `it` executam o corpo real contra o banco
// migrado e asseveram o comportamento fail-closed pós-migração: o LEGADO sem
// carimbo (`getImportDetail` canUndo:false / `undoImport` 409) e a guarda de
// versão de trilha desconhecida permanecem travas.
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import {
  makeBankAccountService,
  pessoalRequester,
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedPessoal,
} from "../bank-account/__tests__/invoice-undo.fixtures";

const TENANT = "iul-mig-tenant";
const PESSOAL = "iul-mig-pessoal";
const CARD = "4700";
const BANK = "8700";
const R = pessoalRequester(PESSOAL);

const setup = new PrismaClient();
const prisma = new PrismaService();

describe("#569 §6.7 — migration upgrade sobre fixture legada (RED)", () => {
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
  });

  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  /** Lote legado: PAGAMENTO_FATURA_CARTAO importado pré-#569, parcelas PAGO, zero ledger, zero carimbo. */
  async function seedLegacyBatch(opts?: { trailVersion?: number; invoiceUndoState?: string }) {
    const imp = await setup.bankStatementImport.create({
      data: { tenantId: TENANT, accountId, periodLabel: "2025-12", source: "OFX", inserted: 1, totalAmountCents: 30_000 },
    });
    const purchase = await setup.expense.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, tipoDespesa: "OUTROS", titulo: "compra legada",
        valor: 30_000, quantidade: 1, valorTotal: 30_000, formaPagamento: "A_VISTA",
        dataPagamento: new Date("2025-12-01T12:00:00.000Z"), status: "PAGO", cardLast4: CARD,
      },
    });
    await setup.cashFlowEntry.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, expenseId: purchase.id, valor: 30_000, tipo: "DESPESA",
        data: new Date("2025-12-01T12:00:00.000Z"), categoria: "OUTROS", formaPagamento: "CARTAO_CREDITO", status: "PAGO",
      },
    });
    await setup.expense.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", titulo: "pgto legado",
        valor: 30_000, quantidade: 1, valorTotal: 30_000, formaPagamento: "A_VISTA",
        dataPagamento: new Date("2025-12-10T12:00:00.000Z"), status: "PAGO", importId: imp.id, cardLast4: CARD,
        ...(opts?.invoiceUndoState ? { invoiceUndoState: opts.invoiceUndoState } : {}),
        ...(opts?.trailVersion != null ? { invoiceUndoTrailVersion: opts.trailVersion } : {}),
      },
    });
    return imp.id;
  }

  it("migrate deploy sobre fixture legada: cria imported_invoice_liquidations vazia e colunas invoice_undo_* NULL; PRAGMA foreign_key_check zero violações", async () => {
    const tables = (await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='imported_invoice_liquidations'",
    )) as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    const cols = (await prisma.$queryRawUnsafe("PRAGMA table_info('expenses')")) as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "invoice_undo_state",
        "invoice_undo_parcela_count",
        "invoice_undo_due_month",
        "invoice_undo_card_id",
        "invoice_undo_trail_version",
      ]),
    );
    const rows = (await prisma.$queryRawUnsafe("SELECT COUNT(*) AS c FROM imported_invoice_liquidations")) as Array<{ c: bigint }>;
    expect(Number(rows[0].c)).toBe(0);
    const fk = (await prisma.$queryRawUnsafe("PRAGMA foreign_key_check")) as unknown[];
    expect(fk).toHaveLength(0);
  });

  it("lote legado (PAGAMENTO_FATURA_CARTAO sem carimbo, parcelas PAGO) após migration: getImportDetail canUndo:false / undoImport 409, sem backfill", async () => {
    const importId = await seedLegacyBatch();
    const detail = (await (bank as unknown as { getImportDetail: (...a: unknown[]) => Promise<Record<string, unknown>> })
      .getImportDetail(TENANT, PESSOAL, accountId, importId, R)) as Record<string, unknown>;
    expect(detail.canUndo).toBe(false);
    expect(detail.blockReason).toMatch(/LEGACY/);
    await expect(bank.undoImport(TENANT, PESSOAL, accountId, importId, R)).rejects.toThrow(/LEGACY_OR_MIXED/);
    const payment = await setup.expense.findFirst({ where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" } });
    expect(payment).not.toBeNull();
    // pós-migração a coluna existe e é NULL para o legado (sem backfill)
    expect((payment as unknown as Record<string, unknown>).invoiceUndoState).toBeNull();
  });

  it("carimbo com trail_version desconhecida → getImportDetail canUndo:false, undoImport 409 (guarda de versão)", async () => {
    const importId = await seedLegacyBatch({ trailVersion: 9999, invoiceUndoState: "PROCESSED_SETTLED" });
    const detail = (await (bank as unknown as { getImportDetail: (...a: unknown[]) => Promise<Record<string, unknown>> })
      .getImportDetail(TENANT, PESSOAL, accountId, importId, R)) as Record<string, unknown>;
    expect(detail.canUndo).toBe(false);
    await expect(bank.undoImport(TENANT, PESSOAL, accountId, importId, R)).rejects.toThrow(/vers/i);
  });

  it("critério de DROP seguro: 0 linhas em imported_invoice_liquidations MAS ≥1 expense com invoice_undo_state = PROCESSED_NONE → o check de pré-condição de rollback destrutivo reprova (as duas contagens)", async () => {
    await seedLegacyBatch({ invoiceUndoState: "PROCESSED_NONE" });
    const ledgerRows = (await prisma.$queryRawUnsafe("SELECT COUNT(*) AS c FROM imported_invoice_liquidations")) as Array<{ c: bigint }>;
    const stamped = (await prisma.$queryRawUnsafe(
      "SELECT COUNT(*) AS c FROM expenses WHERE invoice_undo_state IS NOT NULL",
    )) as Array<{ c: bigint }>;
    const safeToDrop = Number(ledgerRows[0].c) === 0 && Number(stamped[0].c) === 0;
    expect(safeToDrop).toBe(false);
  });
});
