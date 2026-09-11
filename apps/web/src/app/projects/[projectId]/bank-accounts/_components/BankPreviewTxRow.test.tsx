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

  it('desmarcar o opt-in NÃO chama onClearDecision e preserva overrides editados', async () => {
    const onChange = vi.fn();
    const onClearDecision = vi.fn();
    render(
      <BankPreviewTxRow
        tx={baseTx({ possibleDuplicate: POSSIBLE_DUP })}
        state={{
          decision: { externalId: 't1', action: 'import', overrides: { category: 'TRANSPORTE' } },
        }}
        onChange={onChange}
        onClearDecision={onClearDecision}
      />,
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: /importar mesmo assim/i }),
    );
    expect(onClearDecision).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith({
      decision: { externalId: 't1', overrides: { category: 'TRANSPORTE' } },
    });
  });

  it('linha Tier B com match cross-project NÃO oferece vincular', () => {
    renderRow(
      baseTx({
        possibleDuplicate: POSSIBLE_DUP,
        crossProjectMatches: [
          {
            kind: 'expense',
            expenseId: 'plan-1',
            projectId: 'p2',
            projectName: 'Reforma',
            projectType: 'REFORMA',
            titulo: 'Material',
            valorCents: 5000,
            data: '2026-07-01',
            deltaCents: 0,
          },
        ],
      }),
    );
    expect(screen.queryByRole('button', { name: /vincular/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/planejada em outro/i)).not.toBeInTheDocument();
  });

  it('linha Tier B classificada como pagamento de fatura NÃO mostra o seletor de cartão', () => {
    renderRow(
      baseTx({
        possibleDuplicate: POSSIBLE_DUP,
        suggestedCategory: 'PAGAMENTO_FATURA_CARTAO',
        cardCandidates: [
          { cardLast4: '4242', nickname: 'Roxo', dueMonth: '2026-07', invoiceTotalCents: 5000, deltaCents: 0 },
        ],
      }),
    );
    expect(screen.queryByText(/qual cartão isso quita/i)).not.toBeInTheDocument();
  });
});

describe('BankPreviewTxRow — #569 PR2 janela de liquidação (windowState)', () => {
  it('candidato OUTSIDE_SETTLEMENT_WINDOW selecionado mostra aviso de confirmação manual, não promete vínculo automático', () => {
    renderRow(
      baseTx({
        suggestedCategory: 'PAGAMENTO_FATURA_CARTAO',
        cardCandidates: [
          {
            cardLast4: '4242',
            nickname: 'Roxo',
            dueMonth: '2026-05',
            invoiceTotalCents: 5000,
            deltaCents: 0,
            windowState: 'OUTSIDE_SETTLEMENT_WINDOW',
          },
        ],
      }),
      { decision: { externalId: 't1', overrides: { cardLast4: '4242' } } },
    );
    expect(
      screen.getByText(/fora do prazo de liquidação automática/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/confirme manualmente/i)).toBeInTheDocument();
  });

  it('candidato WITHIN_SETTLEMENT_WINDOW (ou sem windowState, contrato antigo) não mostra aviso', () => {
    renderRow(
      baseTx({
        suggestedCategory: 'PAGAMENTO_FATURA_CARTAO',
        cardCandidates: [
          { cardLast4: '4242', nickname: 'Roxo', dueMonth: '2026-08', invoiceTotalCents: 5000, deltaCents: 0 },
        ],
      }),
      { decision: { externalId: 't1', overrides: { cardLast4: '4242' } } },
    );
    expect(screen.queryByText(/fora do prazo de liquidação automática/i)).not.toBeInTheDocument();
  });
});
