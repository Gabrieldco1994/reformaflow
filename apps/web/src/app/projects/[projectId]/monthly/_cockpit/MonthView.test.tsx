import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MonthView from './MonthView';
import type { MonthlyOverviewResponse } from '../_types';

vi.mock('./DesktopRail', () => ({ DesktopRail: () => <div data-testid="desktop-rail" /> }));
vi.mock('./RunwayScenario', () => ({ RunwayScenario: () => <div data-testid="runway-scenario" /> }));
vi.mock('./SaldoMesChart', () => ({ default: () => null }));

// `ArvoreGastos` (renderizado incondicionalmente quando há `projectId`, já
// existente antes desta trilha) faz sua própria query de bank-accounts — só
// precisa de um QueryClient no contexto, sem mock (não é peça desta trilha).
function renderWithQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const DATA: MonthlyOverviewResponse = {
  mesAtual: '2026-07', meses: [], comparativo: {
    current: null, previous: null, deltaDespesas: 0, deltaDespesasPct: null,
    deltaRecebimentos: 0, deltaRecebimentosPct: null, deltaSaldo: 0,
  },
  mesAtualEntries: [], entries: [], projetos: [],
  caixa: { hoje: 0, saldoInicial: 0, temSaldoInicial: false, porMes: [] },
};

describe('MonthView — grid desktop D1', () => {
  it('renderiza o DesktopRail exatamente uma vez com o grid de 3 colunas em lg:+', () => {
    renderWithQueryClient(<MonthView data={DATA} projectId="p1" />);
    expect(screen.getAllByTestId('desktop-rail')).toHaveLength(1);
    const grid = screen.getByTestId('desktop-rail').closest('[class*="lg:grid-cols-3"]');
    expect(grid).not.toBeNull();
  });
});
