import { describe, expect, it } from 'vitest';
import { dedupeByLast4 } from './SaldosWidget';

describe('dedupeByLast4', () => {
  it('remove contas duplicadas com o mesmo last4', () => {
    const rows = dedupeByLast4([
      { id: '1', institution: 'Itau', last4: '3636' },
      { id: '2', institution: 'NUBANK', last4: '3636' },
      { id: '3', institution: 'Inter', last4: '7777' },
    ]);
    expect(rows.map((row) => row.last4)).toEqual(['3636', '7777']);
  });
});
