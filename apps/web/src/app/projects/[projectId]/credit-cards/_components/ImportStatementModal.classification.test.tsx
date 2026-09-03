import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ImportStatementModal from './ImportStatementModal';
import type { CardRow } from '../_types';

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

function previewWith(status: 'ok' | 'unavailable' | 'error') {
  return {
    source: 'CSV_NUBANK',
    periodLabel: '2026-07',
    preview: [
      {
        externalId: 't-ia',
        date: '2026-07-01',
        merchant: 'SPOTIFY',
        amountCents: 2190,
        category: null,
        installmentCurrent: null,
        installmentTotal: null,
        duplicate: false,
        suggestedCategory: 'ASSINATURAS',
        categoriaFonte: 'ia',
      },
      {
        externalId: 't-regra',
        date: '2026-07-02',
        merchant: 'TED CONTA',
        amountCents: 50000,
        category: null,
        installmentCurrent: null,
        installmentTotal: null,
        duplicate: false,
        suggestedCategory: 'TRANSFERENCIA_TED',
        categoriaFonte: 'regra',
      },
      {
        externalId: 't-regex',
        date: '2026-07-03',
        merchant: 'POSTO SHELL',
        amountCents: 15000,
        category: null,
        installmentCurrent: null,
        installmentTotal: null,
        duplicate: false,
        suggestedCategory: 'TRANSPORTE',
        categoriaFonte: 'regex',
      },
      {
        externalId: 't-nada',
        date: '2026-07-04',
        merchant: 'DESCONHECIDO',
        amountCents: 800,
        category: null,
        installmentCurrent: null,
        installmentTotal: null,
        duplicate: false,
        suggestedCategory: 'OUTROS',
        categoriaFonte: null,
      },
    ],
    futureInstallments: [],
    total: 4,
    duplicated: 0,
    totalAmountCents: 67990,
    classificationStatus: status,
  };
}

const COMMIT = {
  source: 'CSV_NUBANK',
  periodLabel: '2026-07',
  inserted: 4,
  duplicated: 0,
  settled: 0,
  importId: 'imp-1',
};

async function loadPreview(status: 'ok' | 'unavailable' | 'error') {
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
    target: { files: [new File(['x'], 'fatura.csv', { type: 'text/plain' })] },
  });
  apiUploadMock.mockResolvedValueOnce(previewWith(status));
  fireEvent.click(screen.getByRole('button', { name: /pré-visualizar/i }));
  await screen.findByText(/transações/i);
}

describe('ImportStatementModal (fatura) — aviso de classificação + chip de origem', () => {
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

  it('chip por linha: IA / Regra / Sugestão automática, nada quando null', async () => {
    await loadPreview('ok');
    expect(screen.getByText('IA')).toBeInTheDocument();
    expect(screen.getByText('Regra')).toBeInTheDocument();
    expect(screen.getByText('Sugestão automática')).toBeInTheDocument();
    // 4ª linha (categoriaFonte null) não adiciona um segundo chip de cada tipo
    expect(screen.getAllByText('IA')).toHaveLength(1);
  });

  it('TRANSFERENCIA_TED (fora da lista fixa) fica visível e selecionado no <select>', async () => {
    await loadPreview('ok');
    const select = screen.getByDisplayValue('Transferência (TED)') as HTMLSelectElement;
    expect(select.value).toBe('TRANSFERENCIA_TED');
  });

  it('usuário troca a categoria: chip some e o override vai no commit', async () => {
    await loadPreview('error');

    const row = screen.getByDisplayValue('Assinaturas').closest('div.border-b') as HTMLElement;
    expect(within(row).getByText('IA')).toBeInTheDocument();

    fireEvent.change(within(row).getByDisplayValue('Assinaturas'), {
      target: { value: 'LAZER' },
    });
    expect(within(row).queryByText('IA')).not.toBeInTheDocument();

    apiUploadMock.mockResolvedValueOnce(COMMIT);
    fireEvent.click(screen.getByRole('button', { name: /confirmar importação/i }));
    await screen.findByText('Importação concluída');

    const fd = apiUploadMock.mock.calls[1][1] as FormData;
    const decisions = JSON.parse(fd.get('decisions') as string) as Array<{
      externalId: string;
      overrides?: { category?: string };
    }>;
    expect(decisions.find((d) => d.externalId === 't-ia')?.overrides?.category).toBe('LAZER');
  });

  it('painel de resultado reporta rulesLearned / skippedNoMapping / learnFailed', async () => {
    await loadPreview('ok');
    apiUploadMock.mockResolvedValueOnce({
      ...COMMIT,
      rulesLearned: 2,
      rulesSkippedNoMapping: 1,
      rulesLearnFailed: 3,
    });
    fireEvent.click(screen.getByRole('button', { name: /confirmar importação/i }));
    await screen.findByText('Importação concluída');
    expect(screen.getByText(/viraram regra para o futuro/i)).toBeInTheDocument();
    expect(screen.getByText(/não tem categoria equivalente/i)).toBeInTheDocument();
    expect(screen.getByText(/não foi possível salvar/i)).toBeInTheDocument();
  });
});
