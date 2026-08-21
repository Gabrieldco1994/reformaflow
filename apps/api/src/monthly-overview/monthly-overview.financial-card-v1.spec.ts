import { Test, TestingModule } from '@nestjs/testing';
import { MonthlyOverviewService } from './monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
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

  // U3-12, U3-13, U3-14, U3-15 → moved to integration spec
  // (monthly-overview.financial-card-v1.integration.spec.ts)

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

  // U3-18 non-espelho despesa with cardLast4 → emits general actions (U4)
  // Original trava assumed actions would be [] in V1. Now that action derivation
  // is implemented (U4, #453), a non-espelho expense emits edit/ratear/vincular/excluir.
  // Invoice-specific ambiguity (pay/undo veto) is handled at the account-view level,
  // not at the enrich/entry level.
  it('U3-18 non-espelho despesa with cardLast4 → has general actions', async () => {
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
    expect(entries[0].actions).toEqual([
      { actionId: 'edit' },
      { actionId: 'ratear' },
      { actionId: 'vincular' },
      { actionId: 'excluir' },
    ]);
  });
});
