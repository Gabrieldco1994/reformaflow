import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ExpenseType } from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';
import {
  AI_RULE_MIN_CONFIDENCE,
  MerchantClassifierService,
  resolveLearnedTypeFromRows,
  type MerchantRuleRow,
} from './merchant-classifier.service';

const TENANT = 'tenant-x';
const T = AI_RULE_MIN_CONFIDENCE;
const row = (over: Partial<MerchantRuleRow>): MerchantRuleRow => ({
  tenantId: TENANT, merchantKey: 'padaria', category: 'alimentação', source: 'MANUAL', confidence: 1, ...over,
});

describe('resolveLearnedTypeFromRows — cadeia de precedência (#582 PR-2)', () => {
  const call = (rows: MerchantRuleRow[], manualOnly = false) =>
    resolveLearnedTypeFromRows(rows, { tenantId: TENANT, threshold: T, manualOnly });

  it('MANUAL tenant vence tudo', () => {
    const r = call([
      row({ tenantId: TENANT, source: 'MANUAL', category: 'saúde' }),
      row({ tenantId: TENANT, source: 'AI', category: 'transporte', confidence: 0.99 }),
      row({ tenantId: null, source: 'MANUAL', category: 'educação' }),
      row({ tenantId: null, source: 'AI', category: 'lazer', confidence: 0.99 }),
    ]);
    expect(r).toMatchObject({ expenseType: ExpenseType.SAUDE, source: 'MANUAL_TENANT', reason: 'resolvido' });
  });

  it('AI tenant >= T vence MANUAL global', () => {
    const r = call([
      row({ tenantId: TENANT, source: 'AI', category: 'transporte', confidence: 0.9 }),
      row({ tenantId: null, source: 'MANUAL', category: 'saúde' }),
    ]);
    expect(r).toMatchObject({ expenseType: ExpenseType.TRANSPORTE, source: 'AI_TENANT' });
  });

  it('AI tenant < T é ignorado e cai em MANUAL global', () => {
    const r = call([
      row({ tenantId: TENANT, source: 'AI', category: 'transporte', confidence: T - 0.2 }),
      row({ tenantId: null, source: 'MANUAL', category: 'saúde' }),
    ]);
    expect(r).toMatchObject({ expenseType: ExpenseType.SAUDE, source: 'MANUAL_GLOBAL' });
  });

  it('AI tenant < T e sem global → null + reason sub-limiar', () => {
    const r = call([row({ tenantId: TENANT, source: 'AI', category: 'transporte', confidence: 0.3 })]);
    expect(r).toEqual({ expenseType: null, source: null, confidence: null, category: null, reason: 'sub-limiar' });
  });

  it('sem nenhuma linha → null + reason sem-regra', () => {
    expect(call([])).toMatchObject({ expenseType: null, source: null, reason: 'sem-regra' });
  });

  it('SEC-1: AI global (tenantId null, source AI, confidence 0.99) NUNCA é retornado', () => {
    const r = call([row({ tenantId: null, source: 'AI', category: 'transporte', confidence: 0.99 })]);
    expect(r).toMatchObject({ expenseType: null, source: null, reason: 'sem-regra' });
  });

  it('SEC-1: AI global + AI tenant < T → ainda null', () => {
    const r = call([
      row({ tenantId: TENANT, source: 'AI', category: 'lazer', confidence: 0.4 }),
      row({ tenantId: null, source: 'AI', category: 'transporte', confidence: 0.99 }),
    ]);
    expect(r).toMatchObject({ expenseType: null, source: null, reason: 'sub-limiar' });
  });

  it('manualOnly ignora o tier de AI tenant, mesmo confidence 0.99', () => {
    const r = call([
      row({ tenantId: TENANT, source: 'AI', category: 'transporte', confidence: 0.99 }),
      row({ tenantId: null, source: 'MANUAL', category: 'saúde' }),
    ], true);
    expect(r).toMatchObject({ expenseType: ExpenseType.SAUDE, source: 'MANUAL_GLOBAL' });
  });

  it('manualOnly + só AI tenant → sem-regra', () => {
    const r = call([row({ tenantId: TENANT, source: 'AI', category: 'transporte', confidence: 0.99 })], true);
    expect(r).toMatchObject({ expenseType: null, source: null, reason: 'sem-regra' });
  });

  it('boundary: confidence EXATAMENTE T → aceito (>=)', () => {
    const r = call([row({ tenantId: TENANT, source: 'AI', category: 'transporte', confidence: T })]);
    expect(r).toMatchObject({ expenseType: ExpenseType.TRANSPORTE, source: 'AI_TENANT' });
  });
  it('boundary: T - 0.01 → rejeitado', () => {
    const r = call([row({ tenantId: TENANT, source: 'AI', category: 'transporte', confidence: Number((T - 0.01).toFixed(2)) })]);
    expect(r.expenseType).toBeNull();
    expect(r.reason).toBe('sub-limiar');
  });
  it('boundary: T + 0.01 → aceito', () => {
    const r = call([row({ tenantId: TENANT, source: 'AI', category: 'transporte', confidence: Number((T + 0.01).toFixed(2)) })]);
    expect(r).toMatchObject({ expenseType: ExpenseType.TRANSPORTE, source: 'AI_TENANT' });
  });

  it('confidence null numa linha AI tenant → sub-limiar', () => {
    const r = call([row({ tenantId: TENANT, source: 'AI', category: 'transporte', confidence: null })]);
    expect(r).toMatchObject({ expenseType: null, reason: 'sub-limiar' });
  });

  it('reason sem-categoria-equivalente: MANUAL tenant com categoria que mapeia p/ OUTROS', () => {
    for (const cat of ['compras', 'servicos', 'impostos', 'investimentos']) {
      const r = call([row({ tenantId: TENANT, source: 'MANUAL', category: cat })]);
      expect(r).toMatchObject({ expenseType: null, source: 'MANUAL_TENANT', category: cat, reason: 'sem-categoria-equivalente' });
    }
  });

  it('reason sem-categoria-equivalente: AI tenant >= T com categoria → OUTROS', () => {
    const r = call([row({ tenantId: TENANT, source: 'AI', category: 'servicos', confidence: 0.95 })]);
    expect(r).toMatchObject({ expenseType: null, source: 'AI_TENANT', reason: 'sem-categoria-equivalente' });
  });

  it('SEC-6: source legado desconhecido ("REGEX"/"CACHE"/"FOO") no tenant é untrusted → cai fora', () => {
    for (const legacy of ['REGEX', 'CACHE', 'FOO']) {
      const r = call([row({ tenantId: TENANT, source: legacy, category: 'transporte' })]);
      expect(r).toMatchObject({ expenseType: null, source: null, reason: 'sem-regra' });
    }
  });
});

describe('resolveLearnedExpenseType (método, Prisma mockado) — #582 PR-2', () => {
  let service: MerchantClassifierService;
  let prisma: { merchantCategory: { findMany: jest.Mock } };

  beforeEach(async () => {
    prisma = { merchantCategory: { findMany: jest.fn().mockResolvedValue([]) } };
    const module: TestingModule = await Test.createTestingModule({
      providers: [MerchantClassifierService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(MerchantClassifierService);
  });

  it('SEC-2: tenantId "" / undefined → BadRequestException, findMany não chamado', async () => {
    await expect(service.resolveLearnedExpenseType('Padaria', '')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.resolveLearnedExpenseType('Padaria', undefined as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.merchantCategory.findMany).not.toHaveBeenCalled();
  });

  it('lê linha do tenant E global (OR) e aplica precedência AI tenant >= T', async () => {
    prisma.merchantCategory.findMany.mockResolvedValue([
      { tenantId: 'tid', merchantKey: 'ifood', category: 'alimentação', source: 'AI', confidence: 0.9 },
      { tenantId: null, merchantKey: 'ifood', category: 'saúde', source: 'MANUAL', confidence: 1 },
    ]);
    const r = await service.resolveLearnedExpenseType('Ifood', 'tid');
    expect(prisma.merchantCategory.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ OR: [{ tenantId: 'tid' }, { tenantId: null }] }),
    );
    expect(r).toMatchObject({ expenseType: ExpenseType.ALIMENTACAO, source: 'AI_TENANT' });
  });

  it('manualExpenseType é shim sobre resolveLearnedExpenseType({manualOnly:true})', async () => {
    prisma.merchantCategory.findMany.mockResolvedValue([
      { tenantId: 'tid', merchantKey: 'ifood', category: 'alimentação', source: 'AI', confidence: 0.99 },
      { tenantId: null, merchantKey: 'ifood', category: 'saúde', source: 'MANUAL', confidence: 1 },
    ]);
    await expect(service.manualExpenseType('Ifood', 'tid')).resolves.toBe(ExpenseType.SAUDE);
  });
});
