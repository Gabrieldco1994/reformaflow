import { Test, TestingModule } from '@nestjs/testing';
import { MerchantClassifierService } from './merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * RED — issue #582 REOPENED, revision 2 (PO review): the Gemini-response trust
 * model is INDEX-BASED (1-based `i`) with a SPLIT GATE, replacing echo-by-name.
 *
 *   STRUCTURAL failure  -> reject the whole chunk, persist nothing ($transaction
 *                          never opens), status 'error', subsequent chunks still run.
 *     - finishReason !== 'STOP' (exact; 'stop', 'MAX_TOKENS', undefined all reject)
 *     - parsed not an array
 *     - the multiset of `i` is not exactly {1..N}: missing / duplicate / out-of-range
 *       `i`, non-integer `i`, or length != N
 *   ELEMENT softness    -> drop only that line, keep the rest aligned by `i`; batch
 *                          marked incomplete (status 'error'), surviving lines persist.
 *     - element not an object / no usable `category`
 *     - `category` still off-taxonomy AFTER normalization (trim + casefold + NFD)
 *   NOT a failure at all:
 *     - `category` with casing/accents/whitespace -> normalized, matched, canonicalized
 *     - `confidence` as a numeric string "0.95" -> sanitizeConfidence parses it
 *     - response reordered but with a complete, correct `i` set -> accepted, remapped
 *
 * `callGemini` no longer requests / requires a `merchant` field. Alignment to the
 * sent merchant is `slice[i - 1]`.
 *
 * These assertions FAIL against 8603bde0 (echo-by-name model: every element needs a
 * `merchant` string, any off-taxonomy element rejects the whole chunk, no `i`).
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

function createdRows(prisma: ReturnType<typeof buildPrismaMock>) {
  return prisma.merchantCategory.createMany.mock.calls.flatMap(
    (c) => (c[0] as { data: Array<{ merchantKey: string; category: string; confidence: number }> }).data,
  );
}

describe('classifyForImport — index-based Gemini trust, split gate (#582 reopen rev2)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('accepts an in-order indexed response with NO merchant field; persists the right keys', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse([
        { i: 1, category: 'transporte', subcategory: 'app', confidence: 0.95 },
        { i: 2, category: 'saúde', subcategory: 'farmacia', confidence: 0.9 },
      ]),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(['Alpha Store', 'Beta Shop'], 'tenant-1');

    expect(status).toBe('ok');
    expect(classifications.get('alpha store')).toEqual({ category: 'transporte', source: 'ia', confidence: 0.95 });
    expect(classifications.get('beta shop')).toEqual({ category: 'saúde', source: 'ia', confidence: 0.9 });
    expect(createdRows(prisma)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ merchantKey: 'alpha store', category: 'transporte' }),
        expect.objectContaining({ merchantKey: 'beta shop', category: 'saúde' }),
      ]),
    );
  });

  it('reorder WITH a complete correct `i` set is accepted and remapped by `i` (not by position)', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse([
        { i: 2, category: 'saúde', confidence: 0.9 },
        { i: 1, category: 'transporte', confidence: 0.95 },
      ]),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(['Alpha Store', 'Beta Shop'], 'tenant-1');

    expect(status).toBe('ok');
    expect(classifications.get('alpha store')).toEqual({ category: 'transporte', source: 'ia', confidence: 0.95 });
    expect(classifications.get('beta shop')).toEqual({ category: 'saúde', source: 'ia', confidence: 0.9 });
  });

  describe('structural gate — reject the whole chunk, persist nothing', () => {
    const cases: Array<[string, unknown, string | null]> = [
      ['missing `i` on one element', [{ i: 1, category: 'transporte', confidence: 0.9 }, { category: 'saúde', confidence: 0.9 }], 'STOP'],
      ['duplicate `i`', [{ i: 1, category: 'transporte', confidence: 0.9 }, { i: 1, category: 'saúde', confidence: 0.9 }], 'STOP'],
      ['`i` out of range', [{ i: 1, category: 'transporte', confidence: 0.9 }, { i: 5, category: 'saúde', confidence: 0.9 }], 'STOP'],
      ['non-integer `i`', [{ i: 1, category: 'transporte', confidence: 0.9 }, { i: 1.5, category: 'saúde', confidence: 0.9 }], 'STOP'],
      ['length != N (short)', [{ i: 1, category: 'transporte', confidence: 0.9 }], 'STOP'],
      ['length != N (long)', [{ i: 1, category: 'transporte', confidence: 0.9 }, { i: 2, category: 'saúde', confidence: 0.9 }, { i: 3, category: 'lazer', confidence: 0.9 }], 'STOP'],
      ['finishReason MAX_TOKENS', [{ i: 1, category: 'transporte', confidence: 0.9 }, { i: 2, category: 'saúde', confidence: 0.9 }], 'MAX_TOKENS'],
      ['finishReason wrong casing "stop"', [{ i: 1, category: 'transporte', confidence: 0.9 }, { i: 2, category: 'saúde', confidence: 0.9 }], 'stop'],
      ['finishReason missing', [{ i: 1, category: 'transporte', confidence: 0.9 }, { i: 2, category: 'saúde', confidence: 0.9 }], null],
      ['parsed not an array', '{}', 'STOP'],
    ];
    for (const [name, items, finishReason] of cases) {
      it(name, async () => {
        global.fetch = jest.fn().mockResolvedValue(geminiResponse(items, finishReason)) as typeof fetch;
        const prisma = buildPrismaMock([]);
        const svc = await buildService(prisma);

        const { classifications, status } = await svc.classifyForImport(['Alpha Store', 'Beta Shop'], 'tenant-1');

        expect(status).toBe('error');
        expect(classifications.has('alpha store')).toBe(false);
        expect(classifications.has('beta shop')).toBe(false);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.merchantCategory.createMany).not.toHaveBeenCalled();
      });
    }
  });

  it('element softness: an off-taxonomy category (even after normalization) drops ONLY that line', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse([
        { i: 1, category: 'transporte', confidence: 0.9 },
        { i: 2, category: 'crypto-bananas', confidence: 0.9 },
      ]),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(['Alpha Store', 'Beta Shop'], 'tenant-1');

    // dropped line -> batch incomplete -> status error, but line 1 survives and persists
    expect(status).toBe('error');
    expect(classifications.get('alpha store')).toEqual({ category: 'transporte', source: 'ia', confidence: 0.9 });
    expect(classifications.has('beta shop')).toBe(false);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(createdRows(prisma)).toEqual([expect.objectContaining({ merchantKey: 'alpha store', category: 'transporte' })]);
  });

  it('element softness: a malformed element (no category) drops only that line', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse([
        { i: 1, category: 'transporte', confidence: 0.9 },
        { i: 2, foo: 1 },
      ]),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(['Alpha Store', 'Beta Shop'], 'tenant-1');

    expect(status).toBe('error');
    expect(classifications.get('alpha store')).toEqual({ category: 'transporte', source: 'ia', confidence: 0.9 });
    expect(classifications.has('beta shop')).toBe(false);
  });

  it('G3: category with casing / accent / trailing space is normalized and canonicalized, not dropped', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse([
        { i: 1, category: 'Transporte', confidence: 0.9 },
        { i: 2, category: 'Saúde ', confidence: 0.9 },
      ]),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(['Alpha Store', 'Beta Shop'], 'tenant-1');

    expect(status).toBe('ok');
    expect(classifications.get('alpha store')).toEqual({ category: 'transporte', source: 'ia', confidence: 0.9 });
    expect(classifications.get('beta shop')).toEqual({ category: 'saúde', source: 'ia', confidence: 0.9 });
  });

  it('G2: confidence as a numeric string "0.95" is sanitized, the line survives with the parsed value', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      geminiResponse([
        { i: 1, category: 'transporte', confidence: '0.95' },
        { i: 2, category: 'saúde', confidence: 0.9 },
      ]),
    ) as typeof fetch;
    const prisma = buildPrismaMock([]);
    const svc = await buildService(prisma);

    const { classifications, status } = await svc.classifyForImport(['Alpha Store', 'Beta Shop'], 'tenant-1');

    expect(status).toBe('ok');
    expect(classifications.get('alpha store')).toEqual({ category: 'transporte', source: 'ia', confidence: 0.95 });
    expect(classifications.get('beta shop')).toEqual({ category: 'saúde', source: 'ia', confidence: 0.9 });
  });
});
