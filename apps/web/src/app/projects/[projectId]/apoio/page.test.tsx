import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectType } from '@reformaflow/domain';
import ApoioPage from './page';

let mockProjectType = 'PESSOAL';

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'p1', projectType: mockProjectType, projectName: 'Minha Vida' }),
}));

describe('ApoioPage', () => {
  it('renders every project type\'s first step as a link to its module', () => {
    for (const type of Object.values(ProjectType)) {
      mockProjectType = type;
      const { unmount } = render(<ApoioPage />);
      const links = screen.getAllByRole('link');
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link.getAttribute('href')).toMatch(/^\/projects\/p1\//);
      }
      unmount();
    }
  });

  it('links the PESSOAL step "Cadastre sua conta corrente" straight to /bank-accounts', () => {
    mockProjectType = 'PESSOAL';
    render(<ApoioPage />);
    expect(
      screen.getByRole('link', { name: /cadastre sua conta corrente/i }),
    ).toHaveAttribute('href', '/projects/p1/bank-accounts');
  });
});
