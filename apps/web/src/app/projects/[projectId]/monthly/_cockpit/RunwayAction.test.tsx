/**
 * Testa o gate por tom ("tone") do botão "Como fechar no azul?":
 * - crossover presente → botão visível no MobileRunway
 * - sem crossover → botão ausente
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MobileRunway from './MobileRunway';
import type { DreSaldoAcumuladoRow } from '../../dre/_types';

// Minimal chart mock to avoid recharts/SVG errors in test
vi.mock('./RunwayActionSheet', () => ({
  RunwayActionSheet: () => <div data-testid="runway-sheet" />,
}));

function row(mes: string, saldoProjetado: number): DreSaldoAcumuladoRow {
  return {
    mes,
    recebimentos: 0,
    despesas: 0,
    recebimentosRealizados: null,
    despesasRealizadas: null,
    saldoProjetado,
    saldoRealizado: null,
  };
}

const makeMonths = (count: number, startMonth: string, saldos: number[]): DreSaldoAcumuladoRow[] => {
  const [y, m] = startMonth.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const month = (m! + i - 1) % 12 + 1;
    const year = (y ?? 2026) + Math.floor(((m ?? 7) + i - 1) / 12);
    return row(`${year}-${String(month).padStart(2, '0')}`, saldos[i] ?? 100_000);
  });
};

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('MobileRunway — gate por tom', () => {
  it('tone=negative: botão "Como fechar no azul?" visível', () => {
    // 6+ months with crossover in Aug
    const serie = makeMonths(8, '2026-07', [
      500_000, -50_000, -80_000, -100_000, -110_000, -120_000, -130_000, -140_000,
    ]);
    wrap(
      <MobileRunway
        serie={serie}
        currentMonth="2026-07"
        scenarioDelta={0}
        onScenarioChange={() => {}}
        candidatos={[]}
        projectId="p1"
      />,
    );
    expect(screen.getByTestId('runway-action-cta')).toBeDefined();
  });

  it('tone=positive: botão "Como fechar no azul?" ausente', () => {
    // 6+ months all positive
    const serie = makeMonths(8, '2026-07', [
      500_000, 480_000, 460_000, 440_000, 420_000, 400_000, 380_000, 360_000,
    ]);
    wrap(
      <MobileRunway
        serie={serie}
        currentMonth="2026-07"
        scenarioDelta={0}
        onScenarioChange={() => {}}
        candidatos={[]}
        projectId="p1"
      />,
    );
    expect(screen.queryByTestId('runway-action-cta')).toBeNull();
  });

  it('tone=negative sem projectId: botão ausente (sem props de ação)', () => {
    const serie = makeMonths(8, '2026-07', [
      500_000, -50_000, -80_000, -100_000, -110_000, -120_000, -130_000, -140_000,
    ]);
    wrap(
      <MobileRunway
        serie={serie}
        currentMonth="2026-07"
        scenarioDelta={0}
        onScenarioChange={() => {}}
      />,
    );
    expect(screen.queryByTestId('runway-action-cta')).toBeNull();
  });
});
