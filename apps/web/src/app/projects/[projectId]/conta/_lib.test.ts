import { describe, expect, it } from 'vitest';
import { groupByMovementDay } from './_lib';

describe('groupByMovementDay', () => {
  it('keeps the input order and groups movements with the same UTC date', () => {
    const groups = groupByMovementDay([
      { id: 'a', data: '2026-07-17T00:00:00.000Z' },
      { id: 'b', data: '2026-07-17T18:00:00.000Z' },
      { id: 'c', data: '2026-07-16T00:00:00.000Z' },
    ]);

    expect(groups).toEqual([
      expect.objectContaining({ day: '2026-07-17', movements: [{ id: 'a', data: '2026-07-17T00:00:00.000Z' }, { id: 'b', data: '2026-07-17T18:00:00.000Z' }] }),
      expect.objectContaining({ day: '2026-07-16', movements: [{ id: 'c', data: '2026-07-16T00:00:00.000Z' }] }),
    ]);
    expect(groups[0]?.label).toContain('17');
  });
});
