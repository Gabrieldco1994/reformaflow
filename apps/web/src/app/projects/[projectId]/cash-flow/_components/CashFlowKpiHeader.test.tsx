import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CashFlowKpiHeader } from './CashFlowKpiHeader';

// Propositalmente fora de ordem cronológica/valor para pegar qualquer sort/max acidental.
const entries = [
  { id: '1', tipo: 'RECEBIMENTO', valor: 100_000, rollingBalance: 500_000, rollingBalanceRealizado: 480_000 },
  { id: '2', tipo: 'DESPESA', valor: 30_000, rollingBalance: 999_999_999, rollingBalanceRealizado: 999_999_999 }, // maior valor no meio — não é o saldo final
  { id: '3', tipo: 'DESPESA', valor: 20_000, rollingBalance: 470_000, rollingBalanceRealizado: 460_000 }, // último elemento = fonte do fluxo orçamentário
];

describe('CashFlowKpiHeader — não-PESSOAL (fluxo orçamentário)', () => {
  it('reads fluxo from the LAST array element, never max/min/sorted', () => {
    render(<CashFlowKpiHeader entries={entries as any} />);
    // moneyGlance(470_000) = "R$ 4,7 mil" / moneyGlance(460_000) = "R$ 4,6 mil"
    expect(screen.getByRole('article', { name: /Fluxo projetado/ })).toHaveTextContent('R$ 4,7 mil');
    expect(screen.getByRole('article', { name: /Fluxo realizado/ })).toHaveTextContent('R$ 4,6 mil');
    expect(screen.queryByText('R$ 1 bi')).not.toBeInTheDocument(); // garante que 999_999_999 não vazou
    expect(screen.queryByText(/10,0 mi/)).not.toBeInTheDocument(); // moneyGlance(999_999_999) não aparece em lugar nenhum
  });
  it('não usa a palavra "saldo" nos rótulos de fluxo orçamentário', () => {
    render(<CashFlowKpiHeader entries={entries as any} />);
    expect(screen.queryByRole('article', { name: /Saldo projetado/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('article', { name: /Saldo realizado/ })).not.toBeInTheDocument();
  });
  it('sums entradas/saídas by tipo without touching rollingBalance fields', () => {
    render(<CashFlowKpiHeader entries={entries as any} />);
    expect(screen.getByRole('article', { name: /Entradas/ })).toHaveTextContent('R$ 1 mil'); // 100_000 cents = R$1.000
    expect(screen.getByRole('article', { name: /Saídas/ })).toHaveTextContent('R$ 500'); // 30_000+20_000
  });
  it('empty entries → fluxo 0, no crash on entries[-1]', () => {
    render(<CashFlowKpiHeader entries={[]} />);
    expect(screen.getByRole('article', { name: /Fluxo projetado/ })).toHaveTextContent('R$ 0');
  });
});

describe('CashFlowKpiHeader — PESSOAL (saldo do §10)', () => {
  it('headline = caixaReal (§10), NUNCA o rolling desde-zero das entries', () => {
    // caixaReal = R$ 63.427,35 (§10). moneyGlance(6_342_735) = "R$ 63 mil".
    render(<CashFlowKpiHeader entries={entries as any} isPessoal caixaReal={6_342_735} />);
    const saldo = screen.getByRole('article', { name: /Saldo em conta/ });
    expect(saldo).toHaveTextContent('R$ 63 mil');
    // Prova de paridade: NÃO usa o rollingBalance da última entry (470_000 = "R$ 4,7 mil").
    expect(saldo).not.toHaveTextContent('R$ 4,7 mil');
    // PESSOAL não expõe os tiles de fluxo orçamentário (evita confundir com saldo bancário).
    expect(screen.queryByRole('article', { name: /Fluxo projetado/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('article', { name: /Fluxo realizado/ })).not.toBeInTheDocument();
    // Entradas/Saídas continuam.
    expect(screen.getByRole('article', { name: /Entradas/ })).toHaveTextContent('R$ 1 mil');
    expect(screen.getByRole('article', { name: /Saídas/ })).toHaveTextContent('R$ 500');
  });
  it('caixaReal null (§10 carregando) → mostra "—", nunca "R$ 0" enganoso', () => {
    render(<CashFlowKpiHeader entries={[]} isPessoal caixaReal={null} />);
    const saldo = screen.getByRole('article', { name: /Saldo em conta/ });
    expect(saldo).toHaveTextContent('—');
    // Não pode piscar "R$ 0" antes do §10 resolver (saldo enganoso numa tela de decisão).
    expect(saldo).not.toHaveTextContent('R$ 0');
  });
});
