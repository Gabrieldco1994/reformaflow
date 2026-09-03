import { Test, TestingModule } from '@nestjs/testing';
import { MerchantClassifierService } from './merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * RED — issue #582 REOPENED, defect #4: `callGemini` zips the provider response by
 * ARRAY POSITION with no per-element schema check, no echo-back merchant check, and
 * never inspects `candidates[0].finishReason`.
 *
 * Target (INV-3 / INV-4): a chunk's response is applied (Map + DB) only if it is
 * WHOLLY trustworthy — same length, every element schema-valid, every element's
 * echoed `merchant` aligned by normalized key to the sent merchant at that index,
 * and `finishReason === 'STOP'`. Otherwise: `status: 'error'` and PERSIST NOTHING
 * for that chunk (no correct rows, no incorrect rows).
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

function geminiResponse(items: unknown, ...finishReasonArg: [] | [string | undefined]) {
  // Sem 2º argumento → default 'STOP'. Com 2º argumento explícito `undefined` →
  // `finishReason` OMITIDO do candidate (era mascarado pelo default de parâmetro,
  // que transforma `f(x, undefined)` no default — o caso "missing finishReason"
  // ficava impossível de exercer).
  const finishReason = finishReasonArg.length === 0 ? 'STOP' : finishReasonArg[0];
  const candidate: Record<string, unknown> = {
    content: { parts: [{ text: typeof items === 'string' ? items : JSON.stringify(items) }] },
  };
  if (finishReason !== undefined) candidate.finishReason = finishReason;
  return { ok: true, json: async () => ({ candidates: [candidate] }) } as unknown as Response;
}

function expectNothingPersisted(prisma: ReturnType<typeof buildPrismaMock>) {
  expect(prisma.merchantCategory.createMany).not.toHaveBeenCalled();
  expect(prisma.merchantCategory.update).not.toHaveBeenCalled();
}

describe('classifyForImport — Gemini response must be trustworthy or the chunk is dropped (#582 reopen)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('DEFECT #4 reorder: same items in shuffled order → status error, no row written to the wrong merchant', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse([
        { merchant: 'Beta Shop', category: 'saúde', subcategory: 'farmacia', confidence: 0.95 },
        { merchant: 'Alpha Store', category: 'transporte', subcategory: 'app', confidence: 0.95 },
      ]),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(
      ['Alpha Store', 'Beta Shop'],
      'tenant-1',
    );

    expect(status).toBe('error');
    // today the code zips by position: 'alpha store' would be persisted as 'saúde'
    // and 'beta shop' as 'transporte' — both WRONG — and status would be 'ok'.
    expect(classifications.has('alpha store')).toBe(false);
    expect(classifications.has('beta shop')).toBe(false);
    expectNothingPersisted(prisma);
    // whole chunk rejected before any write is attempted
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('DEFECT #4 short response: 4 items for 5 pending → status error, zero AI rows for the chunk', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse([
        { merchant: 'Um', category: 'transporte', confidence: 0.9 },
        { merchant: 'Dois', category: 'transporte', confidence: 0.9 },
        { merchant: 'Tres', category: 'transporte', confidence: 0.9 },
        { merchant: 'Quatro', category: 'transporte', confidence: 0.9 },
      ]),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(
      ['Um', 'Dois', 'Tres', 'Quatro', 'Cinco'],
      'tenant-1',
    );

    expect(status).toBe('error');
    for (const k of ['um', 'dois', 'tres', 'quatro', 'cinco']) {
      expect(classifications.has(k)).toBe(false);
    }
    expectNothingPersisted(prisma);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('DEFECT #4 schema garbage: element missing `category` → status error, nothing persisted', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse([
        { merchant: 'Alpha Store', category: 'transporte', confidence: 0.9 },
        { foo: 1 },
      ]),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(
      ['Alpha Store', 'Beta Shop'],
      'tenant-1',
    );

    expect(status).toBe('error');
    expect(classifications.has('alpha store')).toBe(false);
    expect(classifications.has('beta shop')).toBe(false);
    expectNothingPersisted(prisma);
  });

  it('DEFECT #4 off-taxonomy category is a schema violation (not silently coerced to "outros")', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse([
        { merchant: 'Alpha Store', category: 'transporte', confidence: 0.9 },
        { merchant: 'Beta Shop', category: 'not-a-real-category', confidence: 0.9 },
      ]),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(
      ['Alpha Store', 'Beta Shop'],
      'tenant-1',
    );

    expect(status).toBe('error');
    expect(classifications.has('alpha store')).toBe(false);
    expect(classifications.has('beta shop')).toBe(false);
    expectNothingPersisted(prisma);
  });

  it('DEFECT #4 finishReason MAX_TOKENS with parseable, aligned JSON → untrustworthy, status error, nothing persisted', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse(
        [
          { merchant: 'Alpha Store', category: 'transporte', confidence: 0.95 },
          { merchant: 'Beta Shop', category: 'saúde', confidence: 0.95 },
        ],
        'MAX_TOKENS',
      ),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(
      ['Alpha Store', 'Beta Shop'],
      'tenant-1',
    );

    expect(status).toBe('error');
    expect(classifications.has('alpha store')).toBe(false);
    expect(classifications.has('beta shop')).toBe(false);
    expectNothingPersisted(prisma);
  });

  it('DEFECT #4 missing finishReason is treated as untrustworthy', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse(
        [
          { merchant: 'Alpha Store', category: 'transporte', confidence: 0.95 },
          { merchant: 'Beta Shop', category: 'saúde', confidence: 0.95 },
        ],
        undefined,
      ),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { status } = await svc.classifyForImport(['Alpha Store', 'Beta Shop'], 'tenant-1');

    expect(status).toBe('error');
    expectNothingPersisted(prisma);
  });

  it('regression: a clean, in-order, finishReason:STOP response persists AI rows and returns status ok', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse(
        [
          { merchant: 'Alpha Store', category: 'transporte', subcategory: 'app', confidence: 0.95 },
          { merchant: 'Beta Shop', category: 'saúde', subcategory: 'farmacia', confidence: 0.91 },
        ],
        'STOP',
      ),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(
      ['Alpha Store', 'Beta Shop'],
      'tenant-1',
    );

    expect(status).toBe('ok');
    expect(classifications.get('alpha store')).toEqual({
      category: 'transporte',
      source: 'ia',
      confidence: 0.95,
    });
    expect(classifications.get('beta shop')).toEqual({
      category: 'saúde',
      source: 'ia',
      confidence: 0.91,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.merchantCategory.createMany).toHaveBeenCalledTimes(1);
    const created = prisma.merchantCategory.createMany.mock.calls[0][0].data as Array<{
      merchantKey: string;
      category: string;
      source: string;
    }>;
    expect(created).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ merchantKey: 'alpha store', category: 'transporte', source: 'AI' }),
        expect.objectContaining({ merchantKey: 'beta shop', category: 'saúde', source: 'AI' }),
      ]),
    );
  });
});
