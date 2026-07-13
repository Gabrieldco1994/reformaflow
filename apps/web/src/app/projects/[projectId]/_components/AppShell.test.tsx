import { render, screen, within } from "@testing-library/react";
import { ProjectType, type NavModule } from "@reformaflow/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "../_types";
import { AppShell } from "./AppShell";

const mocks = vi.hoisted(() => ({
  pathname: "/projects/project-1/dashboard",
  apiGet: vi.fn(),
  hasModule: vi.fn(),
  hasProjectType: vi.fn(),
  hasProjectAccess: vi.fn(),
  logout: vi.fn(),
  mobileHeaderProps: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: { get: mocks.apiGet } }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "project-1" }),
  usePathname: () => mocks.pathname,
  useRouter: () => mocks.router,
}));

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    user: { name: "Ana" },
    loading: false,
    isAdmin: false,
    hasModule: mocks.hasModule,
    hasProjectType: mocks.hasProjectType,
    hasProjectAccess: mocks.hasProjectAccess,
    logout: mocks.logout,
  }),
}));

vi.mock("@/components/agent/FinancialAgentWidget", () => ({
  FinancialAgentWidget: () => null,
}));
vi.mock("./DesktopSidebar", () => ({ DesktopSidebar: () => null }));
vi.mock("./MobileHeader", () => ({
  MobileHeader: (props: { hasMoreSheet: boolean }) => {
    mocks.mobileHeaderProps(props);
    return null;
  },
}));

vi.mock("./MobileTabBar", () => ({
  MobileTabBar: ({
    primary,
    canLaunch,
  }: {
    primary: NavModule[];
    canLaunch: boolean;
  }) => (
    <ol data-testid="primary-nav" data-can-launch={String(canLaunch)}>
      {primary.map((item) => (
        <li key={item.slug}>{item.label}</li>
      ))}
    </ol>
  ),
}));

vi.mock("./MaisSheet", () => ({
  MaisSheet: ({ secondary }: { secondary: NavModule[] }) => (
    <ol data-testid="secondary-nav">
      {secondary.map((item) => (
        <li key={item.slug}>{item.label}</li>
      ))}
    </ol>
  ),
}));

vi.mock("./mobile-launch/MobileLaunchSheetContainer", () => ({
  MobileLaunchSheetContainer: ({
    projectId,
    open,
  }: {
    projectId: string;
    open: boolean;
  }) => (
    <div
      data-testid="mobile-launch-sheet"
      data-project-id={projectId}
      data-open={String(open)}
    />
  ),
}));

const project = (type: ProjectType): ProjectInfo => ({
  id: "project-1",
  name: "Projeto teste",
  type,
});

function renderedLabels(container: HTMLElement) {
  return within(container)
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

function hasAncestorWithClass(element: HTMLElement, className: string) {
  for (
    let ancestor = element.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor.classList.contains(className)) return true;
  }
  return false;
}

describe("AppShell mobile navigation orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pathname = "/projects/project-1/dashboard";
    mocks.hasProjectType.mockReturnValue(true);
    mocks.hasProjectAccess.mockReturnValue(true);
    mocks.logout.mockResolvedValue(undefined);
  });

  it("splits the permission-filtered REFORMA modules and omits the personal launch sheet", async () => {
    mocks.apiGet.mockResolvedValue(project(ProjectType.REFORMA));
    mocks.hasModule.mockImplementation(
      (module: string) => module !== "expenses",
    );

    render(<AppShell>Conteúdo</AppShell>);

    const primary = await screen.findByTestId("primary-nav");
    const secondary = screen.getByTestId("secondary-nav");

    expect(renderedLabels(primary)).toEqual([
      "Dashboard",
      "Recebimentos",
      "Fluxo de Caixa",
    ]);
    expect(renderedLabels(secondary)).toEqual([
      "Cronograma",
      "Pendências",
      "Plantas",
      "Simulação",
    ]);
    expect(within(primary).queryByText("Despesas")).not.toBeInTheDocument();
    expect(within(secondary).queryByText("Despesas")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-launch-sheet")).not.toBeInTheDocument();
    expect(mocks.apiGet).toHaveBeenCalledWith("/projects/project-1");
  });

  it("does not expose PESSOAL launch controls without expenses permission", async () => {
    mocks.pathname = "/projects/project-1/monthly";
    mocks.apiGet.mockResolvedValue(project(ProjectType.PESSOAL));
    mocks.hasModule.mockImplementation(
      (module: string) => module !== "expenses",
    );

    render(<AppShell>Conteúdo</AppShell>);

    expect(await screen.findByTestId("primary-nav")).toHaveAttribute(
      "data-can-launch",
      "false",
    );
    expect(screen.queryByTestId("mobile-launch-sheet")).not.toBeInTheDocument();
  });

  it("mounts the permitted PESSOAL launcher inside a mobile-only ancestor", async () => {
    mocks.pathname = "/projects/project-1/monthly";
    mocks.apiGet.mockResolvedValue(project(ProjectType.PESSOAL));
    mocks.hasModule.mockReturnValue(true);

    render(<AppShell>Conteúdo</AppShell>);

    const launcher = await screen.findByTestId("mobile-launch-sheet");
    expect(screen.getByTestId("primary-nav")).toHaveAttribute(
      "data-can-launch",
      "true",
    );
    expect(launcher).toHaveAttribute("data-project-id", "project-1");
    expect(launcher).toHaveAttribute("data-open", "false");
    expect(hasAncestorWithClass(launcher, "md:hidden")).toBe(true);
  });

  it("keeps Mais reachable for a named non-admin with no secondary modules", async () => {
    mocks.pathname = "/projects/project-1";
    mocks.apiGet.mockResolvedValue(project(ProjectType.COMPRA));
    mocks.hasModule.mockImplementation(
      (module: string) => module === "dashboard",
    );

    render(<AppShell>Conteúdo</AppShell>);

    const secondary = await screen.findByTestId("secondary-nav");
    expect(within(secondary).queryAllByRole("listitem")).toHaveLength(0);
    expect(mocks.mobileHeaderProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ hasMoreSheet: true }),
    );
  });
});
