import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CashFlowKpiHeader } from './CashFlowKpiHeader';

// Propositalmente fora de ordem cronológica/valor para pegar qualquer sort/max acidental.
const entries = [
  { id: '1', tipo: 'RECEBIMENTO', valor: 100_000, rollingBalance: 500_000, rollingBalanceRealizado: 480_000 },
  { id: '2', tipo: 'DESPESA', valor: 30_000, rollingBalance: 999_999_999, rollingBalanceRealizado: 999_999_999 }, // maior valor no meio — não é o saldo final
  { id: '3', tipo: 'DESPESA', valor: 20_000, rollingBalance: 470_000, rollingBalanceRealizado: 460_000 }, // último elemento = fonte da verdade
];

describe('CashFlowKpiHeader', () => {
  it('reads saldo from the LAST array element, never max/min/sorted', () => {
    render(<CashFlowKpiHeader entries={entries as any} />);
    // moneyGlance(470_000) = "R$ 4,7 mil" / moneyGlance(460_000) = "R$ 4,6 mil"
    expect(screen.getByRole('article', { name: /Saldo projetado/ })).toHaveTextContent('R$ 4,7 mil');
    expect(screen.getByRole('article', { name: /Saldo realizado/ })).toHaveTextContent('R$ 4,6 mil');
    expect(screen.queryByText('R$ 1 bi')).not.toBeInTheDocument(); // garante que 999_999_999 não vazou
    expect(screen.queryByText(/10,0 mi/)).not.toBeInTheDocument(); // moneyGlance(999_999_999) não aparece em lugar nenhum
  });
  it('sums entradas/saídas by tipo without touching rollingBalance fields', () => {
    render(<CashFlowKpiHeader entries={entries as any} />);
    expect(screen.getByRole('article', { name: /Entradas/ })).toHaveTextContent('R$ 1 mil'); // 100_000 cents = R$1.000
    expect(screen.getByRole('article', { name: /Saídas/ })).toHaveTextContent('R$ 500'); // 30_000+20_000
  });
  it('empty entries → saldo 0, no crash on entries[-1]', () => {
    render(<CashFlowKpiHeader entries={[]} />);
    expect(screen.getByRole('article', { name: /Saldo projetado/ })).toHaveTextContent('R$ 0');
  });
});
