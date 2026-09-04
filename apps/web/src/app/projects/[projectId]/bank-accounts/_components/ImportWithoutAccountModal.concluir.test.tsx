import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ImportWithoutAccountModal from './ImportWithoutAccountModal';

/**
 * #659 §8 — RED spec (design phase, OPEN QUESTION for the orchestrator).
 * "Success state stays visible until the user hits 'Concluir'" requires a
 * small, additive change to the modal's success branch (a "Concluir" button
 * + drop the 1.5s auto-timer at commit success, Journey-QA Gap 4 from #668).
 * If the PO decides against touching this file, DROP this spec and its
 * production line item — the reachability specs above stand on their own.
 */

vi.mock('@/lib/api', () => ({
  api: {
    upload: vi.fn(),
  },
}));

import { api } from '@/lib/api';

function file() {
  return new File(['a,b\n1,2'], 'extrato.csv', { type: 'text/csv' });
}

beforeEach(() => {
  vi.useFakeTimers();
  (api.upload as ReturnType<typeof vi.fn>).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

async function chegarNoSucesso(onCommitted: () => void) {
  (api.upload as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({
      total: 1,
      totalAmountCents: 1000,
      duplicated: 0,
      rows: [
        { externalId: 'e1', date: '2026-09-01', description: 'Mercado', amountCents: 1000, type: 'DESPESA', status: 'PAGO' },
      ],
    })
    .mockResolvedValueOnce({ inserted: 1, failed: 0 });

  render(<ImportWithoutAccountModal projectId="p1" onClose={vi.fn()} onCommitted={onCommitted} />);

  const input = screen.getByLabelText('Arquivos') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file()] } });
  fireEvent.click(screen.getByRole('button', { name: 'Conferir arquivos' }));
  await screen.findByText(/Conferência:/);
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar importação' }));
  await waitFor(() => expect(screen.getByText('Importação concluída!')).toBeInTheDocument());
}

describe('#659 ImportWithoutAccountModal — sucesso persiste até "Concluir" (RED)', () => {
  it('mostra um botão "Concluir" na tela de sucesso', async () => {
    await chegarNoSucesso(vi.fn());
    expect(screen.getByRole('button', { name: 'Concluir' })).toBeInTheDocument();
  });

  it('NÃO chama onCommitted pela passagem do tempo — só ao clicar em "Concluir"', async () => {
    const onCommitted = vi.fn();
    await chegarNoSucesso(onCommitted);

    vi.advanceTimersByTime(5000);
    expect(onCommitted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Concluir' }));
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });
});
