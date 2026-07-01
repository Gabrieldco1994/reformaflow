import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getProjectNavModules, ProjectType } from '@reformaflow/domain';
import { MobileTabBar } from './MobileTabBar';
import { useCopilotStore } from '@/stores/copilot-store';

// next/link needs an app-router context in tests — stub it to a plain anchor.
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

const basePath = '/projects/p1';

function renderPessoalBar(onOpenMais = vi.fn(), isAdmin = false) {
  const visibleNav = getProjectNavModules(ProjectType.PESSOAL);
  render(
    <MobileTabBar
      projectType="PESSOAL"
      visibleNav={visibleNav}
      basePath={basePath}
      pathname={`${basePath}/monthly`}
      isAdmin={isAdmin}
      onOpenMais={onOpenMais}
    />,
  );
  return { visibleNav, onOpenMais };
}

describe('MobileTabBar', () => {
  beforeEach(() => {
    useCopilotStore.setState({ open: false });
  });

  it('renders the Maria copiloto center button', () => {
    renderPessoalBar();
    expect(screen.getByRole('button', { name: 'Abrir copiloto' })).toBeInTheDocument();
  });

  it('renders the curated PESSOAL primary tabs (Cockpit, Visão Conta, Despesas)', () => {
    renderPessoalBar();
    expect(screen.getByText('Cockpit')).toBeInTheDocument();
    expect(screen.getByText('Visão Conta')).toBeInTheDocument();
    expect(screen.getByText('Despesas')).toBeInTheDocument();
    // A secondary module must NOT appear as a primary tab.
    expect(screen.queryByText('DRE')).not.toBeInTheDocument();
  });

  it('clicking the center button toggles the copilot store open', async () => {
    const user = userEvent.setup();
    renderPessoalBar();
    expect(useCopilotStore.getState().open).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Abrir copiloto' }));
    expect(useCopilotStore.getState().open).toBe(true);
  });

  it('shows the "Mais" button when there are secondary modules', () => {
    renderPessoalBar();
    expect(screen.getByRole('button', { name: 'Mais opções' })).toBeInTheDocument();
  });

  it('calls onOpenMais when the "Mais" button is clicked', async () => {
    const user = userEvent.setup();
    const onOpenMais = vi.fn();
    renderPessoalBar(onOpenMais);
    await user.click(screen.getByRole('button', { name: 'Mais opções' }));
    expect(onOpenMais).toHaveBeenCalledTimes(1);
  });

  it('hides "Mais" when there are no secondary modules and not admin', () => {
    const visibleNav = getProjectNavModules(ProjectType.COMPRA).slice(0, 2);
    render(
      <MobileTabBar
        projectType="COMPRA"
        visibleNav={visibleNav}
        basePath={basePath}
        pathname={`${basePath}/dashboard`}
        isAdmin={false}
        onOpenMais={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Mais opções' })).not.toBeInTheDocument();
  });
});
