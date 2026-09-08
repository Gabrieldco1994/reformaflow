import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImportBankStatementModal from './ImportBankStatementModal';
import type { BankAccountRow } from '../_types';

/**
 * #659 — revisão de possíveis duplicatas (Tier B) na importação de extrato.
 * Contrato do servidor: `possibleDuplicate` por linha, `willImport:false`, e só
 * cria a linha com `decisions[].action:'import'`.
 */

const apiUploadMock = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { upload: (...args: unknown[]) => apiUploadMock(...args) },
}));

const ACCOUNT: BankAccountRow = {
  id: 'acc-a',
  institution: 'ITAU',
  nickname: 'Conta A',
  last4: '1111',
  agency: null,
  accountNumber: null,
};

const DUP_INFO = {
  externalId: 't-dup',
  existingId: 'exp-1',
  existingOrigin: 'card:4242',
  existingDate: '2026-07-02',
  existingAmountCents: 5000,
  reason: 'same_natural_key_different_source',
};

const PREVIEW = {
  source: 'OFX',
  periodLabel: '2026-07',
  total: 2,
  duplicated: 0,
  totalAmountCents: 12000,
  totalDebits: 2,
  totalCredits: 0,
  preview: [
    {
      externalId: 't-nova',
      date: '2026-07-01',
      merchant: 'PADARIA',
      amountCents: 7000,
      category: null,
      duplicate: false,
      willImport: true,
    },
    {
      externalId: 't-dup',
      date: '2026-07-02',
      merchant: 'MERCADO',
      amountCents: 5000,
      category: null,
      duplicate: false,
      willImport: false,
      possibleDuplicate: DUP_INFO,
      // ainda que tenha um match único e exato, NÃO deve auto-vincular:
      crossProjectMatches: [
        {
          kind: 'expense',
          expenseId: 'plan-9',
          projectId: 'p2',
          projectName: 'Reforma',
          projectType: 'REFORMA',
          titulo: 'Material',
          valorCents: 5000,
          data: '2026-07-02',
          deltaCents: 0,
        },
      ],
    },
  ],
  possibleDuplicates: [DUP_INFO],
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

async function toPreview() {
  render(
    <ImportBankStatementModal
      projectId="p1"
      account={ACCOUNT}
      onClose={vi.fn()}
      onCommitted={vi.fn()}
    />,
  );
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(['x'], 'extrato.ofx', { type: 'text/plain' })] },
  });
  apiUploadMock.mockResolvedValueOnce(PREVIEW);
  fireEvent.click(screen.getByRole('button', { name: /pré-visualizar/i }));
  await screen.findByText(/transações/i);
}

function decisionsFromLastUpload() {
  const fd = apiUploadMock.mock.calls.at(-1)![1] as FormData;
  const raw = fd.get('decisions');
  return raw ? (JSON.parse(String(raw)) as Array<Record<string, unknown>>) : [];
}

beforeEach(() => apiUploadMock.mockReset());

describe('ImportBankStatementModal — Tier B possível duplicata (#659)', () => {
  it('não auto-vincula a linha Tier B, mesmo com match único e exato', async () => {
    await toPreview();
    // "Vinculado" só aparece quando há vínculo ativo; a linha Tier B deve
    // continuar oferecendo "Vincular como pago", não estar já vinculada.
    expect(screen.queryByRole('button', { name: /^Vinculado$/ })).not.toBeInTheDocument();
    const resumo = screen.getByText(/Após confirmar:/i);
    expect(resumo).toHaveTextContent('1 novas');
    expect(resumo).toHaveTextContent('0 vinculadas');
    expect(resumo).toHaveTextContent('1 possível(is) duplicata(s)');
  });

  it('commit padrão não força a linha; após opt-in manda action:"import"', async () => {
    await toPreview();

    apiUploadMock.mockResolvedValueOnce(COMMIT);
    fireEvent.click(screen.getByRole('button', { name: /confirmar importação/i }));
    await screen.findByText('Importação concluída');
    expect(
      decisionsFromLastUpload().find((d) => d.externalId === 't-dup' && d.action === 'import'),
    ).toBeUndefined();
  });

  it('opt-in: resumo "2 novas" e FormData com a decisão', async () => {
    await toPreview();
    await userEvent.click(
      screen.getByRole('checkbox', { name: /importar mesmo assim/i }),
    );
    expect(screen.getByText(/Após confirmar:/i)).toHaveTextContent('2 novas');

    apiUploadMock.mockResolvedValueOnce(COMMIT);
    fireEvent.click(screen.getByRole('button', { name: /confirmar importação/i }));
    await screen.findByText('Importação concluída');
    expect(decisionsFromLastUpload()).toContainEqual(
      expect.objectContaining({ externalId: 't-dup', action: 'import' }),
    );
  });
});
