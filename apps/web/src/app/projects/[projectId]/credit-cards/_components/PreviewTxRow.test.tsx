import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreviewTxRow } from './PreviewTxRow';
import type { PreviewTx } from '../_types';

function baseTx(over: Partial<PreviewTx> = {}): PreviewTx {
  return {
    externalId: 't1',
    date: '2026-07-01',
    merchant: 'LOJA',
    amountCents: 5000,
    category: null,
    installmentCurrent: null,
    installmentTotal: null,
    duplicate: false,
    ...over,
  };
}

function renderRow(tx: PreviewTx, state = {}) {
  return render(
    <PreviewTxRow tx={tx} state={state} onChange={vi.fn()} onClearDecision={vi.fn()} />,
  );
}

describe('PreviewTxRow (fatura) — categoria + chip de origem', () => {
  it('sugestão fora da lista fixa (TRANSFERENCIA_TED) fica visível e selecionada', () => {
    renderRow(baseTx({ suggestedCategory: 'TRANSFERENCIA_TED', categoriaFonte: 'regra' }));
    const select = screen.getByDisplayValue('Transferência (TED)') as HTMLSelectElement;
    expect(select.value).toBe('TRANSFERENCIA_TED');
  });

  it('categoriaFonte "ia" → chip "IA"; "regra" → "Regra"', () => {
    const { unmount } = renderRow(baseTx({ suggestedCategory: 'ASSINATURAS', categoriaFonte: 'ia' }));
    expect(screen.getByText('IA')).toBeInTheDocument();
    unmount();
    renderRow(baseTx({ suggestedCategory: 'ASSINATURAS', categoriaFonte: 'regra' }));
    expect(screen.getByText('Regra')).toBeInTheDocument();
  });

  it('categoriaFonte null → sem chip', () => {
    renderRow(baseTx({ suggestedCategory: 'OUTROS', categoriaFonte: null }));
    expect(screen.queryByText(/^(IA|Regra|Sugestão automática)$/)).not.toBeInTheDocument();
  });

  it('categoria já editada pelo usuário → chip some', () => {
    renderRow(
      baseTx({ suggestedCategory: 'ASSINATURAS', categoriaFonte: 'ia' }),
      { decision: { externalId: 't1', overrides: { category: 'LAZER' } } },
    );
    expect(screen.queryByText('IA')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Lazer')).toBeInTheDocument();
  });
});
