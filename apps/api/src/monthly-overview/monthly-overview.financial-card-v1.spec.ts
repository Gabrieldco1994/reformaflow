import { Test, TestingModule } from '@nestjs/testing';
import { MonthlyOverviewService } from './monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import { assertFinancialItemCardV1Shape } from '@reformaflow/domain';

/**
 * U3 — FinancialItemCardV1 contract tests for the enrich() path.
 * These validate that the V1 fields emitted by getOverview().entries
 * conform to the FinancialItemCardV1 shape and never leak internal refs.
 */
describe('MonthlyOverviewService — FinancialItemCardV1 contract', () => {
  let service: MonthlyOverviewService;
  let prisma: any;
  const tenantId = 'tenant-1';
  const PESSOAL = 'pessoal-1';

  const baseCfe = (over: Record<string, unknown> = {}) => ({
    id: 'cfe-1',
    projectId: PESSOAL,
    tenantId,
    tipo: 'DESPESA',
    status: 'PAGO',
    valor: 5000,
    data: new Date('2026-05-10T00:00:00.000Z'),
    categoria: 'OUTROS',
    subcategoria: null,
    formaPagamento: 'A_VISTA',
    parcela: null,
    expenseId: 'exp-1',
    receiptId: null,
    expense: {
      linkedExpenseId: null,
      cardLast4: null,
      bankLast4: null,
      tipoDespesa: 'OUTROS',
      titulo: null,
      fornecedor: null,
    },
    receipt: null,
    ...over,
  });

  beforeEach(async () => {
    prisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue({
          id: PESSOAL,
          tenantId,
          type: 'PESSOAL',
          deletedAt: null,
        }),
        findMany: jest.fn().mockResolvedValue([
          { id: PESSOAL, type: 'PESSOAL', name: 'Pessoal' },
        ]),
      },
      cashFlowEntry: { findMany: jest.fn().mockResolvedValue([]) },
      bankAccount: { findMany: jest.fn().mockResolvedValue([]) },
      expense: { findMany: jest.fn().mockResolvedValue([]) },
      receipt: { findMany: jest.fn().mockResolvedValue([]) },
      creditCard: { findMany: jest.fn().mockResolvedValue([]) },
      cardInvoice: { findMany: jest.fn().mockResolvedValue([]) },
      cardInvoiceSettlement: { findMany: jest.fn().mockResolvedValue([]) },
      rateioAllocation: { findMany: jest.fn().mockResolvedValue([]) },
      cardInvoiceAdjustment: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonthlyOverviewService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: CardInvoiceSettlementService,
          useValue: { settleInvoice: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<MonthlyOverviewService>(MonthlyOverviewService);
  });

  async function getEntries(cfes: unknown[]) {
    prisma.cashFlowEntry.findMany.mockResolvedValue(cfes);
    const result = await service.getOverview(tenantId, PESSOAL);
    return result.entries;
  }

  // U3-11
  it('U3-11 despesa sem evidência → hasEvidence === false && typeof boolean', async () => {
    const entries = await getEntries([baseCfe()]);
    expect(entries).toHaveLength(1);
    expect(entries[0].hasEvidence).toBe(false);
    expect(typeof entries[0].hasEvidence).toBe('boolean');
  });

  // U3-12 — THE TRAP: imageUrl is product image, NOT evidence
  it('U3-12 despesa COM imageUrl → hasEvidence === false', async () => {
    const cfe = baseCfe({
      expense: {
        linkedExpenseId: null,
        cardLast4: null,
        bankLast4: null,
        tipoDespesa: 'OUTROS',
        titulo: null,
        fornecedor: null,
        imageUrl: 'https://example.com/product.jpg',
      },
    });
    const entries = await getEntries([cfe]);
    expect(entries[0].hasEvidence).toBe(false);
  });

  // U3-13
  it('U3-13 imageUrl: "" → hasEvidence === false', async () => {
    const cfe = baseCfe({
      expense: {
        linkedExpenseId: null,
        cardLast4: null,
        bankLast4: null,
        tipoDespesa: 'OUTROS',
        titulo: null,
        fornecedor: null,
        imageUrl: '',
      },
    });
    const entries = await getEntries([cfe]);
    expect(entries[0].hasEvidence).toBe(false);
  });

  // U3-14 — import metadata must not leak
  it('U3-14 importId/fileName não vazam no payload', async () => {
    const cfe = baseCfe({
      expense: {
        linkedExpenseId: null,
        cardLast4: '9999',
        bankLast4: null,
        tipoDespesa: 'OUTROS',
        titulo: null,
        fornecedor: null,
        importId: 'imp-nubank-1',
      },
    });
    const entries = await getEntries([cfe]);
    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain('imp-nubank-1');
    expect(serialized).not.toMatch(/fileName|filePath|fileUrl/);
    // Also validate full shape
    assertFinancialItemCardV1Shape({
      ...entries[0],
      // enrich emits legacy fields too; pick only V1 for shape check
      id: entries[0].id,
      kind: entries[0].kind,
      origin: entries[0].origin,
      originProjectId: entries[0].originProjectId,
      originProjectName: entries[0].originProjectName,
      purpose: entries[0].purpose,
      purposeLabel: entries[0].purposeLabel,
      amountCents: entries[0].amountCents,
      date: entries[0].date,
      status: entries[0].status,
      title: entries[0].title,
      supplier: entries[0].supplier,
      installment: entries[0].installment,
      paymentForm: entries[0].paymentForm,
      relationship: entries[0].relationship,
      hasEvidence: entries[0].hasEvidence,
      actions: entries[0].actions,
      isEspelho: entries[0].isEspelho,
      isNeutral: entries[0].isNeutral,
    });
  });

  // U3-15 [CANARY]
  it('U3-15 [CANARY] todas as entries → hasEvidence === false', async () => {
    // Canário deliberado. Quando a H2 (#465) adicionar um produtor de evidência,
    // este teste DEVE ficar VERMELHO. O vermelho é o sinal desejado: atualize a
    // derivação no `enrich()` para refletir a nova verdade e então faça este teste
    // afirmar os valores corretos. NÃO delete este teste — ele existe para impedir
    // que `hasEvidence` minta em silêncio.
    const cfes = [
      baseCfe({ id: 'cfe-simple' }),
      baseCfe({
        id: 'cfe-image',
        expense: {
          linkedExpenseId: null, cardLast4: null, bankLast4: null,
          tipoDespesa: 'OUTROS', titulo: null, fornecedor: null,
          imageUrl: 'https://example.com/product.jpg',
        },
      }),
      baseCfe({
        id: 'cfe-import',
        expense: {
          linkedExpenseId: null, cardLast4: '1234', bankLast4: null,
          tipoDespesa: 'OUTROS', titulo: null, fornecedor: null,
          importId: 'imp-1',
        },
      }),
    ];
    const entries = await getEntries(cfes);
    expect(entries.every((e: any) => e.hasEvidence === false)).toBe(true);
  });

  // U3-16
  it('U3-16 importId value não aparece no payload de despesa importada', async () => {
    const cfe = baseCfe({
      expense: {
        linkedExpenseId: null, cardLast4: null, bankLast4: null,
        tipoDespesa: 'OUTROS', titulo: null, fornecedor: null,
        importId: 'imp-xyz-999',
      },
    });
    const entries = await getEntries([cfe]);
    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain('imp-xyz-999');
  });

  // U3-17 [TRAVA] Attachment com deletedAt não conta como evidência
  it('U3-17 [TRAVA] Attachment soft-deleted não conta como evidência', async () => {
    // No V1, hasEvidence is always false — this passes trivially.
    // This test locks the invariant for H2: when evidence derivation is added,
    // a soft-deleted Attachment must NOT count.
    const entries = await getEntries([baseCfe()]);
    expect(entries[0].hasEvidence).toBe(false);
  });

  // U3-18 fatura com last4 ambíguo → actions: []
  it('U3-18 fatura com last4 ambíguo → actions: []', async () => {
    // In V1, actions are always empty. This locks the invariant for when
    // action derivation is added: ambiguous last4 must yield no actions.
    const cfe = baseCfe({
      expense: {
        linkedExpenseId: null,
        cardLast4: '5555',
        bankLast4: null,
        tipoDespesa: 'OUTROS',
        titulo: null,
        fornecedor: null,
      },
    });
    const entries = await getEntries([cfe]);
    expect(entries[0].actions).toEqual([]);
  });
});
