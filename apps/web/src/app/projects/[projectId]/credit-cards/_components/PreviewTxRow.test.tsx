import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreviewTxRow } from './PreviewTxRow';
import type { PreviewTx, PossibleDuplicateInfo } from '../_types';

const POSSIBLE_DUP: PossibleDuplicateInfo = {
  externalId: 't1',
  existingId: 'exp-9',
  existingOrigin: 'bank:1111',
  existingDate: '2026-07-01',
  existingAmountCents: 5000,
  reason: 'same_natural_key_different_source',
};

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

describe('PreviewTxRow (fatura) — Tier B possível duplicata (#659)', () => {
  it('mostra o aviso e o opt-in DESMARCADO por padrão', () => {
    renderRow(baseTx({ possibleDuplicate: POSSIBLE_DUP }));
    expect(screen.getByText('⚠ Possível duplicata')).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', { name: /importar mesmo assim/i });
    expect(checkbox).not.toBeChecked();
  });

  it('marcar o opt-in emite decision.action="import"', async () => {
    const onChange = vi.fn();
    render(
      <PreviewTxRow
        tx={baseTx({ possibleDuplicate: POSSIBLE_DUP })}
        state={{}}
        onChange={onChange}
        onClearDecision={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /importar mesmo assim/i }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({ externalId: 't1', action: 'import' }),
      }),
    );
  });

  it('desmarcar o opt-in chama onClearDecision (volta ao estado seguro)', async () => {
    const onClearDecision = vi.fn();
    render(
      <PreviewTxRow
        tx={baseTx({ possibleDuplicate: POSSIBLE_DUP })}
        state={{ decision: { externalId: 't1', action: 'import' } }}
        onChange={vi.fn()}
        onClearDecision={onClearDecision}
      />,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /importar mesmo assim/i }));
    expect(onClearDecision).toHaveBeenCalledTimes(1);
  });

  it('quando a linha está vinculada a planejado, o opt-in fica desabilitado', () => {
    renderRow(
      baseTx({
        possibleDuplicate: POSSIBLE_DUP,
        crossProjectMatches: [
          {
            expenseId: 'plan-1',
            projectId: 'p2',
            projectName: 'Reforma',
            projectType: 'REFORMA',
            titulo: 'Piso',
            valorCents: 5000,
            data: '2026-07-01',
            deltaCents: 0,
            installmentCurrent: null,
            installmentTotal: null,
          },
        ],
      }),
      { decision: { externalId: 't1', action: 'link', linkToExpenseId: 'plan-1' } },
    );
    expect(screen.getByRole('checkbox', { name: /importar mesmo assim/i })).toBeDisabled();
  });
});
