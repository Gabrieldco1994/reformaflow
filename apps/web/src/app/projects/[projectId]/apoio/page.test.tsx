import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ProjectType } from '@reformaflow/domain';
import ApoioPage from './page';
import { APOIO_CONTENT } from './_content';

let mockProjectType = 'PESSOAL';

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'p1', projectType: mockProjectType, projectName: 'Minha Vida' }),
}));

/** Real route dirs under [projectId] (excludes private `_foo` folders/files). */
function realProjectRoutes(): Set<string> {
  const dir = path.resolve(__dirname, '..');
  return new Set(
    readdirSync(dir).filter((name) => !name.startsWith('_') && statSync(path.join(dir, name)).isDirectory()),
  );
}

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

  it('todo slug do guia de apoio aponta para uma rota real (evita step "morto" tipo /rooms 404)', () => {
    const routes = realProjectRoutes();
    for (const [type, content] of Object.entries(APOIO_CONTENT)) {
      for (const step of content.steps) {
        if (!step.slug) continue;
        expect(routes.has(step.slug), `${type}: step "${step.title}" aponta para slug inexistente "${step.slug}"`).toBe(true);
      }
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
