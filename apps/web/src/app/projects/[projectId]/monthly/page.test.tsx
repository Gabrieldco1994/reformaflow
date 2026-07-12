import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import CockpitPage from './page';

// QA defense-in-depth: `dre-overview` pode voltar malformado (sem `anual`) —
// o cockpit não pode quebrar por causa disso, só deixar de mostrar a série
// de runway (mesmo contrato opcional que `MonthView` já aceita).
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'p1' }),
  usePathname: () => '/projects/p1/monthly',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'p1', projectType: 'PESSOAL', projectName: 'Casa' }),
}));

vi.mock('./_cockpit/MobileCockpitHeader', () => ({ default: () => <div data-testid="mobile-header" /> }));
vi.mock('./_cockpit/MobileMonthCockpit', () => ({ default: () => <div data-testid="mobile-cockpit" /> }));
vi.mock('./_cockpit/ExtratoGeral', () => ({ default: () => <div data-testid="extrato-geral" /> }));
vi.mock('./_cockpit/YearView', () => ({ default: () => <div data-testid="year-view" /> }));
vi.mock('./_cockpit/CockpitTop', () => ({ default: () => <div data-testid="cockpit-top" /> }));
vi.mock('./_cockpit/SaldosWidget', () => ({ default: () => <div data-testid="saldos-widget" /> }));
vi.mock('./_cockpit/EixoToggle', () => ({ default: () => <div data-testid="eixo-toggle" /> }));
vi.mock('./_cockpit/MonthView', () => ({
  default: ({ runwaySerie }: { runwaySerie?: unknown[] }) => (
    <div data-testid="month-view" data-runway-serie={runwaySerie ? runwaySerie.length : 'undefined'} />
  ),
}));

const MONTHLY_DATA = {
  mesAtual: '2026-07',
  meses: [{ mes: '2026-07' }],
  comparativo: {
    current: null, previous: null, deltaDespesas: 0, deltaDespesasPct: null,
    deltaRecebimentos: 0, deltaRecebimentosPct: null, deltaSaldo: 0,
  },
  mesAtualEntries: [], entries: [], projetos: [],
  caixa: { hoje: 0, saldoInicial: 0, temSaldoInicial: false, porMes: [] },
};

// DRE malformado — sem `anual` — pré-carregado no cache do React Query para
// que o primeiro render (síncrono) já exponha o dado ausente, sem depender
// de timing de resolução de promises.
const MALFORMED_DRE = { mensal: { mes: '2026-07' } };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['monthly-overview', 'p1', null], MONTHLY_DATA);
  client.setQueryData(['dre-overview', 'p1', '2026-07', 2026], MALFORMED_DRE);
  client.setQueryData(['category-budgets', 'progress', 'p1', '2026-07'], []);
  return render(
    <QueryClientProvider client={client}>
      <CockpitPage />
    </QueryClientProvider>,
  );
}

describe('CockpitPage — série de runway com DRE anual ausente', () => {
  it('não quebra e não passa runwaySerie quando dre-overview vem sem `anual`', () => {
    renderPage();
    const monthView = screen.getByTestId('month-view');
    expect(monthView).toHaveAttribute('data-runway-serie', 'undefined');
  });
});
