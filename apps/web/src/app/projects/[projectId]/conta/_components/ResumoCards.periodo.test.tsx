/**
 * Rótulos do ResumoCards por PERÍODO.
 *
 * A regra que este teste tranca: saldos PONTUAIS (caixa/carteira "hoje") nunca
 * podem ser lidos como fluxo do período, e fluxos (entrou/saiu/falta pagar)
 * precisam dizer "no ano" quando a tela é anual. `sobraPrevista` anual mistura
 * saldo pontual (caixa de hoje) com fluxo do ano DE PROPÓSITO — o rótulo tem que
 * deixar isso explícito ("com o caixa de hoje").
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResumoCards } from './ResumoCards';

const values = {
  caixaHoje: 10_101,
  entrouMes: 20_202,
  saiuMes: 30_303,
  faltaPagarMes: 40_404,
  recebimentosPrevistosMes: 50_505,
  sobraPrevista: 60_606,
} as const;

describe('ResumoCards — período anual', () => {
  it('rotula os FLUXOS como do ano', () => {
    render(
      <ResumoCards
        {...values}
        period="ano"
        activeQuickFilter={null}
        onQuickFilterSelect={vi.fn()}
      />,
    );

    const realized = screen.getByRole('region', { name: 'Realizado' });
    expect(realized).toHaveTextContent('Entrou no ano');
    expect(realized).toHaveTextContent('Saiu no ano');
    expect(realized).not.toHaveTextContent('Entrou no mês');
    expect(realized).not.toHaveTextContent('Saiu no mês');

    const projection = screen.getByRole('region', { name: 'Projeção' });
    expect(projection).toHaveTextContent('Ainda falta pagar no ano');
  });

  it('mantém o saldo PONTUAL rotulado como "hoje", nunca como "no ano"', () => {
    render(
      <ResumoCards
        {...values}
        period="ano"
        activeQuickFilter={null}
        onQuickFilterSelect={vi.fn()}
      />,
    );

    expect(screen.getByText(/Tenho na conta hoje/)).toBeInTheDocument();
  });

  it('explicita que a sobra prevista do ano parte do caixa de HOJE', () => {
    render(
      <ResumoCards
        {...values}
        period="ano"
        activeQuickFilter={null}
        onQuickFilterSelect={vi.fn()}
      />,
    );

    const projection = screen.getByRole('region', { name: 'Projeção' });
    expect(within(projection).getByText(/com o caixa de hoje/i)).toBeInTheDocument();
  });

  it('modo Carteira no ano: saldo pontual segue dizendo "hoje", nunca "neste período"', () => {
    render(
      <ResumoCards
        {...values}
        caixaHoje={0}
        carteiraHoje={77_777}
        period="ano"
        activeQuickFilter={null}
        onQuickFilterSelect={vi.fn()}
      />,
    );

    expect(screen.getByText(/Carteira \(dinheiro\) hoje/)).toBeInTheDocument();
    expect(screen.queryByText(/neste período/)).not.toBeInTheDocument();
  });

  it('o mês não regride: sem `period`, os rótulos mensais continuam iguais', () => {
    render(
      <ResumoCards {...values} activeQuickFilter={null} onQuickFilterSelect={vi.fn()} />,
    );

    const realized = screen.getByRole('region', { name: 'Realizado' });
    expect(realized).toHaveTextContent('Entrou no mês');
    expect(realized).toHaveTextContent('Saiu no mês');
    expect(screen.getByRole('region', { name: 'Projeção' })).toHaveTextContent(
      'Ainda falta pagar',
    );
    expect(screen.queryByText('Entrou no ano')).not.toBeInTheDocument();
  });
});
