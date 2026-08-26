import { describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { invalidateExpenseQueries, invalidateImportQueries } from './useExpenseMutations';

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

// Regressão #572: invalidação pós-importação (extrato/fatura) estava
// incompleta — cobria só o conjunto canônico de despesa, sem recebimentos,
// cartões/contas do projeto e a família `['tenant', ...]` usada pelos
// seletores de origem/pagamento (WizardStepPagamento, QuickExpenseStep,
// NovaDespesaLauncher, RecorrenteWizard, VinculosFields, OriginChips,
// QuitarParcelaModal, PendenciasQueueCard, MobileLaunchSheetContainer).
describe('invalidateImportQueries', () => {
  it('invalida o conjunto canônico de despesa MAIS recebimentos, cartões/contas (projeto e tenant)', () => {
    const invalidateQueries = vi.fn();
    const queryClient = { invalidateQueries } as Pick<QueryClient, 'invalidateQueries'> as QueryClient;

    invalidateImportQueries(queryClient, 'proj-1');

    // Conjunto canônico de despesa continua coberto (via invalidateExpenseQueries).
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['expenses', 'proj-1'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['account-view', 'proj-1'] });

    // Famílias específicas de importação, escopo do projeto.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['receipts', 'proj-1'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['credit-cards', 'proj-1'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['bank-accounts', 'proj-1'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['project', 'proj-1', 'credit-cards'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['project', 'proj-1', 'bank-accounts'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['origin-items-yearly', 'proj-1'] });

    // Família tenant-wide (seletores de cartão/conta fora da tela de origem).
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['tenant', 'credit-cards'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['tenant', 'bank-accounts'] });
  });
});
