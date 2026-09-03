import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ImportBankStatementModal from './ImportBankStatementModal';
import type { BankAccountRow } from '../_types';

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

function previewWith(status: 'ok' | 'unavailable' | 'error') {
  return {
    source: 'OFX',
    periodLabel: '2026-07',
    preview: [
      {
        externalId: 't-ia',
        date: '2026-07-01',
        merchant: 'IFOOD',
        amountCents: 4200,
        category: null,
        duplicate: false,
        suggestedCategory: 'ALIMENTACAO',
        categoriaFonte: 'ia',
      },
      {
        externalId: 't-regra',
        date: '2026-07-02',
        merchant: 'TED JOAO',
        amountCents: 90000,
        category: null,
        duplicate: false,
        suggestedCategory: 'TRANSFERENCIA_TED',
        categoriaFonte: 'regra',
      },
      {
        externalId: 't-nada',
        date: '2026-07-03',
        merchant: 'LOJA XYZ',
        amountCents: 1000,
        category: null,
        duplicate: false,
        suggestedCategory: 'OUTROS',
        categoriaFonte: null,
      },
    ],
    total: 3,
    duplicated: 0,
    totalAmountCents: 95200,
    totalDebits: 3,
    totalCredits: 0,
    classificationStatus: status,
  };
}

const COMMIT = {
  importId: 'imp-1',
  source: 'OFX',
  periodLabel: '2026-07',
  inserted: 3,
  duplicated: 0,
  receiptsInserted: 0,
  cardPayments: 0,
  aiReclassified: 0,
  recurrencesCreated: 0,
  skipped: 0,
};

function renderModal() {
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
}

async function loadPreview(status: 'ok' | 'unavailable' | 'error') {
  renderModal();
  apiUploadMock.mockResolvedValueOnce(previewWith(status));
  fireEvent.click(screen.getByRole('button', { name: /pré-visualizar/i }));
  await screen.findByText(/transações/i);
}

describe('ImportBankStatementModal — aviso de classificação + chip de origem', () => {
  beforeEach(() => apiUploadMock.mockReset());

  it('classificationStatus "unavailable" → banner pedindo revisão', async () => {
    await loadPreview('unavailable');
    expect(
      screen.getByText(/categorização automática está indisponível/i),
    ).toBeInTheDocument();
  });

  it('classificationStatus "error" → banner de "não concluída"', async () => {
    await loadPreview('error');
    expect(
      screen.getByText(/categorização automática não foi concluída/i),
    ).toBeInTheDocument();
  });

  it('classificationStatus "ok" → nenhum banner', async () => {
    await loadPreview('ok');
    expect(screen.queryByText(/categorização automática/i)).not.toBeInTheDocument();
  });

  it('chip por linha: IA / Regra, e nada quando categoriaFonte é null', async () => {
    await loadPreview('unavailable');
    expect(screen.getByText('IA')).toBeInTheDocument();
    expect(screen.getByText('Regra')).toBeInTheDocument();
    expect(screen.queryByText('Sugestão automática')).not.toBeInTheDocument();
  });

  it('TRANSFERENCIA_TED (fora da lista fixa) fica visível e selecionado no <select>', async () => {
    await loadPreview('ok');
    const select = screen.getByDisplayValue('Transferência (TED)') as HTMLSelectElement;
    expect(select.value).toBe('TRANSFERENCIA_TED');
  });

  it('usuário troca a categoria: chip some e o override vai no commit', async () => {
    await loadPreview('unavailable');

    const iaRow = screen.getByDisplayValue('Alimentação').closest('div.border-b') as HTMLElement;
    expect(within(iaRow).getByText('IA')).toBeInTheDocument();

    fireEvent.change(within(iaRow).getByDisplayValue('Alimentação'), {
      target: { value: 'TRANSPORTE' },
    });
    expect(within(iaRow).queryByText('IA')).not.toBeInTheDocument();

    apiUploadMock.mockResolvedValueOnce(COMMIT);
    fireEvent.click(screen.getByRole('button', { name: /confirmar importação/i }));
    await screen.findByText('Importação concluída');

    const fd = apiUploadMock.mock.calls[1][1] as FormData;
    const decisions = JSON.parse(fd.get('decisions') as string) as Array<{
      externalId: string;
      overrides?: { category?: string };
    }>;
    const changed = decisions.find((d) => d.externalId === 't-ia');
    expect(changed?.overrides?.category).toBe('TRANSPORTE');
  });
});
