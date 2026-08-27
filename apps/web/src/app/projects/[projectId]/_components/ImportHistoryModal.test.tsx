import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ImportHistoryModal from './ImportHistoryModal';

const apiGet = vi.fn();
const apiDelete = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
  ApiResponseError: class extends Error {},
}));

const BASE = '/projects/p1/credit-cards/c1';

const IMPORTS = [
  {
    id: 'imp1',
    periodLabel: '2026-06',
    fileName: 'fatura.csv',
    source: 'CSV_NUBANK',
    inserted: 3,
    duplicated: 0,
    totalAmountCents: 30000,
    createdAt: '2026-06-01T12:00:00.000Z',
    deletedAt: null,
  },
];

const DETAIL = {
  importId: 'imp1',
  periodLabel: '2026-06',
  fileName: 'fatura.csv',
  createdAt: '2026-06-01T12:00:00.000Z',
  alreadyUndone: false,
  totalAmountCents: 30000,
  impact: {
    expenses: 3,
    cashFlowEntries: 3,
    crossProjectLinks: 1,
    adoptedExpenses: 0,
  },
};

describe('ImportHistoryModal', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiDelete.mockReset();
  });

  it('lista importações, mostra impacto e desfaz com confirmação', async () => {
    apiGet.mockResolvedValueOnce(IMPORTS); // GET /imports
    apiGet.mockResolvedValueOnce(DETAIL); // GET /imports/imp1
    apiDelete.mockResolvedValueOnce({ ok: true });
    apiGet.mockResolvedValueOnce([]); // reload após desfazer

    render(<ImportHistoryModal basePath={BASE} title="Importações" onClose={() => {}} />);

    // Passo 1: histórico
    expect(await screen.findByText(/2026-06 · fatura\.csv/)).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith(`${BASE}/imports`);

    // abre o preview de impacto
    fireEvent.click(screen.getByRole('button', { name: /desfazer/i }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(`${BASE}/imports/imp1`));

    // Passo 2: impacto listado
    expect(await screen.findByText('Despesas removidas')).toBeInTheDocument();
    expect(screen.getByText('Vínculos entre projetos desfeitos')).toBeInTheDocument();

    // confirma o desfazer
    fireEvent.click(screen.getByRole('button', { name: /desfazer importação/i }));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith(`${BASE}/imports/imp1`));
  });

  it('#569: canUndo=false bloqueia o desfazer, mostra o motivo e não promete reabrir fatura', async () => {
    apiGet.mockResolvedValueOnce(IMPORTS);
    apiGet.mockResolvedValueOnce({
      ...DETAIL,
      canUndo: false,
      blocking: { changedInvoiceLiquidations: 1, invoiceLiquidationsWithOtherPayments: 0 },
    });

    render(<ImportHistoryModal basePath={BASE} title="Importações" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /desfazer/i }));

    expect(await screen.findByText(/Não é possível desfazer agora/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /desfazer importação/i }),
    ).not.toBeInTheDocument();
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it('mostra aviso de efeitos irreversíveis quando houver', async () => {
    apiGet.mockResolvedValueOnce(IMPORTS);
    apiGet.mockResolvedValueOnce({
      ...DETAIL,
      impact: { ...DETAIL.impact, receipts: 0, invoiceLiquidations: 0 },
      irreversible: { recurrencesPropagated: 2, notRevertibleInvoiceLiquidations: 0 },
    });

    render(<ImportHistoryModal basePath={BASE} title="Importações" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: /desfazer/i }));

    expect(await screen.findByText(/NÃO serão revertidos/i)).toBeInTheDocument();
    expect(screen.getByText(/2 recorrência\(s\) propagada\(s\)/)).toBeInTheDocument();
  });
});
