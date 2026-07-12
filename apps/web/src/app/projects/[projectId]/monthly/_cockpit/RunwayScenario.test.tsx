import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RunwayScenario } from './RunwayScenario';
import type { DreSaldoAcumuladoRow } from '../../dre/_types';

const projectedSeries: DreSaldoAcumuladoRow[][] = [];
const projectedMonths: string[] = [];

vi.mock('../../conta/_components/ProjecaoSaldo', () => ({
  ProjecaoSaldo: ({
    serie,
    currentMonth,
  }: {
    serie: DreSaldoAcumuladoRow[];
    currentMonth: string;
  }) => {
    projectedSeries.push(serie);
    projectedMonths.push(currentMonth);
    return <div data-testid="runway-projecao-saldo-stub" />;
  },
}));

function row(patch: Partial<DreSaldoAcumuladoRow>): DreSaldoAcumuladoRow {
  return {
    mes: '2026-07', recebimentos: 0, despesas: 0,
    recebimentosRealizados: null, despesasRealizadas: null,
    saldoProjetado: 0, saldoRealizado: null,
    ...patch,
  };
}

const SERIE: DreSaldoAcumuladoRow[] = [
  row({ mes: '2026-07', saldoProjetado: 500_000 }),
  row({ mes: '2026-08', saldoProjetado: 300_000 }),
  row({ mes: '2026-09', saldoProjetado: 100_000 }),
];

describe('RunwayScenario', () => {
  beforeEach(() => {
    projectedSeries.length = 0;
    projectedMonths.length = 0;
  });

  it('sem input preenchido, mostra a série original sem alerta de crossover', () => {
    render(<RunwayScenario serie={SERIE} currentMonth="2026-07" />);
    expect(screen.getByTestId('runway-projecao-saldo-stub')).toBeInTheDocument();
    expect(projectedMonths.at(-1)).toBe('2026-07');
    expect(projectedSeries.at(-1)?.map((row) => row.saldoProjetado)).toEqual([500_000, 300_000, 100_000]);
  });

  it('"e se eu gastar R$1.000 a mais por mês?" deforma cumulativamente e o mês corrente NÃO muda', () => {
    render(<RunwayScenario serie={SERIE} currentMonth="2026-07" />);
    fireEvent.change(screen.getByLabelText(/quanto a mais por mês/i), { target: { value: '1000' } });

    expect(projectedSeries.at(-1)?.map((row) => row.saldoProjetado)).toEqual([500_000, 200_000, -100_000]);
  });

  it('"e se eu gastar R$500 a MENOS por mês?" (valor negativo) melhora a curva', () => {
    render(<RunwayScenario serie={SERIE} currentMonth="2026-07" />);
    fireEvent.change(screen.getByLabelText(/quanto a mais por mês/i), { target: { value: '-500' } });

    expect(projectedSeries.at(-1)?.map((row) => row.saldoProjetado)).toEqual([500_000, 350_000, 200_000]);
  });

  it('voltar o input pra 0 restaura os valores originais (round-trip)', () => {
    render(<RunwayScenario serie={SERIE} currentMonth="2026-07" />);
    const input = screen.getByLabelText(/quanto a mais por mês/i);
    fireEvent.change(input, { target: { value: '1000' } });
    fireEvent.change(input, { target: { value: '0' } });

    expect(projectedSeries.at(-1)?.map((row) => row.saldoProjetado)).toEqual([500_000, 300_000, 100_000]);
  });
});
