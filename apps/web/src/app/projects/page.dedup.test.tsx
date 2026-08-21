import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectsPage from './page';
import { duplicates, nameCensus } from '@/test-utils/accessible-name-census';

/**
 * `/projects` — uma forma de criar projeto POR VIEWPORT, nunca duas na mesma tela.
 *
 * O hub tinha TRÊS gatilhos de `openCreate()`: o botão do header (`hidden
 * md:flex`), o add-card tracejado no fim da grade (`hidden md:grid`) e o FAB
 * (`md:hidden`). Header e add-card são o MESMO rótulo, no MESMO viewport, ao
 * mesmo tempo — e só aparecem juntos quando já existe pelo menos um projeto,
 * que é por que a suíte antiga (fixture com zero projetos, caindo no empty
 * state) nunca viu a colisão.
 *
 * O par header+FAB NÃO é duplicata: cada um é o único portador de
 * `data-journey-action="project.new"` no seu viewport. Apagar qualquer um dos
 * dois mata a jornada num viewport inteiro em silêncio — o motor escuta por
 * `closest('[data-journey-action]')` num listener de `document`, então não há
 * erro, só nada acontecendo. É o mesmo padrão do `receipt.new`. Por isso os
 * dois tokens são TRAVADOS abaixo em vez de apenas tolerados.
 */

const { hasModule, pushMock, apiGetMock, apiPostMock, refreshMock, canCreateProjectTypeMock } =
  vi.hoisted(() => ({
    hasModule: vi.fn(),
    pushMock: vi.fn(),
    apiGetMock: vi.fn(),
    apiPostMock: vi.fn(),
    refreshMock: vi.fn(),
    canCreateProjectTypeMock: vi.fn(),
  }));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    hasProjectType: () => true,
    hasProjectAccess: () => true,
    canCreateProjectType: canCreateProjectTypeMock,
    hasModule,
    isAdmin: false,
    user: { id: 'u1' },
    refresh: refreshMock,
  }),
}));
vi.mock('@/contexts/journey-runtime-context', () => ({
  useJourneyRuntime: () => ({ emitProjectsCreated: vi.fn() }),
}));
vi.mock('@/lib/api', () => ({ api: { get: apiGetMock, post: apiPostMock } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/notifications/NotificationsBell', () => ({ NotificationsBell: () => null }));
vi.mock('./_components/ProjectHubCard', () => ({
  ProjectHubCard: ({ project, onOpen }: { project: { name: string }; onOpen: () => void }) => (
    <button onClick={onOpen}>{project.name}</button>
  ),
}));
vi.mock('./_components/CreateProjectModal', () => ({
  CreateProjectModal: ({ open }: { open: boolean }) => (open ? <div>modal</div> : null),
}));

/** Todo controle que anuncia "criar projeto", em qualquer caixa. */
function createAffordances(container: HTMLElement): string[] {
  return nameCensus(container).filter((name) => /^novo projeto$/i.test(name));
}

describe('/projects — CTA de criar projeto não se repete na mesma tela', () => {
  beforeEach(() => {
    hasModule.mockReset();
    hasModule.mockReturnValue(false);
    pushMock.mockReset();
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    refreshMock.mockReset();
    canCreateProjectTypeMock.mockReset();
    canCreateProjectTypeMock.mockReturnValue(true);
    apiGetMock.mockResolvedValue([
      { id: 'p1', name: 'Casa', type: 'REFORMA', createdAt: '2026-07-11T12:00:00-03:00' },
      { id: 'p2', name: 'Carro', type: 'CARRO', createdAt: '2026-07-11T12:00:00-03:00' },
    ]);
  });

  it('com projetos na lista, nenhum rótulo de criação aparece duas vezes', async () => {
    const { container, findAllByText } = render(<ProjectsPage />);
    await findAllByText('Casa');

    const nomes = createAffordances(container);
    expect(duplicates(nomes), `censo: ${JSON.stringify(nomes)}`).toEqual([]);
  });

  it('sobram exatamente dois gatilhos — um por viewport', async () => {
    const { container, findAllByText } = render(<ProjectsPage />);
    await findAllByText('Casa');

    expect(createAffordances(container)).toHaveLength(2);
  });

  it('mantém os dois tokens project.new, um em cada viewport', async () => {
    const { container, findAllByText } = render(<ProjectsPage />);
    await findAllByText('Casa');

    const tokens = [...container.querySelectorAll('[data-journey-action="project.new"]')];
    expect(tokens).toHaveLength(2);

    // Não basta contar: dois tokens no MESMO viewport seriam duplicata, e zero
    // num viewport mata a jornada lá. A classe é o que separa os dois mundos.
    const classes = tokens.map((el) => el.className);
    expect(classes.filter((c) => c.includes('hidden md:flex'))).toHaveLength(1);
    expect(classes.filter((c) => c.includes('md:hidden'))).toHaveLength(1);
  });

  it('sem nenhum projeto, o empty state continua sendo caminho de criação', async () => {
    apiGetMock.mockResolvedValue([]);
    const { container, findByText } = render(<ProjectsPage />);
    await findByText('Criar Projeto');

    // O empty state usa outro rótulo ("Criar Projeto"), então não colide — mas
    // os dois tokens de jornada têm de continuar de pé também aqui.
    expect(duplicates(createAffordances(container))).toEqual([]);
    expect(container.querySelectorAll('[data-journey-action="project.new"]')).toHaveLength(2);
  });
});
