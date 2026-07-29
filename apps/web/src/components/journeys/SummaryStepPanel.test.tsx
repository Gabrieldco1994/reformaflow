import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectType } from '@reformaflow/domain';
import type { OperationalSummaryStepProps } from '@/lib/operational-summaries/types';
import { SummaryStepPanel } from './SummaryStepPanel';
import type { EligibleJourneyStep } from '@/lib/journeys/runtime';

const mocks = vi.hoisted(() => ({
  getOperationalSummaryStep: vi.fn(),
  getCatalogItem: vi.fn(),
}));

vi.mock('@/lib/operational-summaries/registry', () => ({
  getOperationalSummaryStep: mocks.getOperationalSummaryStep,
}));

vi.mock('@reformaflow/domain', async () => {
  const actual = await vi.importActual<typeof import('@reformaflow/domain')>('@reformaflow/domain');
  return { ...actual, getCatalogItem: mocks.getCatalogItem };
});

function makeStep(overrides: Partial<EligibleJourneyStep> = {}): EligibleJourneyStep {
  return {
    stepKey: 'unknown-step',
    order: 0,
    experience: 'SUMMARY',
    label: 'Etapa',
    subtitle: 'Texto de apoio da etapa.',
    skippable: true,
    ...overrides,
  };
}

function baseProps(overrides: Partial<Parameters<typeof SummaryStepPanel>[0]> = {}) {
  return {
    step: makeStep(),
    projectId: 'p1',
    projectType: ProjectType.PESSOAL,
    funding: { bankAccount: null, creditCard: null },
    onFundingChange: vi.fn(),
    onDone: vi.fn(),
    onSkip: vi.fn(),
    onBack: undefined,
    ...overrides,
  };
}

describe('SummaryStepPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renderiza o componente operacional quando o stepKey está no registry (prioridade 1)', () => {
    function FakeOperationalStep(props: OperationalSummaryStepProps) {
      return (
        <div>
          <p>Componente operacional: {props.projectType}</p>
          <button onClick={() => props.onDone()}>Salvar de verdade</button>
        </div>
      );
    }
    mocks.getOperationalSummaryStep.mockReturnValue(FakeOperationalStep);

    render(<SummaryStepPanel {...baseProps({ step: makeStep({ stepKey: 'expense' }) })} />);

    expect(screen.getByText('Componente operacional: PESSOAL')).toBeInTheDocument();
    expect(mocks.getCatalogItem).not.toHaveBeenCalled();
  });

  it('chama onDone do runtime quando o componente operacional conclui', async () => {
    const onDone = vi.fn();
    function FakeOperationalStep(props: OperationalSummaryStepProps) {
      return <button onClick={() => props.onDone()}>Concluir etapa</button>;
    }
    mocks.getOperationalSummaryStep.mockReturnValue(FakeOperationalStep);

    render(<SummaryStepPanel {...baseProps({ step: makeStep({ stepKey: 'expense' }), onDone })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Concluir etapa' }));

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('mostra "Carregando…" quando o componente operacional existe mas o tipo do projeto ainda não chegou', () => {
    mocks.getOperationalSummaryStep.mockReturnValue(() => <div>nunca renderiza</div>);

    render(
      <SummaryStepPanel
        {...baseProps({ step: makeStep({ stepKey: 'expense' }), projectType: null })}
      />,
    );

    expect(screen.getByText('Carregando…')).toBeInTheDocument();
    expect(screen.queryByText('nunca renderiza')).not.toBeInTheDocument();
  });

  it('cai no resumo informativo do catálogo quando não há componente operacional (prioridade 2)', () => {
    mocks.getOperationalSummaryStep.mockReturnValue(undefined);
    mocks.getCatalogItem.mockReturnValue({
      slug: 'dashboard',
      title: 'Dashboard',
      description: 'Visão geral do projeto',
      iconName: 'BarChart3',
      ctas: [{ label: 'Adicionar despesa', href: 'expenses/new', variant: 'primary' as const }],
    });

    render(<SummaryStepPanel {...baseProps({ step: makeStep({ stepKey: 'dashboard' }) })} />);

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Visão geral do projeto')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Adicionar despesa/ })).toBeInTheDocument();
  });

  it('cai no fallback de texto simples quando o stepKey não está no registry nem no catálogo (prioridade 3)', () => {
    mocks.getOperationalSummaryStep.mockReturnValue(undefined);
    mocks.getCatalogItem.mockReturnValue(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <SummaryStepPanel
        {...baseProps({ step: makeStep({ stepKey: 'stepKey-nunca-visto', subtitle: 'Texto de apoio.' }) })}
      />,
    );

    expect(screen.getByText('Texto de apoio.')).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stepKey-nunca-visto'));
    errorSpy.mockRestore();
  });

  it('não derruba a aplicação com um stepKey desconhecido — nunca lança', () => {
    mocks.getOperationalSummaryStep.mockReturnValue(undefined);
    mocks.getCatalogItem.mockReturnValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      render(<SummaryStepPanel {...baseProps({ step: makeStep({ stepKey: 'algo-nunca-cadastrado' }) })} />),
    ).not.toThrow();
  });
});
