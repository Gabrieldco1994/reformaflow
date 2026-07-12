import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { moneyGlance } from '@/lib/money';
import { DreGlance } from './DreGlance';
import type { DreMensal } from '../../dre/_types';

function baseDre(patch: Partial<DreMensal>): DreMensal {
  return {
    mes: '2026-07', resultado: 250_000, deltaVsMesAnterior: 0,
    totalEntrou: 400_000, totalSaiuMaisGuardou: 150_000,
    receitaTotal: 400_000, despesaTotal: 150_000, margemPct: 62.5,
    entradas: [], entradasConta: [], saidas: [], saidasCaixa: [], guardado: [],
    contaCorrente: {
      caixaHoje: 500_000, entrouMes: 300_000, saiuMes: 100_000,
      faltaPagarMes: 50_000, recebimentosPrevistosMes: 20_000,
      sobraPrevista: -80_000, despesaTotal: 150_000,
    },
    ...patch,
  };
}

describe('DreGlance', () => {
  it('mostra competência e conta corrente lado a lado com valores exatos', () => {
    render(<DreGlance data={baseDre({})} projectId="p1" />);
    const competencia = within(screen.getByRole('article', { name: 'Competência' }));
    const contaCorrente = within(screen.getByRole('article', { name: 'Conta corrente' }));
    expect(competencia.getByText(moneyGlance(250_000))).toBeInTheDocument();
    expect(contaCorrente.getByText(moneyGlance(-80_000))).toBeInTheDocument();
  });

  it('resultado NEGATIVO usa tom negativo; ZERO usa tom positivo/neutro (boundary <0 vs >=0)', () => {
    const { rerender } = render(<DreGlance data={baseDre({ resultado: 0 })} projectId="p1" />);
    expect(screen.getByRole('article', { name: 'Competência' }).className).not.toMatch(/neg/);

    rerender(<DreGlance data={baseDre({ resultado: -1 })} projectId="p1" />);
    expect(screen.getByRole('article', { name: 'Competência' }).className).toMatch(/neg/);
  });

  it('link "ver DRE completo" aponta pra rota /dre do projeto', () => {
    render(<DreGlance data={baseDre({})} projectId="proj-abc" />);
    expect(screen.getByRole('link', { name: /ver dre/i })).toHaveAttribute(
      'href', '/projects/proj-abc/dre',
    );
  });
});
