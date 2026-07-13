import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MobileCashFlowList } from './MobileCashFlowList';

// rollingBalance é fluxo orçamentário acumulado (desde zero) — NÃO é saldo bancário.
// O desktop já rotula "Fluxo Projetado/Realizado · não é saldo bancário"; o mobile
// precisa casar. Este teste trava a palavra "saldo" fora do rolling por-linha (#96).
const entries = [
  { id: '1', data: '2026-02-10', tipo: 'RECEBIMENTO', valor: 300_000, rollingBalance: 300_000, categoria: 'Salário' },
  { id: '2', data: '2026-02-12', tipo: 'DESPESA', valor: 25_000, rollingBalance: 275_000, categoria: 'Mercado' },
];

describe('MobileCashFlowList — rolling é fluxo, não saldo', () => {
  it('rotula o rolling por-linha como "fluxo" (casa com o desktop)', () => {
    render(<MobileCashFlowList entries={entries as any} />);
    expect(screen.getAllByText(/^fluxo/i).length).toBeGreaterThan(0);
  });

  it('nunca usa a palavra "saldo" (evita confundir com o §10 no PESSOAL)', () => {
    render(<MobileCashFlowList entries={entries as any} />);
    expect(screen.queryByText(/saldo/i)).not.toBeInTheDocument();
  });
});
