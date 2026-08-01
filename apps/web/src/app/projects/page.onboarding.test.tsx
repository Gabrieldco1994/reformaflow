import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectsPage from "./page";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    hasProjectType: () => true,
    hasProjectAccess: () => true,
    canCreateProjectType: (type: string) => type === "CASA",
    hasModule: () => false,
    isAdmin: false,
    user: { id: "u1" },
    refresh: mocks.refresh,
  }),
}));
vi.mock("@/contexts/journey-runtime-context", () => ({
  useJourneyRuntime: () => ({ emitProjectsCreated: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({
  api: { get: mocks.apiGet, post: mocks.apiPost, delete: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)}>{children}</a>
  ),
}));
vi.mock("@/components/notifications/NotificationsBell", () => ({
  NotificationsBell: () => null,
}));
vi.mock("./_components/ProjectHubCard", () => ({
  ProjectHubCard: () => null,
}));
vi.mock("./_components/CreateProjectModal", () => ({
  CreateProjectModal: ({
    open,
    newProject,
    setNewProject,
    onCreate,
  }: {
    open: boolean;
    newProject: { name: string; type: string; description: string };
    setNewProject: (value: {
      name: string;
      type: string;
      description: string;
    }) => void;
    onCreate: () => void;
  }) =>
    open ? (
      <div>
        <label>
          Nome do projeto
          <input
            value={newProject.name}
            onChange={(event) =>
              setNewProject({ ...newProject, name: event.target.value })
            }
          />
        </label>
        <button onClick={onCreate}>Confirmar projeto</button>
      </div>
    ) : null,
}));

describe("first project onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiGet.mockResolvedValue([]);
    mocks.apiPost.mockResolvedValue({
      id: "casa-1",
      name: "Minha Casa",
      type: "CASA",
      createdAt: "2026-07-14T12:00:00-03:00",
    });
    mocks.refresh.mockResolvedValue(undefined);
  });

  it("creates no project automatically and requires an explicit permitted name/type", async () => {
    const browser = userEvent.setup();
    render(<ProjectsPage />);

    await screen.findByRole("button", { name: "Criar Projeto" });
    expect(mocks.apiPost).not.toHaveBeenCalled();
    await browser.click(screen.getByRole("button", { name: "Criar Projeto" }));
    await browser.type(screen.getByLabelText("Nome do projeto"), "Minha Casa");
    await browser.click(
      screen.getByRole("button", { name: "Confirmar projeto" }),
    );

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    expect(mocks.apiPost).toHaveBeenCalledWith("/projects", {
      name: "Minha Casa",
      type: "CASA",
      description: "",
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    // NÃO `/projects/casa-1`: não existe `page.tsx` em `projects/[projectId]/`,
    // então a rota crua é 404. Este teste afirmava a rota quebrada e por isso
    // ficou verde enquanto o usuário caía em "This page could not be found".
    expect(mocks.push).toHaveBeenCalledWith("/projects/casa-1/dashboard");
  });

  // Regressão: quem já concluiu o onboarding daquele tipo não tem jornada para
  // disparar, então nada navega depois — e o 404 fica na tela, com o painel da
  // jornada (quando existe) boiando sobre a página de erro.
  it("nunca navega para a raiz do projeto, que não tem página", async () => {
    mocks.apiPost.mockResolvedValue({
      id: "pessoal-9",
      name: "Minha vida",
      type: "PESSOAL",
      createdAt: "2026-07-14T12:00:00-03:00",
    });
    const browser = userEvent.setup();
    render(<ProjectsPage />);

    await screen.findByRole("button", { name: "Criar Projeto" });
    await browser.click(screen.getByRole("button", { name: "Criar Projeto" }));
    await browser.type(screen.getByLabelText("Nome do projeto"), "Minha vida");
    await browser.click(
      screen.getByRole("button", { name: "Confirmar projeto" }),
    );

    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    for (const [destino] of mocks.push.mock.calls) {
      expect(destino).not.toMatch(/^\/projects\/[^/]+$/);
    }
  });
});
