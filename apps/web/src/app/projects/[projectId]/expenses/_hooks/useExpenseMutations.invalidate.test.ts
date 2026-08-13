import { describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { invalidateExpenseQueries } from './useExpenseMutations';

describe('invalidateExpenseQueries', () => {
  it('invalida detalhes de rateio por prefixo junto com as queries financeiras', () => {
    const invalidateQueries = vi.fn();
    const queryClient = { invalidateQueries } as Pick<QueryClient, 'invalidateQueries'> as QueryClient;

    invalidateExpenseQueries(queryClient, 'proj-1');

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['rateio-detalhe'],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['pendencias-financeiras', 'proj-1'],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['pendencias', 'proj-1'],
    });
  });
});
