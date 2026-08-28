import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ImportBankStatementModal from './ImportBankStatementModal';
import type { BankAccountRow } from '../_types';

const apiUploadMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    upload: (...args: unknown[]) => apiUploadMock(...args),
  },
}));

const ACCOUNT: BankAccountRow = {
  id: 'acc-a',
  institution: 'ITAU',
  nickname: 'Conta A',
  last4: '1111',
  agency: null,
  accountNumber: null,
};

const PREVIEW = {
  source: 'OFX',
  periodLabel: '2026-07',
  preview: [
    {
      externalId: 't1',
      date: '2026-07-01',
      merchant: 'Padaria',
      amountCents: -1000,
      category: null,
      duplicate: false,
    },
  ],
  total: 1,
  duplicated: 0,
  totalAmountCents: 1000,
  totalDebits: 1,
  totalCredits: 0,
};

const COMMIT = {
  importId: 'imp-1',
  source: 'OFX',
  periodLabel: '2026-07',
  inserted: 1,
  duplicated: 0,
  receiptsInserted: 0,
  cardPayments: 0,
  aiReclassified: 0,
  recurrencesCreated: 0,
  skipped: 0,
};

async function importUntilCommitted() {
  const onClose = vi.fn();
  const onCommitted = vi.fn();
  render(
    <ImportBankStatementModal
      projectId="p1"
      account={ACCOUNT}
      onClose={onClose}
      onCommitted={onCommitted}
    />,
  );

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['dummy'], 'extrato.ofx', { type: 'text/plain' });
  fireEvent.change(input, { target: { files: [file] } });

  apiUploadMock.mockResolvedValueOnce(PREVIEW);
  fireEvent.click(screen.getByRole('button', { name: /pré-visualizar/i }));
  await screen.findByText(/transações/i);

  apiUploadMock.mockResolvedValueOnce(COMMIT);
  fireEvent.click(screen.getByRole('button', { name: /confirmar importação/i }));
  await screen.findByText('Importação concluída');

  return { onClose, onCommitted };
}

describe('ImportBankStatementModal — fechamento pós-importação', () => {
  beforeEach(() => {
    apiUploadMock.mockReset();
  });

  it('mostra ações distintas "Fechar" (X) e "Concluir" após importar', async () => {
    await importUntilCommitted();

    const fechar = screen.getByRole('button', { name: 'Fechar' });
    const concluir = screen.getByRole('button', { name: 'Concluir' });
    expect(fechar).not.toBe(concluir);
    expect(screen.queryAllByRole('button', { name: 'Fechar' })).toHaveLength(1);
  });

  it('tanto o X quanto "Concluir" chamam onCommitted, nunca só onClose', async () => {
    const { onClose, onCommitted } = await importUntilCommitted();

    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onCommitted).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Concluir' }));
    expect(onCommitted).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });
});
