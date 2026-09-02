import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MerchantClassifierService, AI_RULE_MIN_CONFIDENCE } from './merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * RED: classifyForImport(merchants, tenantId) — #582 PR-4/5 contract.
 *
 * Contrato exercido (decidido no design consolidado da issue #582):
 *   - `classifications` (Map<merchantKey, ImportClassification>) contém
 *     SOMENTE resultados confiáveis: MANUAL (tenant/global) → `source: 'regra'`;
 *     AI com `confidence >= AI_RULE_MIN_CONFIDENCE` → `source: 'ia'`.
 *     Qualquer outra origem (AI sub-limiar, `REGEX` legado, `CACHE` genérico,
 *     merchant nunca visto) fica FORA do Map — `has()` é `false`, não uma
 *     entrada com campo nulo.
 *   - `status`: 'ok' (nada pendente, ou pendente resolvido) | 'unavailable'
 *     (pendente sem GEMINI_API_KEY) | 'error' (provider ou persistência falhou).
 *   - Uma única leitura de cache (`findMany`) por chamada — mesmo no caminho
 *     de erro, não deve haver releitura.
 *
 * O shape `ImportClassification { category, source: 'regra'|'ia', confidence }`
 * abaixo É o contrato aprovado (produção real de #582 PR-4/5) — o método
 * ainda não existe nesta branch (`MerchantClassifierService` não expõe
 * `classifyForImport`); a spec pina a forma exigida literalmente, campo a
 * campo, incluindo o `confidence` numérico devolvido pela camada de cache.
 */
interface MerchantCategoryRow {
  merchantKey: string;
  category: string;
  subcategory?: string | null;
  source: string;
  confidence: number;
  tenantId: string | null;
}

interface ClassifierPrismaMock {
  merchantCategory: {
    findMany: jest.Mock;
    createMany: jest.Mock;
    update: jest.Mock;
  };
  $transaction: jest.Mock;
}

function buildPrismaMock(rows: MerchantCategoryRow[] = []): ClassifierPrismaMock {
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

async function buildService(
  prisma: ClassifierPrismaMock,
): Promise<MerchantClassifierService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [MerchantClassifierService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return module.get<MerchantClassifierService>(MerchantClassifierService);
}

describe('MerchantClassifierService.classifyForImport — #582 PR-4/5 contract', () => {
  let service: MerchantClassifierService;
  let prisma: ClassifierPrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock([]);
    service = await buildService(prisma);
  });

  it('rejects an invalid tenantId before any I/O (SEC-2)', async () => {
    // Chamada deliberadamente inválida — o argumento null não é assinável ao
    // parâmetro `tenantId: string`; @ts-expect-error documenta a violação de
    // tipo em vez de mascará-la com `as any`.
    await expect(
      // @ts-expect-error — tenantId nulo é exatamente o caso fora do contrato sob teste
      service.classifyForImport([], null),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.merchantCategory.findMany).not.toHaveBeenCalled();
  });

  it('resolves ok without any I/O for an empty merchant list', async () => {
    const result = await service.classifyForImport([], 'tenant-1');
    expect(result.status).toBe('ok');
    expect(result.classifications.size).toBe(0);
    expect(prisma.merchantCategory.findMany).not.toHaveBeenCalled();
  });

  it('unavailable: MANUAL cached kept as regra, unresolved pending absent, one cache read', async () => {
    prisma = buildPrismaMock([
      {
        merchantKey: 'manual merchant',
        category: 'alimentação',
        source: 'MANUAL',
        confidence: 1.0,
        tenantId: 'tenant-1',
      },
    ]);
    service = await buildService(prisma);

    // Sem GEMINI_API_KEY no ambiente de teste — 'Unknown Merchant' fica pendente.
    const result = await service.classifyForImport(['Manual Merchant', 'Unknown Merchant'], 'tenant-1');

    expect(result.status).toBe('unavailable');
    expect(result.classifications.get('manual merchant')).toEqual({
      category: 'alimentação',
      source: 'regra',
      confidence: 1.0,
    });
    expect(result.classifications.has('unknown merchant')).toBe(false);
    expect(prisma.merchantCategory.findMany).toHaveBeenCalledTimes(1);
  });

  it('source table: MANUAL→regra, AI≥limiar→ia; AI<limiar and legacy REGEX absent from the map', async () => {
    prisma = buildPrismaMock([
      { merchantKey: 'manual store', category: 'alimentação', source: 'MANUAL', confidence: 1.0, tenantId: 'tenant-1' },
      { merchantKey: 'ai high merchant', category: 'transporte', source: 'AI', confidence: 0.85, tenantId: 'tenant-1' },
      { merchantKey: 'ai low merchant', category: 'saúde', source: 'AI', confidence: 0.7, tenantId: 'tenant-1' },
      { merchantKey: 'legacy regex merchant', category: 'outros', source: 'REGEX', confidence: 0.9, tenantId: 'tenant-1' },
    ]);
    service = await buildService(prisma);

    const result = await service.classifyForImport(
      ['Manual Store', 'AI High Merchant', 'AI Low Merchant', 'Legacy Regex Merchant'],
      'tenant-1',
    );

    expect(result.status).toBe('ok');
    expect(result.classifications.get('manual store')).toEqual({
      category: 'alimentação',
      source: 'regra',
      confidence: 1.0,
    });
    expect(result.classifications.get('ai high merchant')).toEqual({
      category: 'transporte',
      source: 'ia',
      confidence: 0.85,
    });
    expect(result.classifications.has('ai low merchant')).toBe(false);
    expect(result.classifications.has('legacy regex merchant')).toBe(false);
    expect(prisma.merchantCategory.findMany).toHaveBeenCalledTimes(1);
  });

  it('boundary: confidence === AI_RULE_MIN_CONFIDENCE included as ia, one cent below is absent', async () => {
    expect(AI_RULE_MIN_CONFIDENCE).toBe(0.8);
    prisma = buildPrismaMock([
      { merchantKey: 'ai boundary high', category: 'lazer', source: 'AI', confidence: AI_RULE_MIN_CONFIDENCE, tenantId: 'tenant-1' },
      { merchantKey: 'ai boundary low', category: 'lazer', source: 'AI', confidence: AI_RULE_MIN_CONFIDENCE - 0.01, tenantId: 'tenant-1' },
    ]);
    service = await buildService(prisma);

    const result = await service.classifyForImport(['AI Boundary High', 'AI Boundary Low'], 'tenant-1');

    expect(result.classifications.get('ai boundary high')).toEqual({
      category: 'lazer',
      source: 'ia',
      confidence: AI_RULE_MIN_CONFIDENCE,
    });
    expect(result.classifications.has('ai boundary low')).toBe(false);
  });

  it('error: provider failure preserves cached AI≥limiar as ia, drops the failed pending chunk, one cache read', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = 'test-key-582';
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'gemini boom',
      }) as typeof fetch;

      const localPrisma = buildPrismaMock([
        { merchantKey: 'cached trusted', category: 'viagem', source: 'AI', confidence: 0.9, tenantId: 'tenant-1' },
      ]);
      const localService = await buildService(localPrisma);

      const result = await localService.classifyForImport(['Cached Trusted', 'New Unknown'], 'tenant-1');

      // Assertiva direta — sem `if`. Se o status vier 'ok' ou 'unavailable', o
      // teste falha aqui mesmo, sem passar disfarçado de RED.
      expect(result.status).toBe('error');
      expect(result.classifications.get('cached trusted')).toEqual({
        category: 'viagem',
        source: 'ia',
        confidence: 0.9,
      });
      expect(result.classifications.has('new unknown')).toBe(false);
      expect(localPrisma.merchantCategory.findMany).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it('error: provider returns a valid classification but the persistence transaction fails — status error, cache preserved, unpersisted chunk absent, one cache read', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = 'test-key-582';
      // Provider responde OK com uma classificação válida — a falha está na
      // escrita (ex.: $transaction rejeitando por lock/timeout do SQLite),
      // não no fetch.
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify([
                      { merchant: 'New Pending Merchant', category: 'alimentação', subcategory: 'restaurante', confidence: 0.95 },
                    ]),
                  },
                ],
              },
            },
          ],
        }),
      }) as typeof fetch;

      const localPrisma = buildPrismaMock([
        { merchantKey: 'cached kept persisted', category: 'viagem', source: 'AI', confidence: 0.9, tenantId: 'tenant-1' },
      ]);
      // Persistência falha: a tx do chunk pendente rejeita (provider já
      // respondeu OK — o buffer local do chunk nunca chega a ser mesclado
      // no Map final, pois o merge só ocorre depois que a tx resolve).
      localPrisma.$transaction = jest.fn().mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
      const localService = await buildService(localPrisma);

      const result = await localService.classifyForImport(
        ['Cached Kept Persisted', 'New Pending Merchant'],
        'tenant-1',
      );

      // Assertiva direta — sem `if`. Se vier 'ok' ou 'unavailable', falha aqui.
      expect(result.status).toBe('error');
      expect(result.classifications.get('cached kept persisted')).toEqual({
        category: 'viagem',
        source: 'ia',
        confidence: 0.9,
      });
      expect(result.classifications.has('new pending merchant')).toBe(false);
      expect(localPrisma.merchantCategory.findMany).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalKey;
    }
  });
});
