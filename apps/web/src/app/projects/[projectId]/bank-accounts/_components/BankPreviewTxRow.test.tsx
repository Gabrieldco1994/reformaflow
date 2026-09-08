import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BankPreviewTxRow } from './BankPreviewTxRow';
import type { BankPreviewTx, PossibleDuplicateInfo } from '../_types';

const POSSIBLE_DUP: PossibleDuplicateInfo = {
  externalId: 't1',
  existingId: 'rec-9',
  existingOrigin: 'none',
  existingDate: '2026-07-01',
  existingAmountCents: 5000,
  reason: 'same_natural_key_different_source',
};

function baseTx(over: Partial<BankPreviewTx> = {}): BankPreviewTx {
  return {
    externalId: 't1',
    date: '2026-07-01',
    merchant: 'LOJA',
    amountCents: 5000,
    category: null,
    duplicate: false,
    ...over,
  };
}

function renderRow(tx: BankPreviewTx, state = {}) {
  return render(
    <BankPreviewTxRow
      tx={tx}
      state={state}
      onChange={vi.fn()}
      onClearDecision={vi.fn()}
    />,
  );
}

describe('BankPreviewTxRow — categoria + chip de origem', () => {
  it('sugestão fora da lista fixa (TRANSFERENCIA_TED) fica visível e selecionada', () => {
    renderRow(baseTx({ suggestedCategory: 'TRANSFERENCIA_TED', categoriaFonte: 'regra' }));
    const select = screen.getByDisplayValue('Transferência (TED)') as HTMLSelectElement;
    expect(select.value).toBe('TRANSFERENCIA_TED');
  });

  it('crédito com sentinela RECEITA não deixa o <select> em branco', () => {
    renderRow(baseTx({ amountCents: -3000, suggestedCategory: 'RECEITA' }));
    const select = screen.getByDisplayValue('Receita') as HTMLSelectElement;
    expect(select.value).toBe('RECEITA');
  });

  it('categoriaFonte "ia" → chip "IA"; "regex" → "Sugestão automática"', () => {
    const { unmount } = renderRow(baseTx({ suggestedCategory: 'ALIMENTACAO', categoriaFonte: 'ia' }));
    expect(screen.getByText('IA')).toBeInTheDocument();
    unmount();
    renderRow(baseTx({ suggestedCategory: 'ALIMENTACAO', categoriaFonte: 'regex' }));
    expect(screen.getByText('Sugestão automática')).toBeInTheDocument();
  });

  it('categoriaFonte null → sem chip', () => {
    renderRow(baseTx({ suggestedCategory: 'OUTROS', categoriaFonte: null }));
    expect(screen.queryByText(/^(IA|Regra|Sugestão automática)$/)).not.toBeInTheDocument();
  });

  it('categoria já editada pelo usuário → chip some', () => {
    renderRow(
      baseTx({ suggestedCategory: 'ALIMENTACAO', categoriaFonte: 'ia' }),
      { decision: { externalId: 't1', overrides: { category: 'TRANSPORTE' } } },
    );
    expect(screen.queryByText('IA')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Transporte')).toBeInTheDocument();
  });
});

describe('BankPreviewTxRow — Tier B possível duplicata (#659)', () => {
  it('mostra o aviso e o opt-in DESMARCADO por padrão', () => {
    renderRow(baseTx({ possibleDuplicate: POSSIBLE_DUP }));
    expect(screen.getByText('⚠ Possível duplicata')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /importar mesmo assim/i }),
    ).not.toBeChecked();
  });

  it('marcar o opt-in emite decision.action="import"', async () => {
    const onChange = vi.fn();
    render(
      <BankPreviewTxRow
        tx={baseTx({ possibleDuplicate: POSSIBLE_DUP })}
        state={{}}
        onChange={onChange}
        onClearDecision={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: /importar mesmo assim/i }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({ externalId: 't1', action: 'import' }),
      }),
    );
  });

  it('desmarcar o opt-in chama onClearDecision', async () => {
    const onClearDecision = vi.fn();
    render(
      <BankPreviewTxRow
        tx={baseTx({ possibleDuplicate: POSSIBLE_DUP })}
        state={{ decision: { externalId: 't1', action: 'import' } }}
        onChange={vi.fn()}
        onClearDecision={onClearDecision}
      />,
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: /importar mesmo assim/i }),
    );
    expect(onClearDecision).toHaveBeenCalledTimes(1);
  });
});
