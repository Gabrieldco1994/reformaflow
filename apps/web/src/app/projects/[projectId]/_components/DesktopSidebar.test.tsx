import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { getProjectNavModules, ProjectType } from '@reformaflow/domain';
import { DesktopSidebar } from './DesktopSidebar';

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

// NotificationsBell pulls in data/hooks; stub it for a focused smoke test.
vi.mock('@/components/notifications/NotificationsBell', () => ({
  NotificationsBell: () => <div data-testid="notifications-bell" />,
}));

const basePath = '/projects/p1';

describe('DesktopSidebar', () => {
  it('renders the visible nav labels', () => {
    const visibleNav = getProjectNavModules(ProjectType.REFORMA);
    render(
      <DesktopSidebar
        project={{ id: 'p1', name: 'Casa Nova', type: 'REFORMA' }}
        basePath={basePath}
        pathname={`${basePath}/dashboard`}
        visibleNav={visibleNav}
        isAdmin={false}
        userName="Ana"
        onLogout={vi.fn()}
      />,
    );

    for (const item of visibleNav) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    }
    expect(screen.getByText('Casa Nova')).toBeInTheDocument();
  });

  it('renders the admin Usuários link when isAdmin', () => {
    render(
      <DesktopSidebar
        project={{ id: 'p1', name: 'Casa Nova', type: 'REFORMA' }}
        basePath={basePath}
        pathname={`${basePath}/dashboard`}
        visibleNav={getProjectNavModules(ProjectType.REFORMA)}
        isAdmin
        userName="Ana"
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByText('Usuários')).toBeInTheDocument();
  });
});
