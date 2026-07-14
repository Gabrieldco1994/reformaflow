import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunwayScenario } from './RunwayScenario';
import type { DreSaldoAcumuladoRow } from '../../dre/_types';

function row(patch: Partial<DreSaldoAcumuladoRow>): DreSaldoAcumuladoRow {
  return {
    mes: '2026-07',
    recebimentos: 0,
    despesas: 0,
    recebimentosRealizados: null,
    despesasRealizadas: null,
    saldoProjetado: 0,
    saldoRealizado: null,
    ...patch,
  };
}

describe('RunwayScenario', () => {
  it('renderiza o gráfico unificado sem o simulador legado "E se..."', () => {
    render(
      <RunwayScenario
        dailySerie={[
          { dia: 1, realizado: 500_000, projetado: 500_000 },
          { dia: 2, realizado: null, projetado: 480_000 },
        ]}
        runwaySerie={[
          row({ mes: '2026-07', saldoProjetado: 480_000 }),
          row({ mes: '2026-08', saldoProjetado: 300_000 }),
        ]}
        currentMonth="2026-07"
        hoje={1}
        ritmo={0}
        ritmoBase={0}
      />,
    );

    expect(document.querySelector('.recharts-responsive-container')).toBeInTheDocument();
    expect(screen.queryByText(/e se eu gastar/i)).not.toBeInTheDocument();
    expect(screen.getByText(/projeção dezembro/i)).toBeInTheDocument();
  });
});
