import { Test, TestingModule } from '@nestjs/testing';
import { AI_RULE_MIN_CONFIDENCE, MerchantClassifierService } from './merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * RED — issue #582 REOPENED. Full precedence on the LIVE path (`classifyForImport`
 * → `classifyBatchDetailed`), NOT only `resolveLearnedTypeFromRows`.
 *
 *   INV-1  MANUAL tenant > AI tenant (conf >= AI_RULE_MIN_CONFIDENCE) > MANUAL global > local
 *   INV-2  AI global (tenantId null) is NEVER applied, at any confidence (SEC-1)
 *
 * Failing defects encoded:
 *   #1 cachedMap picks tenant row purely by tenantId (no tiering)
 *   #2 AI-tenant sub-τ masks MANUAL-global instead of falling through
 *   #3 AI-global >= τ flows in as source:'ia'
 *
 * No GEMINI_API_KEY / fetch here — every merchant is a cache hit, so the provider
 * is never consulted and `status` is driven purely by the cache resolution.
 */
interface Row {
  merchantKey: string;
  category: string;
  subcategory?: string | null;
  source: string;
  confidence: number;
  tenantId: string | null;
}

function buildPrismaMock(rows: Row[]) {
  const merchantCategory = {
    findMany: jest.fn().mockResolvedValue(rows),
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    update: jest.fn().mockResolvedValue({}),
  };
  return {
    merchantCategory,
    $transaction: jest.fn((cb: (tx: { merchantCategory: typeof merchantCategory }) => unknown) =>
      cb({ merchantCategory }),
    ),
  };
}

async function buildService(prisma: ReturnType<typeof buildPrismaMock>) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [MerchantClassifierService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  const svc = module.get<MerchantClassifierService>(MerchantClassifierService);
  // guarantee the provider is never a factor in these cache-only cases
  (svc as unknown as { apiKey?: string }).apiKey = undefined;
  return svc;
}

describe('classifyForImport — precedence on the live path (#582 reopen)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('τ constant is pinned at 0.8 and compared with >=', () => {
    expect(AI_RULE_MIN_CONFIDENCE).toBe(0.8);
  });

  it('tier 1: MANUAL tenant beats AI tenant >=τ and MANUAL global for the same key', async () => {
    const prisma = buildPrismaMock([
      { merchantKey: 'padaria central', category: 'alimentação', source: 'MANUAL', confidence: 1.0, tenantId: 'tenant-1' },
      { merchantKey: 'padaria central', category: 'transporte', source: 'AI', confidence: 0.99, tenantId: 'tenant-1' },
      { merchantKey: 'padaria central', category: 'lazer', source: 'MANUAL', confidence: 1.0, tenantId: null },
    ]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(['Padaria Central'], 'tenant-1');

    expect(status).toBe('ok');
    expect(classifications.get('padaria central')).toEqual({
      category: 'alimentação',
      source: 'regra',
      confidence: 1.0,
    });
  });

  it('tier 2: AI tenant at exactly τ is applied as ia even when a MANUAL global exists', async () => {
    const prisma = buildPrismaMock([
      { merchantKey: 'mercado x', category: 'alimentação', source: 'AI', confidence: AI_RULE_MIN_CONFIDENCE, tenantId: 'tenant-1' },
      { merchantKey: 'mercado x', category: 'lazer', source: 'MANUAL', confidence: 1.0, tenantId: null },
    ]);
    const svc = await buildService(prisma);

    const { classifications } = await svc.classifyForImport(['Mercado X'], 'tenant-1');

    expect(classifications.get('mercado x')).toEqual({
      category: 'alimentação',
      source: 'ia',
      confidence: AI_RULE_MIN_CONFIDENCE,
    });
  });

  it('DEFECT #2: AI tenant one cent below τ falls through to MANUAL global (not masked, not dropped)', async () => {
    const prisma = buildPrismaMock([
      { merchantKey: 'posto sul', category: 'alimentação', source: 'AI', confidence: AI_RULE_MIN_CONFIDENCE - 0.01, tenantId: 'tenant-1' },
      { merchantKey: 'posto sul', category: 'transporte', source: 'MANUAL', confidence: 1.0, tenantId: null },
    ]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(['Posto Sul'], 'tenant-1');

    expect(status).toBe('ok');
    // today: AI-tenant 0.79 wins the cachedMap, then classifyForImport drops it (<τ),
    // MANUAL-global never consulted -> entry absent. Target: MANUAL-global applied.
    expect(classifications.get('posto sul')).toEqual({
      category: 'transporte',
      source: 'regra',
      confidence: 1.0,
    });
  });

  it('DEFECT #2b: AI tenant at 0.3 falls through to MANUAL global', async () => {
    const prisma = buildPrismaMock([
      { merchantKey: 'farmacia leste', category: 'alimentação', source: 'AI', confidence: 0.3, tenantId: 'tenant-1' },
      { merchantKey: 'farmacia leste', category: 'saúde', source: 'MANUAL', confidence: 1.0, tenantId: null },
    ]);
    const svc = await buildService(prisma);

    const { classifications } = await svc.classifyForImport(['Farmacia Leste'], 'tenant-1');

    expect(classifications.get('farmacia leste')).toEqual({
      category: 'saúde',
      source: 'regra',
      confidence: 1.0,
    });
  });

  it('DEFECT #1: unknown-source tenant row does not shadow a MANUAL global', async () => {
    const prisma = buildPrismaMock([
      // 'mercado centro' (não 'loja centro': normalizeKey remove a stopword
      // 'loja', então a chave persistida não casaria com o sample normalizado).
      { merchantKey: 'mercado centro', category: 'alimentação', source: 'CACHE', confidence: 0.9, tenantId: 'tenant-1' },
      { merchantKey: 'mercado centro', category: 'saúde', source: 'MANUAL', confidence: 1.0, tenantId: null },
    ]);
    const svc = await buildService(prisma);

    const { classifications } = await svc.classifyForImport(['Mercado Centro'], 'tenant-1');

    expect(classifications.get('mercado centro')).toEqual({
      category: 'saúde',
      source: 'regra',
      confidence: 1.0,
    });
  });

  describe('DEFECT #3: AI global is never applied (SEC-1)', () => {
    for (const confidence of [0.9, 0.99, 1.0]) {
      it(`AI global at confidence ${confidence} is absent from the map`, async () => {
        const prisma = buildPrismaMock([
          { merchantKey: 'assinatura z', category: 'assinaturas', source: 'AI', confidence, tenantId: null },
        ]);
        const svc = await buildService(prisma);

        const { classifications } = await svc.classifyForImport(['Assinatura Z'], 'tenant-1');

        expect(classifications.has('assinatura z')).toBe(false);
      });
    }

    it('AI global is rejected but a MANUAL global for another key is still honored', async () => {
      const prisma = buildPrismaMock([
        { merchantKey: 'ai global merchant', category: 'transporte', source: 'AI', confidence: 1.0, tenantId: null },
        { merchantKey: 'manual global merchant', category: 'saúde', source: 'MANUAL', confidence: 1.0, tenantId: null },
      ]);
      const svc = await buildService(prisma);

      const { classifications } = await svc.classifyForImport(
        ['AI Global Merchant', 'Manual Global Merchant'],
        'tenant-1',
      );

      expect(classifications.has('ai global merchant')).toBe(false);
      expect(classifications.get('manual global merchant')).toEqual({
        category: 'saúde',
        source: 'regra',
        confidence: 1.0,
      });
    });

    it('AI global does not mask a MANUAL global for the SAME key', async () => {
      const prisma = buildPrismaMock([
        { merchantKey: 'dup key', category: 'transporte', source: 'AI', confidence: 0.99, tenantId: null },
        { merchantKey: 'dup key', category: 'saúde', source: 'MANUAL', confidence: 1.0, tenantId: null },
      ]);
      const svc = await buildService(prisma);

      const { classifications } = await svc.classifyForImport(['Dup Key'], 'tenant-1');

      expect(classifications.get('dup key')).toEqual({
        category: 'saúde',
        source: 'regra',
        confidence: 1.0,
      });
    });
  });

  it('regression: plain AI-tenant >=τ with no competing rule still resolves as ia', async () => {
    const prisma = buildPrismaMock([
      { merchantKey: 'uber trip', category: 'transporte', source: 'AI', confidence: 0.9, tenantId: 'tenant-1' },
    ]);
    const svc = await buildService(prisma);

    const { classifications } = await svc.classifyForImport(['Uber Trip'], 'tenant-1');

    expect(classifications.get('uber trip')).toEqual({
      category: 'transporte',
      source: 'ia',
      confidence: 0.9,
    });
  });
});
