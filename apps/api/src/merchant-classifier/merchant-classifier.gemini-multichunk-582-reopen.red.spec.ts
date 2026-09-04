import { Test, TestingModule } from '@nestjs/testing';
import {
  AI_RULE_MIN_CONFIDENCE,
  MerchantClassifierService,
  sanitizeConfidence,
  UNKNOWN_CONFIDENCE,
} from './merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';
import { F1_DROPPED_CATEGORIES, NOISY_MERCHANT_FIXTURE } from './__tests__/noisy-merchant-fixture';

/**
 * RED — #582 REOPENED rev2. Two things echo-by-name / turn-green got wrong:
 *  (a) a chunk that fails VALIDATION must NOT abort the remaining chunks — only a
 *      NETWORK error aborts the `for`. Chunk 1 valid + chunk 2 poisoned + chunk 3
 *      valid  ->  chunks 1 and 3 persist, batch status 'error'.
 *  (b) real noisy bank-statement merchants ("PAY IFD 12/03" resolved to "iFood")
 *      must classify fine under the index model — echo-by-name would false-reject
 *      the whole 60-item chunk.
 */
interface Row {
  merchantKey: string;
  category: string;
  subcategory?: string | null;
  source: string;
  confidence: number;
  tenantId: string | null;
}

function buildPrismaMock(rows: Row[] = []) {
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
  (svc as unknown as { apiKey: string }).apiKey = 'test-key-582-reopen';
  return svc;
}

function geminiResponse(items: unknown, finishReason: string | null = 'STOP') {
  const candidate: Record<string, unknown> = {
    content: { parts: [{ text: typeof items === 'string' ? items : JSON.stringify(items) }] },
  };
  if (finishReason !== null) candidate.finishReason = finishReason;
  return { ok: true, json: async () => ({ candidates: [candidate] }) } as unknown as Response;
}

const norm = (s: string) => MerchantClassifierService.normalizeKey(s);

describe('sanitizeConfidence — numeric strings (#582 reopen rev2)', () => {
  it('parses a numeric string', () => {
    expect(sanitizeConfidence('0.95')).toBe(0.95);
    expect(sanitizeConfidence('1')).toBe(1);
  });
  it('clamps a numeric string out of range', () => {
    expect(sanitizeConfidence('1.5')).toBe(1);
    expect(sanitizeConfidence('-0.2')).toBe(0);
  });
  it('non-numeric string is fail-closed to 0', () => {
    expect(sanitizeConfidence('abc')).toBe(0);
  });
  it('null / undefined still yield the sub-threshold sentinel', () => {
    expect(sanitizeConfidence(null)).toBe(UNKNOWN_CONFIDENCE);
    expect(sanitizeConfidence(undefined)).toBe(UNKNOWN_CONFIDENCE);
    expect(UNKNOWN_CONFIDENCE).toBeLessThan(AI_RULE_MIN_CONFIDENCE);
  });
});

describe('noisy-merchant fixture — false-reject guard (#582 reopen rev2)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('step 1 — fixture premise holds against the current normalizeKey', () => {
    for (const c of NOISY_MERCHANT_FIXTURE) {
      expect(norm(c.raw)).toBe(c.normalizedKey);
      expect(norm(c.resolvedMerchant) === c.normalizedKey).toBe(c.echoByNameAligns);
    }
  });

  it('step 2 — the fixture actually stresses the alignment mechanism', () => {
    expect(NOISY_MERCHANT_FIXTURE.filter((c) => !c.echoByNameAligns).length).toBeGreaterThanOrEqual(15);
  });

  it('step 3 — index-echo candidate accepts the whole chunk; every non-F1 key classified', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse(
        NOISY_MERCHANT_FIXTURE.map((c, j) => ({ i: j + 1, category: c.expectedCategory, confidence: 0.95 })),
      ),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(
      NOISY_MERCHANT_FIXTURE.map((c) => c.raw),
      'tenant-1',
    );

    expect(status).toBe('ok');
    const expectedKept = NOISY_MERCHANT_FIXTURE.filter(
      (c) => !F1_DROPPED_CATEGORIES.includes(c.expectedCategory),
    );
    expect(classifications.size).toBe(expectedKept.length);
    for (const c of expectedKept) {
      expect(classifications.get(c.normalizedKey)).toEqual({
        category: c.expectedCategory,
        source: 'ia',
        confidence: 0.95,
      });
    }
    for (const c of NOISY_MERCHANT_FIXTURE.filter((x) => F1_DROPPED_CATEGORIES.includes(x.expectedCategory))) {
      expect(classifications.has(c.normalizedKey)).toBe(false);
    }
  });

  it('step 4a — structural gate still bites: one `i` = 99 → status error, nothing persisted', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse(
        NOISY_MERCHANT_FIXTURE.map((c, j) => ({
          i: j === 10 ? 99 : j + 1,
          category: c.expectedCategory,
          confidence: 0.95,
        })),
      ),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(
      NOISY_MERCHANT_FIXTURE.map((c) => c.raw),
      'tenant-1',
    );

    expect(status).toBe('error');
    expect(classifications.size).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('step 4b — a fully-shuffled but complete `i` set is accepted and remapped', async () => {
    const shuffled = NOISY_MERCHANT_FIXTURE.map((c, j) => ({
      i: j + 1,
      category: c.expectedCategory,
      confidence: 0.95,
    })).reverse();
    global.fetch = jest.fn().mockResolvedValue(geminiResponse(shuffled)) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(
      NOISY_MERCHANT_FIXTURE.map((c) => c.raw),
      'tenant-1',
    );

    expect(status).toBe('ok');
    expect(classifications.get(norm('PAY IFD 12/03'))).toEqual({
      category: 'alimentação',
      source: 'ia',
      confidence: 0.95,
    });
    expect(classifications.get(norm('PIX QRS ENEL DISTRIB SP 03/2026'))).toEqual({
      category: 'moradia',
      source: 'ia',
      confidence: 0.95,
    });
  });

  it('step 5 — softness drops one line: element #11 off-taxonomy → #11 absent, #1/#2 classified', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse(
        NOISY_MERCHANT_FIXTURE.map((c, j) => ({
          i: j + 1,
          category: j === 10 ? 'not-a-real-category' : c.expectedCategory,
          confidence: 0.95,
        })),
      ),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(
      NOISY_MERCHANT_FIXTURE.map((c) => c.raw),
      'tenant-1',
    );

    expect(status).toBe('error');
    expect(classifications.has(norm('SPOTIFY P3A4B5C6'))).toBe(false);
    expect(classifications.get(norm('PAY IFD 12/03'))).toEqual({
      category: 'alimentação',
      source: 'ia',
      confidence: 0.95,
    });
    expect(classifications.get(norm('PIX QRS ENEL DISTRIB SP 03/2026'))).toEqual({
      category: 'moradia',
      source: 'ia',
      confidence: 0.95,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('multi-chunk — a poisoned chunk must not abort the rest (#582 reopen rev2)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('chunk 1 valid + chunk 2 structural-fail + chunk 3 valid → chunks 1 & 3 persist, status error', async () => {
    const merchants = Array.from({ length: 121 }, (_, n) => `Comercio ${n + 1}`);
    // CHUNK = 60 → slices of 60 / 60 / 1
    const chunk1 = Array.from({ length: 60 }, (_, j) => ({ i: j + 1, category: 'transporte', confidence: 0.9 }));
    const chunk2 = Array.from({ length: 60 }, (_, j) =>
      j === 30 ? { category: 'transporte', confidence: 0.9 } : { i: j + 1, category: 'transporte', confidence: 0.9 },
    );
    const chunk3 = [{ i: 1, category: 'transporte', confidence: 0.9 }];
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(geminiResponse(chunk1))
      .mockResolvedValueOnce(geminiResponse(chunk2))
      .mockResolvedValueOnce(geminiResponse(chunk3)) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(merchants, 'tenant-1');

    expect(status).toBe('error');
    expect(classifications.get(norm('Comercio 1'))).toEqual({ category: 'transporte', source: 'ia', confidence: 0.9 });
    expect(classifications.get(norm('Comercio 121'))).toEqual({ category: 'transporte', source: 'ia', confidence: 0.9 });
    expect(classifications.has(norm('Comercio 61'))).toBe(false);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('a NETWORK error on chunk 2 DOES abort: chunk 3 never runs', async () => {
    const merchants = Array.from({ length: 121 }, (_, n) => `Loja ${n + 1}`);
    const chunk1 = Array.from({ length: 60 }, (_, j) => ({ i: j + 1, category: 'transporte', confidence: 0.9 }));
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(geminiResponse(chunk1))
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'upstream down' } as unknown as Response)
      .mockResolvedValueOnce(geminiResponse([{ i: 1, category: 'transporte', confidence: 0.9 }])) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(merchants, 'tenant-1');

    expect(status).toBe('error');
    expect(classifications.get(norm('Loja 1'))).toEqual({ category: 'transporte', source: 'ia', confidence: 0.9 });
    expect(classifications.has(norm('Loja 121'))).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2); // aborted before chunk 3
  });

  it.todo('tune the acceptable structural-reject rate with ai-quality on a larger sampled corpus');
});
