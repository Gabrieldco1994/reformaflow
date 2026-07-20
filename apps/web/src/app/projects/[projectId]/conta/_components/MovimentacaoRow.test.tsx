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
      });

      const semContaChip = screen.getByText('Sem conta');
      fireEvent.click(semContaChip.closest('button, a, [role="button"]') || semContaChip);
      
      // Verificar que o callback de vinculação foi chamado
      expect(onVincular).toHaveBeenCalledWith(item);
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
      expect(screen.getByText('Conta 5678')).toBeInTheDocument();
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
  });
});
