import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ImportWithoutAccountModal from './ImportWithoutAccountModal';

const apiUploadMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { upload: (...args: unknown[]) => apiUploadMock(...args) },
}));

function previewWith(status: 'ok' | 'unavailable' | 'error') {
  return {
    source: 'OFX',
    periodLabel: '2026-07',
    total: 3,
    totalAmountCents: 95200,
    duplicated: 0,
    classificationStatus: status,
    preview: [
      {
        externalId: 't-ia',
        date: '2026-07-01',
        description: 'IFOOD',
        amountCents: 4200,
        type: 'expense',
        status: 'PAGO',
        duplicate: false,
        willImport: true,
        categoriaFonte: 'ia',
        suggestedCategory: 'ALIMENTACAO',
      },
      {
        externalId: 't-nada',
        date: '2026-07-03',
        description: 'LOJA XYZ',
        amountCents: 1000,
        type: 'expense',
        status: 'PAGO',
        duplicate: false,
        willImport: true,
        categoriaFonte: null,
        suggestedCategory: 'OUTROS',
      },
      {
        externalId: 't-credito',
        date: '2026-07-05',
        description: 'Salário',
        amountCents: -90000,
        type: 'receipt',
        status: 'EM_CAIXA',
        duplicate: false,
        willImport: true,
        categoriaFonte: null,
        suggestedCategory: null,
      },
    ],
  };
}

const COMMIT = {
  source: 'OFX',
  periodLabel: '2026-07',
  count: 3,
  expensesInserted: 2,
  receiptsInserted: 1,
  duplicated: 0,
  skipped: 0,
  failed: 0,
  rulesLearned: 0,
  rulesSkippedNoMapping: 0,
  rulesLearnFailed: 0,
};

function renderModal() {
  render(
    <ImportWithoutAccountModal
      projectId="p1"
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
  fireEvent.click(screen.getByRole('button', { name: /conferir arquivos/i }));
  await screen.findByText(/conferência:/i);
}

describe('ImportWithoutAccountModal — categorização automática (#659)', () => {
  beforeEach(() => {
    apiUploadMock.mockReset();
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('classificationStatus "unavailable" → banner de revisão', async () => {
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
    expect(
      screen.queryByText(/categorização automática/i),
    ).not.toBeInTheDocument();
  });

  it('chip por linha de despesa: IA, e nada quando categoriaFonte é null', async () => {
    await loadPreview('unavailable');
    expect(screen.getByText('IA')).toBeInTheDocument();
    expect(screen.queryByText('Sugestão automática')).not.toBeInTheDocument();
  });

  it('recebimento (crédito) não mostra <select> nem chip de categoria', async () => {
    await loadPreview('ok');
    const creditRow = screen.getByText('Salário').closest('li') as HTMLElement;
    expect(within(creditRow).queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('troca de categoria: chip some e o override vai no commit', async () => {
    await loadPreview('unavailable');
    const iaRow = screen.getByText('IFOOD').closest('li') as HTMLElement;
    expect(within(iaRow).getByText('IA')).toBeInTheDocument();

    fireEvent.change(within(iaRow).getByRole('combobox'), {
      target: { value: 'TRANSPORTE' },
    });
    expect(within(iaRow).queryByText('IA')).not.toBeInTheDocument();

    apiUploadMock.mockResolvedValueOnce(COMMIT);
    fireEvent.click(
      screen.getByRole('button', { name: /confirmar importação/i }),
    );
    await screen.findByText('Importação concluída!');

    const fd = apiUploadMock.mock.calls[1][1] as FormData;
    const decisions = JSON.parse(fd.get('decisions') as string) as Array<{
      externalId: string;
      overrides?: { category?: string };
    }>;
    expect(decisions).toEqual([
      { externalId: 't-ia', overrides: { category: 'TRANSPORTE' } },
    ]);
  });

  it('sem troca de categoria: commit não envia campo decisions', async () => {
    await loadPreview('ok');
    apiUploadMock.mockResolvedValueOnce(COMMIT);
    fireEvent.click(
      screen.getByRole('button', { name: /confirmar importação/i }),
    );
    await screen.findByText('Importação concluída!');
    const fd = apiUploadMock.mock.calls[1][1] as FormData;
    expect(fd.get('decisions')).toBeNull();
  });

  it('painel de resultado reporta rulesLearned / skippedNoMapping / learnFailed', async () => {
    await loadPreview('ok');
    apiUploadMock.mockResolvedValueOnce({
      ...COMMIT,
      rulesLearned: 2,
      rulesSkippedNoMapping: 1,
      rulesLearnFailed: 3,
    });
    fireEvent.click(
      screen.getByRole('button', { name: /confirmar importação/i }),
    );
    await screen.findByText('Importação concluída!');
    expect(screen.getByText(/viraram regra para o futuro/i)).toBeInTheDocument();
    expect(
      screen.getByText(/não tem categoria equivalente/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/não foi possível salvar/i)).toBeInTheDocument();
  });
});

function previewWithGapRows() {
  return {
    source: 'OFX',
    periodLabel: '2026-07',
    total: 4,
    totalAmountCents: 0,
    duplicated: 1,
    classificationStatus: 'ok',
    preview: [
      {
        externalId: 'g-normal',
        date: '2026-07-01',
        description: 'MERCADO',
        amountCents: 5000,
        type: 'expense',
        status: 'PAGO',
        duplicate: false,
        willImport: true,
        categoriaFonte: 'ia',
        suggestedCategory: 'ALIMENTACAO',
      },
      {
        externalId: 'g-invoice',
        date: '2026-07-02',
        description: 'PAGAMENTO FATURA CARTAO',
        amountCents: 30000,
        type: 'expense',
        status: 'PAGO',
        duplicate: false,
        willImport: false,
        categoriaFonte: null,
        suggestedCategory: 'OUTROS',
      },
      {
        externalId: 'g-dup',
        date: '2026-07-03',
        description: 'ASSINATURA',
        amountCents: 1990,
        type: 'expense',
        status: 'PAGO',
        duplicate: true,
        willImport: true,
        categoriaFonte: null,
        suggestedCategory: 'OUTROS',
      },
      {
        externalId: 'g-ted',
        date: '2026-07-04',
        description: 'TED ENVIADA',
        amountCents: 12000,
        type: 'expense',
        status: 'PAGO',
        duplicate: false,
        willImport: true,
        categoriaFonte: 'ia',
        suggestedCategory: 'TRANSFERENCIA_TED',
      },
    ],
  };
}

async function loadGapPreview() {
  renderModal();
  apiUploadMock.mockResolvedValueOnce(previewWithGapRows());
  fireEvent.click(screen.getByRole('button', { name: /conferir arquivos/i }));
  await screen.findByText(/conferência:/i);
}

describe('ImportWithoutAccountModal — lacunas de QA (#659)', () => {
  beforeEach(() => {
    apiUploadMock.mockReset();
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('Gap 2: <select> de categoria da linha tem alvo de toque min-h-11', async () => {
    await loadGapPreview();
    const row = screen.getByText('MERCADO').closest('li') as HTMLElement;
    expect(within(row).getByRole('combobox')).toHaveClass('min-h-11');
  });

  it('Gap 3: linha de pagamento de fatura (ignorada) não mostra <select> nem chip', async () => {
    await loadGapPreview();
    const row = screen
      .getByText('PAGAMENTO FATURA CARTAO')
      .closest('li') as HTMLElement;
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(row).queryByText('IA')).not.toBeInTheDocument();
    expect(within(row).queryByText('Sugestão automática')).not.toBeInTheDocument();
  });

  it('Gap 3: linha duplicada não mostra <select>', async () => {
    await loadGapPreview();
    const row = screen.getByText('ASSINATURA').closest('li') as HTMLElement;
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('Gap 3: linha de despesa normal mantém <select> e chip', async () => {
    await loadGapPreview();
    const row = screen.getByText('MERCADO').closest('li') as HTMLElement;
    expect(within(row).getByRole('combobox')).toBeInTheDocument();
    expect(within(row).getByText('IA')).toBeInTheDocument();
  });

  it('suggestedCategory TRANSFERENCIA_TED em linha não-ignorada continua visível e selecionada', async () => {
    await loadGapPreview();
    const row = screen.getByText('TED ENVIADA').closest('li') as HTMLElement;
    const select = within(row).getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('TRANSFERENCIA_TED');
    expect(
      select.querySelector('option[value="TRANSFERENCIA_TED"]'),
    ).not.toBeNull();
  });
});
