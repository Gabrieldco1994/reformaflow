// PR: PR 1 (degrau) — carimbo em TODO PAGAMENTO_FATURA_CARTAO criado pelo commit
// do extrato, inclusive quando o tipo veio de classificação explícita do usuário
// (`categoryOverride`) e o preparo NÃO reconheceu como pagamento de cartão.
// RED por comportamento: hoje esse caminho (§bank-account.service.ts:2633+) cria
// a despesa sem nenhuma coluna `invoiceUndo*` → indistinguível de legado →
// travaria o lote no estado 1.
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import * as bankParsers from "./parsers";
import {
  EXPECTED_TRAIL_VERSION,
  bankOfx,
  makeBankAccountService,
  ofxDebit,
  pessoalRequester,
  resetTenant,
  seedBankAccount,
  seedPessoal,
} from "./__tests__/invoice-undo.fixtures";

const TENANT = "iul-classified-tenant";
const PESSOAL = "iul-classified-pessoal";
const BANK = "8700";
const R = pessoalRequester(PESSOAL);

const setup = new PrismaClient();
const prisma = new PrismaService();

describe("#569 §5/#3c — carimbo em PAGAMENTO_FATURA_CARTAO classificado explicitamente", () => {
  let bank: ReturnType<typeof makeBankAccountService>;
  let accountId: string;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PESSOAL });
    ({ id: accountId } = await seedBankAccount(setup, { tenantId: TENANT, projectId: PESSOAL, last4: BANK }));
    bank = makeBankAccountService(prisma);
  });

  afterEach(async () => {
    await setup.importedInvoiceLiquidation.deleteMany({ where: { tenantId: TENANT } });
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  });

  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  it("categoryOverride PAGAMENTO_FATURA_CARTAO + memo não reconhecido + sem last4 → carimbo PROCESSED_NONE, invoiceUndoCardId null, 0 itens; getImportDetail não bloqueia como legado", async () => {
    const statement = bankOfx(
      BANK,
      ofxDebit("20260710", 12_345, "DEBITO AUTORIZADO", "FIT-classified-1"),
    );
    const parsed = await bankParsers.parseBankStatementBuffers([statement], accountId, "OFX");
    const externalId = parsed.transactions[0].externalId;

    const commit = await bank.commitImport(
      TENANT, PESSOAL, accountId, statement, "extrato.ofx", "OFX", "2026-07",
      undefined,
      [{ externalId, overrides: { category: "PAGAMENTO_FATURA_CARTAO" } }] as never,
      null, R,
    );

    const expense = await setup.expense.findFirst({
      where: { tenantId: TENANT, importId: commit.importId },
    });
    expect(expense).not.toBeNull();
    expect(expense!.tipoDespesa).toBe("PAGAMENTO_FATURA_CARTAO");
    const raw = (await setup.expense.findUnique({ where: { id: expense!.id } })) as Record<string, unknown>;
    expect(raw.invoiceUndoState).toBe("PROCESSED_NONE");
    expect(raw.invoiceUndoCardId).toBeNull();
    expect(raw.invoiceUndoParcelaCount).toBe(0);
    expect(raw.invoiceUndoDueMonth).toBeNull();
    expect(raw.invoiceUndoTrailVersion).toBe(EXPECTED_TRAIL_VERSION);

    expect(await setup.importedInvoiceLiquidation.count({ where: { tenantId: TENANT } })).toBe(0);

    const detail = (await (bank as unknown as {
      getImportDetail: (...a: unknown[]) => Promise<Record<string, unknown>>;
    }).getImportDetail(TENANT, PESSOAL, accountId, commit.importId, R)) as Record<string, unknown>;
    expect(detail.canUndo).toBe(true);
  });
});
