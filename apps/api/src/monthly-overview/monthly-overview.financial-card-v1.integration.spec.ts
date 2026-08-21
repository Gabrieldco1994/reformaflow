// The test DB guard must load before PrismaService imports PrismaClient.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { MonthlyOverviewService } from './monthly-overview.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertFinancialItemCardV1Shape } from '@reformaflow/domain';

/**
 * U3 — FinancialItemCardV1 integration tests with real database.
 * These validate the REAL query path: data seeded in the DB flows through
 * the real Prisma query and enrich(), so no mock can silently mask a leak.
 */
describe('FinancialItemCardV1 — integration (real DB)', () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const service = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );

  const IDS = {
    tenant: 'u3-integ-tenant',
    pessoal: 'u3-integ-pessoal',
    card: 'u3-integ-card',
    import: 'u3-integ-import',
    expSimple: 'u3-integ-exp-simple',
    expImage: 'u3-integ-exp-image',
    expImported: 'u3-integ-exp-imported',
    expEmpty: 'u3-integ-exp-empty-img',
    cfeSimple: 'u3-integ-cfe-simple',
    cfeImage: 'u3-integ-cfe-image',
    cfeImported: 'u3-integ-cfe-imported',
    cfeEmpty: 'u3-integ-cfe-empty-img',
  } as const;

  const DATA_DATE = new Date('2026-05-10T00:00:00.000Z');

  async function cleanup() {
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: IDS.tenant } });
    await setup.expense.deleteMany({ where: { tenantId: IDS.tenant } });
    await setup.creditCardStatementImport.deleteMany({ where: { tenantId: IDS.tenant } });
    await setup.creditCard.deleteMany({ where: { tenantId: IDS.tenant } });
    await setup.project.deleteMany({ where: { tenantId: IDS.tenant } });
    await setup.tenant.deleteMany({ where: { id: IDS.tenant } });
  }

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await cleanup();

    // Seed tenant + project
    await setup.tenant.create({ data: { id: IDS.tenant, name: 'U3 Integration' } });
    await setup.project.create({
      data: {
        id: IDS.pessoal,
        tenantId: IDS.tenant,
        type: 'PESSOAL',
        name: 'Pessoal U3',
      },
    });

    // Seed credit card + import (for U3-14)
    await setup.creditCard.create({
      data: {
        id: IDS.card,
        projectId: IDS.pessoal,
        tenantId: IDS.tenant,
        institution: 'NUBANK',
        nickname: 'Nubank U3',
        last4: '9999',
      },
    });
    await setup.creditCardStatementImport.create({
      data: {
        id: IDS.import,
        cardId: IDS.card,
        tenantId: IDS.tenant,
        periodLabel: '2026-05',
        source: 'OFX',
        fileName: 'fatura-nubank-2026-05.ofx',
        status: 'COMPLETED',
      },
    });

    // Expense 1: simple, no imageUrl
    await setup.expense.create({
      data: {
        id: IDS.expSimple,
        projectId: IDS.pessoal,
        tenantId: IDS.tenant,
        tipoDespesa: 'OUTROS',
        valor: 5000,
        quantidade: 1,
        valorTotal: 5000,
        formaPagamento: 'A_VISTA',
        dataPagamento: DATA_DATE,
        status: 'PAGO',
      },
    });

    // Expense 2: with imageUrl (product image, NOT evidence)
    await setup.expense.create({
      data: {
        id: IDS.expImage,
        projectId: IDS.pessoal,
        tenantId: IDS.tenant,
        tipoDespesa: 'OUTROS',
        valor: 3000,
        quantidade: 1,
        valorTotal: 3000,
        formaPagamento: 'A_VISTA',
        dataPagamento: DATA_DATE,
        status: 'PAGO',
        imageUrl: 'https://example.com/product.jpg',
      },
    });

    // Expense 3: with empty imageUrl
    await setup.expense.create({
      data: {
        id: IDS.expEmpty,
        projectId: IDS.pessoal,
        tenantId: IDS.tenant,
        tipoDespesa: 'OUTROS',
        valor: 1000,
        quantidade: 1,
        valorTotal: 1000,
        formaPagamento: 'A_VISTA',
        dataPagamento: DATA_DATE,
        status: 'PAGO',
        imageUrl: '',
      },
    });

    // Expense 4: imported from credit card statement
    await setup.expense.create({
      data: {
        id: IDS.expImported,
        projectId: IDS.pessoal,
        tenantId: IDS.tenant,
        tipoDespesa: 'OUTROS',
        valor: 7500,
        quantidade: 1,
        valorTotal: 7500,
        formaPagamento: 'CARTAO_CREDITO',
        dataPagamento: DATA_DATE,
        status: 'PAGO',
        cardLast4: '9999',
        importId: IDS.import,
      },
    });

    // CashFlowEntries for each expense
    const cfBase = {
      projectId: IDS.pessoal,
      tenantId: IDS.tenant,
      tipo: 'DESPESA',
      status: 'PAGO',
      data: DATA_DATE,
      categoria: 'OUTROS',
      formaPagamento: 'A_VISTA',
    };

    await setup.cashFlowEntry.createMany({
      data: [
        { id: IDS.cfeSimple, ...cfBase, valor: 5000, expenseId: IDS.expSimple },
        { id: IDS.cfeImage, ...cfBase, valor: 3000, expenseId: IDS.expImage },
        { id: IDS.cfeEmpty, ...cfBase, valor: 1000, expenseId: IDS.expEmpty },
        {
          id: IDS.cfeImported, ...cfBase, valor: 7500, expenseId: IDS.expImported,
          formaPagamento: 'CARTAO_CREDITO',
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanup();
    await setup.$disconnect();
    await prisma.onModuleDestroy?.();
  });

  async function getAllEntries() {
    const result = await service.getOverview(IDS.tenant, IDS.pessoal);
    return result.entries;
  }

  // U3-12 — THE TRAP: imageUrl is product image, NOT evidence.
  // The real Prisma query's `select` on Expense does NOT include imageUrl,
  // so it never reaches enrich(). Even if someone ADDS imageUrl to the select,
  // enrich() must still not derive hasEvidence from it.
  it('U3-12 despesa COM imageUrl gravado no banco → hasEvidence === false', async () => {
    const entries = await getAllEntries();
    const entry = entries.find((e: any) => e.id === IDS.cfeImage);
    expect(entry).toBeDefined();
    expect(entry!.hasEvidence).toBe(false);
    expect(typeof entry!.hasEvidence).toBe('boolean');

    // Verify imageUrl is NOT present in the serialized output
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('product.jpg');
    expect(serialized).not.toMatch(/imageUrl/);
  });

  // U3-13
  it('U3-13 despesa COM imageUrl: "" no banco → hasEvidence === false', async () => {
    const entries = await getAllEntries();
    const entry = entries.find((e: any) => e.id === IDS.cfeEmpty);
    expect(entry).toBeDefined();
    expect(entry!.hasEvidence).toBe(false);
  });

  // U3-14 — import metadata must not leak through the real query
  it('U3-14 importId/fileName não vazam no payload (banco real)', async () => {
    const entries = await getAllEntries();
    const entry = entries.find((e: any) => e.id === IDS.cfeImported);
    expect(entry).toBeDefined();

    const serialized = JSON.stringify(entry);
    // The import's fileName must not appear
    expect(serialized).not.toContain('fatura-nubank-2026-05.ofx');
    // The importId value must not appear
    expect(serialized).not.toContain(IDS.import);
    // No import-related keys
    expect(serialized).not.toMatch(/fileName|filePath|fileUrl|importId/);

    // Full V1 shape validation (pick only V1 keys to avoid banned legacy keys)
    assertFinancialItemCardV1Shape({
      id: entry!.id,
      kind: (entry as any).kind,
      origin: (entry as any).origin,
      originProjectId: (entry as any).originProjectId,
      originProjectName: (entry as any).originProjectName,
      purpose: (entry as any).purpose,
      purposeLabel: (entry as any).purposeLabel,
      amountCents: (entry as any).amountCents,
      date: (entry as any).date,
      status: (entry as any).status,
      title: (entry as any).title,
      supplier: (entry as any).supplier,
      installment: (entry as any).installment,
      paymentForm: (entry as any).paymentForm,
      relationship: (entry as any).relationship,
      hasEvidence: (entry as any).hasEvidence,
      actions: (entry as any).actions,
      isEspelho: (entry as any).isEspelho,
      isNeutral: (entry as any).isNeutral,
    });
  });

  // U3-15 [CANARY]
  it('U3-15 [CANARY] todas as entries do banco → hasEvidence === false', async () => {
    // Canário deliberado. Quando a H2 (#465) adicionar um produtor de evidência,
    // este teste DEVE ficar VERMELHO. O vermelho é o sinal desejado: atualize a
    // derivação no `enrich()` para refletir a nova verdade e então faça este teste
    // afirmar os valores corretos. NÃO delete este teste — ele existe para impedir
    // que `hasEvidence` minta em silêncio.
    const entries = await getAllEntries();
    expect(entries.length).toBeGreaterThanOrEqual(4); // simple + image + empty + imported
    expect(entries.every((e: any) => e.hasEvidence === false)).toBe(true);
  });
});
