import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImportStatementModal from './ImportStatementModal';
import type { CardRow } from '../_types';

/**
 * #659 — revisão de possíveis duplicatas (Tier B) na importação de fatura.
 * O servidor já retorna `possibleDuplicate` por linha e só cria a linha se o
 * commit mandar `decisions[].action:'import'`. Aqui garantimos que:
 *  - contadores NÃO contam a linha Tier B como "nova" por padrão;
 *  - o commit padrão NÃO manda `action:'import'` para ela;
 *  - depois do opt-in explícito, conta como nova e o FormData carrega a decisão.
 */

const apiUploadMock = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { upload: (...args: unknown[]) => apiUploadMock(...args) },
}));

const CARD: CardRow = {
  id: 'card-a',
  institution: 'NUBANK',
  brand: 'MASTERCARD',
  nickname: 'Roxinho',
  last4: '4242',
  limitTotalCents: null,
  limitAvailableCents: null,
  closingDay: 10,
  dueDay: 17,
};

const PREVIEW = {
  source: 'CSV_NUBANK',
  periodLabel: '2026-07',
  total: 2,
  duplicated: 0,
  totalAmountCents: 12000,
  preview: [
    {
      externalId: 't-nova',
      date: '2026-07-01',
      merchant: 'PADARIA',
      amountCents: 7000,
      category: null,
      installmentCurrent: null,
      installmentTotal: null,
      duplicate: false,
      willImport: true,
    },
    {
      externalId: 't-dup',
      date: '2026-07-02',
      merchant: 'MERCADO',
      amountCents: 5000,
      category: null,
      installmentCurrent: null,
      installmentTotal: null,
      duplicate: false,
      willImport: false,
      possibleDuplicate: {
        externalId: 't-dup',
        existingId: 'exp-1',
        existingOrigin: 'bank:1111',
        existingDate: '2026-07-02',
        existingAmountCents: 5000,
        reason: 'same_natural_key_different_source',
      },
    },
  ],
  possibleDuplicates: [
    {
      externalId: 't-dup',
      existingId: 'exp-1',
      existingOrigin: 'bank:1111',
      existingDate: '2026-07-02',
      existingAmountCents: 5000,
      reason: 'same_natural_key_different_source',
    },
  ],
};

const COMMIT = {
  source: 'CSV_NUBANK',
  periodLabel: '2026-07',
  inserted: 1,
  duplicated: 0,
  settled: 0,
  importId: 'imp-1',
};

async function toPreview() {
  render(
    <ImportStatementModal
      projectId="p1"
      card={CARD}
      onClose={vi.fn()}
      onCommitted={vi.fn()}
    />,
  );
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(['x'], 'fatura.csv', { type: 'text/csv' })] },
  });
  apiUploadMock.mockResolvedValueOnce(PREVIEW);
  fireEvent.click(screen.getByRole('button', { name: /pré-visualizar/i }));
  await screen.findByText(/transações/i);
}

/** Lê o array `decisions` do FormData da última chamada de commit. */
function decisionsFromLastUpload() {
  const fd = apiUploadMock.mock.calls.at(-1)![1] as FormData;
  const raw = fd.get('decisions');
  return raw ? (JSON.parse(String(raw)) as Array<Record<string, unknown>>) : [];
}

beforeEach(() => apiUploadMock.mockReset());

describe('ImportStatementModal — Tier B possível duplicata (#659)', () => {
  it('por padrão: resumo mostra "1 novas" e "1 possível duplicata"; commit não força a linha', async () => {
    await toPreview();

    const resumo = screen.getByText(/Após confirmar:/i);
    expect(resumo).toHaveTextContent('1 novas');
    expect(resumo).toHaveTextContent('1 possível(is) duplicata(s)');

    apiUploadMock.mockResolvedValueOnce(COMMIT);
    fireEvent.click(screen.getByRole('button', { name: /confirmar importação/i }));
    await screen.findByText('Importação concluída');

    const decisions = decisionsFromLastUpload();
    expect(decisions.find((d) => d.externalId === 't-dup' && d.action === 'import')).toBeUndefined();
  });

  it('após "Importar mesmo assim": resumo mostra "2 novas" e o commit manda action:"import"', async () => {
    await toPreview();

    await userEvent.click(
      screen.getByRole('checkbox', { name: /importar mesmo assim/i }),
    );

    const resumo = screen.getByText(/Após confirmar:/i);
    expect(resumo).toHaveTextContent('2 novas');

    apiUploadMock.mockResolvedValueOnce(COMMIT);
    fireEvent.click(screen.getByRole('button', { name: /confirmar importação/i }));
    await screen.findByText('Importação concluída');

    const decisions = decisionsFromLastUpload();
    expect(decisions).toContainEqual(
      expect.objectContaining({ externalId: 't-dup', action: 'import' }),
    );
  });
});
