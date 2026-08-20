import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MovimentacaoRow } from './MovimentacaoRow';
import type { AccountViewEntrada, AccountViewSaida } from '../_types';

function makeEntrada(overrides: Partial<AccountViewEntrada> = {}): AccountViewEntrada {
  return {
    id: 'rec-1',
    kind: 'entrada',
    descricao: 'Salário',
    data: '2026-06-15T00:00:00.000Z',
    tipo: 'salario',
    valor: 500_000,
    bankLast4: '1234',
    status: 'PREVISTO',
    ...overrides,
  };
}

function makeSaida(overrides: Partial<AccountViewSaida> = {}): AccountViewSaida {
  return {
    id: 'exp-1',
    kind: 'saida',
    descricao: 'Compra mercado',
    data: '2026-06-15T00:00:00.000Z',
    forma: 'pix',
    valor: 250_000,
    realizado: false,
    status: 'PLANEJADO',
    cardLast4: null,
    bankLast4: '1234',
    tipoDespesa: 'MERCADO',
    isInvoice: false,
    editavel: true,
    dueMonth: null,
    projetoOrigem: null,
    ...overrides,
  };
}

function renderRow(
  overrides: Partial<React.ComponentProps<typeof MovimentacaoRow>> = {},
) {
  const props: React.ComponentProps<typeof MovimentacaoRow> = {
    item: makeEntrada(),
    originLabel: () => null,
    onEditExpense: vi.fn(),
    onEditReceita: vi.fn(),
    onToggleExpense: vi.fn(),
    onToggleReceita: vi.fn(),
    onPayInvoice: vi.fn(),
    onAdjustInvoice: vi.fn(),
    onSettleWithResidual: vi.fn(),
    onQuitar: vi.fn(),
    onRemoveExpense: vi.fn(),
    onRemoveReceita: vi.fn(),
    ...overrides,
  };
  render(<MovimentacaoRow {...props} />);
  return props;
}

describe('MovimentacaoRow — entrada', () => {
  it('mostra badge "Previsto" e ao clicar marca como EM_CAIXA', () => {
    const props = renderRow({ item: makeEntrada({ status: 'PREVISTO' }) });

    const badge = screen.getByRole('button', { name: /previsto/i });
    expect(badge).toBeInTheDocument();

    fireEvent.click(badge);
    expect(props.onToggleReceita).toHaveBeenCalledWith('rec-1', 'EM_CAIXA');
  });

  it('mostra badge "Recebido" para EM_CAIXA e ao clicar volta para PREVISTO', () => {
    const props = renderRow({ item: makeEntrada({ status: 'EM_CAIXA' }) });

    const badge = screen.getByRole('button', { name: /recebido/i });
    expect(badge).toBeInTheDocument();

    fireEvent.click(badge);
    expect(props.onToggleReceita).toHaveBeenCalledWith('rec-1', 'PREVISTO');
  });
});

describe('MovimentacaoRow — saída', () => {
  it('mostra status "A pagar" quando a saída ainda não foi realizada e alterna para pago', () => {
    const props = renderRow({ item: makeSaida({ realizado: false }) });
    const status = screen.getByRole('button', { name: /a pagar/i });
    expect(status).toBeInTheDocument();

    fireEvent.click(status);
    expect(props.onToggleExpense).toHaveBeenCalledWith('exp-1', false);
  });

  it('mostra status "Paga" quando a saída já foi realizada e alterna para planejado', () => {
    const props = renderRow({ item: makeSaida({ realizado: true, status: 'PAGO' }) });
    const status = screen.getByRole('button', { name: /paga/i });
    expect(status).toBeInTheDocument();

    fireEvent.click(status);
    expect(props.onToggleExpense).toHaveBeenCalledWith('exp-1', true);
  });

  it('exibe chip de projeto quando a despesa vem de projeto não pessoal', () => {
    renderRow({
      item: makeSaida({
        projetoOrigem: { id: 'proj-casa', name: 'Casa Praia', type: 'CASA' },
      }),
    });
    expect(screen.getByText('Casa Praia')).toBeInTheDocument();
  });

  describe('F1: Carteira (Sem conta) chip', () => {
    it('mostra chip "Sem conta" quando origem.tipo === "carteira"', () => {
      const onVincular = vi.fn();
      renderRow({
        item: makeSaida({
          forma: 'pix',
          cardLast4: null,
          bankLast4: null,
        }),
        originLabel: () => 'Sem conta',
        onVincular,
      });

      const semContaChip = screen.getByText('Sem conta');
      expect(semContaChip).toBeInTheDocument();
      expect(semContaChip).toHaveClass('rounded-full');
    });

    it('chip "Sem conta" é clicável e abre modal de vínculo', () => {
      const onVincular = vi.fn();
      const onQuitar = vi.fn();
      const item = makeSaida({
        forma: 'pix',
        cardLast4: null,
        bankLast4: null,
        id: 'exp-carteira-1',
      });
      renderRow({
        item,
        originLabel: () => 'Sem conta',
        onVincular,
        onQuitar,
      });

      const semContaChip = screen.getByText('Sem conta');
      fireEvent.click(semContaChip.closest('button, a, [role="button"]') || semContaChip);
      
      // Verificar que o callback de vinculação foi chamado
      expect(onVincular).toHaveBeenCalledWith(item);
      expect(onQuitar).not.toHaveBeenCalled();
    });

    it('parcela foreign pendente: sem chip "Sem conta" redundante, quitação pelo controle "Quitar"', () => {
      const onVincular = vi.fn();
      const onQuitar = vi.fn();
      renderRow({
        item: makeSaida({
          id: 'exp-foreign-1',
          forma: 'pix',
          cardLast4: null,
          bankLast4: null,
          realizado: false,
          foreignExpenseId: 'exp-destino-99',
          parcelaIndex: 3,
          valor: 12345,
          data: '2026-07-22',
          descricao: 'Parcela obra',
        }),
        originLabel: () => 'Sem conta',
        onVincular,
        onQuitar,
      });

      // O chip "Sem conta" é omitido quando já há o controle "Quitar" (evita
      // duplicar o mesmo fluxo de quitação e libera a linha no mobile).
      expect(screen.queryByText('Sem conta')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTitle('Quitar parcela pela conta pessoal'));

      expect(onQuitar).toHaveBeenCalledWith({
        foreignExpenseId: 'exp-destino-99',
        parcelaIndex: 3,
        valorSugerido: 12345,
        descricao: 'Parcela obra',
        dataSugerida: '2026-07-22',
      });
      expect(onVincular).not.toHaveBeenCalled();
    });

    it('exibe "Sem conta" chip mesmo quando há projeto vinculado (cross-project)', () => {
      renderRow({
        item: makeSaida({
          forma: 'pix',
          cardLast4: null,
          bankLast4: null,
          projetoOrigem: { id: 'proj-2', name: 'Projeto B', type: 'OBRA' },
        }),
        originLabel: () => 'Sem conta',
      });

      // Ambos devem estar presentes: chip "Sem conta" e chip do projeto
      expect(screen.getByText('Sem conta')).toBeInTheDocument();
      expect(screen.getByText('Projeto B')).toBeInTheDocument();
    });

    it('exibe "Sem conta" com item de alto valor (7 dígitos) sem quebra de layout', () => {
      renderRow({
        item: makeSaida({
          forma: 'pix',
          cardLast4: null,
          bankLast4: null,
          valor: 9_999_999, // R$ 99.999,99
        }),
        originLabel: () => 'Sem conta',
      });

      const semContaChip = screen.getByText('Sem conta');
      expect(semContaChip).toBeInTheDocument();
      
      // Verificar que o chip está visível (não escondido ou quebrado)
      expect(semContaChip.closest('.rounded-full, [class*="chip"], [class*="badge"]')).toBeVisible();
    });

    it('chip "Sem conta" não aparece quando há conta vinculada (origem != carteira)', () => {
      renderRow({
        item: makeSaida({
          forma: 'pix',
          bankLast4: '5678',
        }),
        originLabel: () => 'Conta 5678',
      });

      // "Sem conta" NÃO deve estar presente quando há conta
      expect(screen.queryByText('Sem conta')).not.toBeInTheDocument();
      // origin label is embedded inside the meta string — use partial match
      expect(screen.getByText(/Conta 5678/)).toBeInTheDocument();
    });

    it('chip "Sem conta" sem descrição (falha graceful)', () => {
      renderRow({
        item: makeSaida({
          forma: 'pix',
          cardLast4: null,
          bankLast4: null,
          descricao: '',
        }),
        originLabel: () => 'Sem conta',
      });

      const semContaChip = screen.getByText('Sem conta');
      expect(semContaChip).toBeInTheDocument();
    });

    it('texto do chip "Sem conta" é exatamente "Sem conta" (mutation: não é "Sem vinculação")', () => {
      renderRow({
        item: makeSaida({
          forma: 'pix',
          cardLast4: null,
          bankLast4: null,
        }),
        originLabel: () => 'Sem conta',
      });

      expect(screen.getByText('Sem conta')).toBeInTheDocument();
      expect(screen.queryByText('Sem vinculação')).not.toBeInTheDocument();
      expect(screen.queryByText('Carteira')).not.toBeInTheDocument();
      expect(screen.queryByText('N/A')).not.toBeInTheDocument();
    });

    it('chip "Sem conta" reutiliza o mesmo flow de LinkExpense (onVincular callback)', () => {
      const onVincular = vi.fn();
      const item = makeSaida({
        forma: 'pix',
        cardLast4: null,
        bankLast4: null,
        id: 'exp-sem-conta-123',
      });
      renderRow({
        item,
        originLabel: () => 'Sem conta',
        onVincular,
      });

      // Clicar no chip de "Sem conta" deve chamar onVincular com o item
      const chipButton = screen.getByText('Sem conta').closest('button');
      if (chipButton) fireEvent.click(chipButton);

      expect(onVincular).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'exp-sem-conta-123',
          forma: 'pix',
        })
      );
    });

    it('item sem categoria exibe chip de sugestão e confirma com um toque', () => {
      const onConfirmSuggestion = vi.fn();
      renderRow({
        item: makeSaida({
          tipoDespesa: 'OUTROS',
          suggestionTipoDespesa: 'ALIMENTACAO',
        }),
        onConfirmSuggestion,
      });

      const chip = screen.getByRole('button', { name: /Alimentação\?/i });
      fireEvent.click(chip);
      expect(onConfirmSuggestion).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'exp-1', tipoDespesa: 'OUTROS' }),
        'ALIMENTACAO',
      );
    });
  });

  describe('cross-project: editar/excluir despesa "sem conta" de outro projeto', () => {
    it('linha foreign carteira (editavel=true) mostra ações de editar e excluir', () => {
      renderRow({
        item: makeSaida({
          id: 'exp-casa-1',
          foreignExpenseId: 'exp-casa-1',
          projetoOrigem: { id: 'proj-casa', name: 'Casa Praia', type: 'CASA' },
          realizado: true,
          status: 'PAGO',
          cardLast4: null,
          bankLast4: null,
          editavel: true,
        }),
      });

      expect(screen.getByRole('button', { name: 'Editar' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Excluir' })).toBeInTheDocument();
    });

    it('editar chama onEditExpense com o item completo (a resolução do id real fica na section)', () => {
      const onEditExpense = vi.fn();
      const item = makeSaida({
        id: 'exp-casa-1',
        foreignExpenseId: 'exp-casa-1',
        projetoOrigem: { id: 'proj-casa', name: 'Casa Praia', type: 'CASA' },
        realizado: true,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: null,
        editavel: true,
      });
      renderRow({ item, onEditExpense });

      fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
      expect(onEditExpense).toHaveBeenCalledWith(item);
    });

    it('excluir resolve o id REAL da despesa (foreignExpenseId) + o projectId dono, não o id composto', () => {
      const onRemoveExpense = vi.fn();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      renderRow({
        item: makeSaida({
          // id composto de linha por-parcela: NÃO é o id real da despesa.
          id: 'exp-casa-1#2',
          foreignExpenseId: 'exp-casa-1',
          parcelaIndex: 2,
          projetoOrigem: { id: 'proj-casa', name: 'Casa Praia', type: 'CASA' },
          realizado: true,
          status: 'PAGO',
          cardLast4: null,
          bankLast4: null,
          editavel: true,
        }),
        onRemoveExpense,
      });

      fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
      expect(onRemoveExpense).toHaveBeenCalledWith('exp-casa-1', 'proj-casa');
      confirmSpy.mockRestore();
    });

    it('toggle rápido de status fica bloqueado (inerte) para linha foreign, mesmo editável', () => {
      const onToggleExpense = vi.fn();
      renderRow({
        item: makeSaida({
          id: 'exp-casa-1',
          foreignExpenseId: 'exp-casa-1',
          projetoOrigem: { id: 'proj-casa', name: 'Casa Praia', type: 'CASA' },
          realizado: true,
          status: 'PAGO',
          cardLast4: null,
          bankLast4: null,
          editavel: true,
        }),
        onToggleExpense,
      });

      const status = screen.getByRole('button', { name: /paga/i });
      expect(status).toBeDisabled();
      fireEvent.click(status);
      expect(onToggleExpense).not.toHaveBeenCalled();
    });

    it('item PESSOAL "solto" (não foreign) mantém o toggle rápido funcionando normalmente', () => {
      const onToggleExpense = vi.fn();
      renderRow({
        item: makeSaida({
          id: 'exp-1',
          foreignExpenseId: null,
          projetoOrigem: null,
          realizado: false,
          status: 'PLANEJADO',
          editavel: true,
        }),
        onToggleExpense,
      });

      const status = screen.getByRole('button', { name: /a pagar/i });
      expect(status).not.toBeDisabled();
      fireEvent.click(status);
      expect(onToggleExpense).toHaveBeenCalledWith('exp-1', false);
    });

    it('excluir despesa PESSOAL "solta" não passa projectId (undefined) — a section usa o projeto atual', () => {
      const onRemoveExpense = vi.fn();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      renderRow({
        item: makeSaida({ id: 'exp-1', foreignExpenseId: null, projetoOrigem: null, editavel: true }),
        onRemoveExpense,
      });

      fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
      expect(onRemoveExpense).toHaveBeenCalledWith('exp-1', undefined);
      confirmSpy.mockRestore();
    });
  });
});

/**
 * Linha de FATURA sob as capabilities do servidor (#448 B1a/B1b).
 *
 * O chip de status É a CTA "Pagar fatura" e o "Desfazer pagamento" mora nas
 * ações da linha. Com `actions` presente e sem o verbo — caso do último4
 * ambíguo, cuja única resposta possível é 409 — os dois somem/travam. Sem
 * `actions` (API antiga) nada muda.
 */
describe('MovimentacaoRow — fatura e capabilities do servidor', () => {
  const invoice = (overrides: Partial<AccountViewSaida> = {}) =>
    makeSaida({
      descricao: 'Fatura Nubank',
      isInvoice: true,
      cardLast4: '4488',
      dueMonth: '2026-06',
      editavel: false,
      tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
      ...overrides,
    });

  it('API antiga (sem actions): o chip continua clicável e chama onPayInvoice', () => {
    const props = renderRow({ item: invoice({ realizado: false }) });
    const chip = screen.getByTitle('Pagar fatura');
    expect(chip).toBeEnabled();
    fireEvent.click(chip);
    expect(props.onPayInvoice).toHaveBeenCalledWith('4488');
  });

  it('actions: [] (último4 ambíguo) degrada o chip para informativo — sem clique, sem title', () => {
    const props = renderRow({ item: invoice({ realizado: false, actions: [], cardId: null }) });
    expect(screen.queryByTitle('Pagar fatura')).not.toBeInTheDocument();
    const chip = screen.getByRole('button', { name: 'A pagar' });
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    expect(props.onPayInvoice).not.toHaveBeenCalled();
  });

  it('actions: [] também retira "Desfazer pagamento" das ações da linha', () => {
    renderRow({
      item: invoice({ realizado: true, status: 'PAGO', actions: [] }),
      onUndoPayment: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: 'Desfazer pagamento' })).not.toBeInTheDocument();
    // "Ajustar fatura" segue disponível: /invoice-adjustments não tem 409.
    expect(screen.getAllByRole('button', { name: 'Ajustar fatura' }).length).toBeGreaterThan(0);
  });

  it('actions: ["undo"] mantém o Desfazer da API nova', () => {
    const onUndoPayment = vi.fn();
    renderRow({
      item: invoice({ realizado: true, status: 'PAGO', actions: ['undo'] }),
      onUndoPayment,
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Desfazer pagamento' })[0]);
    expect(onUndoPayment).toHaveBeenCalledWith('4488');
  });
});
