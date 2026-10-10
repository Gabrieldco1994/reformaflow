import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: (...args: unknown[]) => get(...args), post: vi.fn() },
}));

import { getImportResult, getImportSession, ImportMalformedResponseError, listImportSessions } from './import-session-api';
import { receiptFixture, summaryFixture, viewFixture } from './import-session-fixtures';

beforeEach(() => get.mockReset());

type Mutate = (receipt: ReturnType<typeof receiptFixture>) => unknown;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const receiptBody = (mutate: Mutate) => {
  const receipt = clone(receiptFixture());
  return { state: 'APPLIED', receipt: mutate(receipt) ?? receipt };
};

describe('everything the reader consumes is validated before it reaches a component', () => {
  const badReceipts: Array<[string, Mutate]> = [
    ['snapshot.lines is not an array', (r) => void ((r.snapshot as unknown as Record<string, unknown>).lines = 'x')],
    ['a snapshot line is null', (r) => void ((r.snapshot.lines as unknown[])[0] = null)],
    ['a line without targets', (r) => void delete (r.snapshot.lines[0] as unknown as Record<string, unknown>).targets],
    ['a target that is null', (r) => void (r.snapshot.lines[0].targets as unknown[]).push(null)],
    ['a target with a string amount', (r) => void ((r.snapshot.lines[0].targets[0] as unknown as Record<string, unknown>).amountCents = '10')],
    ['a line without schedule', (r) => void delete (r.snapshot.lines[0] as unknown as Record<string, unknown>).schedule],
    ['schedule.occurrences is not an array', (r) => void ((r.snapshot.lines[0].schedule as unknown as Record<string, unknown>).occurrences = null)],
    ['an occurrence with a non-integer valor', (r) => void ((r.snapshot.lines[0].schedule.occurrences[0] as unknown as Record<string, unknown>).valor = 10.5)],
    ['an occurrence with a malformed date', (r) => void ((r.snapshot.lines[0].schedule.occurrences[0] as unknown as Record<string, unknown>).data = '14/07/2026')],
    ['invoiceDeltas missing', (r) => void delete (r.snapshot as unknown as Record<string, unknown>).invoiceDeltas],
    ['an invoice delta that is null', (r) => void (r.snapshot.invoiceDeltas as unknown[]).push(null)],
    ['createdEconomicTotalCents is not an integer', (r) => void ((r.snapshot as unknown as Record<string, unknown>).createdEconomicTotalCents = null)],
    ['an item that is null', (r) => void ((r.items as unknown[])[0] = null)],
    ['bankCashDeltaCents is +1 (the contract says the batch never moves the bank)', (r) => void ((r.snapshot as unknown as Record<string, unknown>).bankCashDeltaCents = 1)],
    ['bankCashDeltaCents is -1', (r) => void ((r.snapshot as unknown as Record<string, unknown>).bankCashDeltaCents = -1)],
    ['appliedAt missing', (r) => void delete (r as unknown as Record<string, unknown>).appliedAt],
  ];
  for (const [name, mutate] of badReceipts) {
    it(`rejects a receipt when ${name}`, async () => {
      get.mockResolvedValue(receiptBody(mutate));
      await expect(getImportResult('sess-9')).rejects.toBeInstanceOf(ImportMalformedResponseError);
    });
  }

  it('accepts bankCashDeltaCents === 0, the only value of the contract', async () => {
    get.mockResolvedValue(receiptBody(() => undefined));
    await expect(getImportResult('sess-9')).resolves.toMatchObject({ receipt: { snapshot: { bankCashDeltaCents: 0 } } });
  });

  it('still accepts the coherent receipt and a null receipt', async () => {
    get.mockResolvedValue(receiptBody(() => undefined));
    await expect(getImportResult('sess-9')).resolves.toMatchObject({ state: 'APPLIED' });
    get.mockResolvedValue({ state: 'CANCELLED', receipt: null });
    await expect(getImportResult('sess-9')).resolves.toEqual({ state: 'CANCELLED', receipt: null });
  });

  it('rejects list items and view members that are null or the wrong type', async () => {
    get.mockResolvedValue({ items: [summaryFixture(), null], nextCursor: null });
    await expect(listImportSessions('active')).rejects.toBeInstanceOf(ImportMalformedResponseError);
    get.mockResolvedValue({ items: [{ ...summaryFixture(), attachmentCount: 'many' }], nextCursor: null });
    await expect(listImportSessions('active')).rejects.toBeInstanceOf(ImportMalformedResponseError);
    get.mockResolvedValue({ ...viewFixture(), attachments: [null] });
    await expect(getImportSession('s')).rejects.toBeInstanceOf(ImportMalformedResponseError);
    get.mockResolvedValue({ ...viewFixture(), lines: [null] });
    await expect(getImportSession('s')).rejects.toBeInstanceOf(ImportMalformedResponseError);
    get.mockResolvedValue({ ...viewFixture(), questions: [42] });
    await expect(getImportSession('s')).rejects.toBeInstanceOf(ImportMalformedResponseError);
  });

  it('only the parser RangeError is an invalid shape; an unexpected failure is not swallowed', async () => {
    const domain = await import('@reformaflow/domain');
    const spy = vi.spyOn(domain, 'parseExpenseSchedule').mockImplementation(() => {
      throw new TypeError('boom');
    });
    try {
      get.mockResolvedValue(receiptBody(() => undefined));
      await expect(getImportResult('sess-9')).rejects.toBeInstanceOf(TypeError);
    } finally {
      spy.mockRestore();
    }
  });
});
