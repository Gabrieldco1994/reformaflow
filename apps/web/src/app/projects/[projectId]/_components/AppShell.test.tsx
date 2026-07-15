import { act, render, screen, within } from "@testing-library/react";
import { ProjectType, type NavModule } from "@reformaflow/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "../_types";
import { AppShell } from "./AppShell";

const mocks = vi.hoisted(() => ({
  projectId: "project-1",
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

vi.mock("@/contexts/project-context", () => ({
  ProjectProvider: ({
    value,
    children,
  }: {
    value: { projectId: string; projectType: string; projectName: string };
    children: React.ReactNode;
  }) => (
    <section
      data-testid="project-provider"
      data-project-id={value.projectId}
      data-project-type={value.projectType}
      data-project-name={value.projectName}
    >
      {children}
    </section>
  ),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: mocks.projectId }),
  usePathname: () => mocks.pathname,
  useRouter: () => mocks.router,
  useSearchParams: () => new URLSearchParams(),
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
    basePath,
    projectType,
    primary,
    canLaunch,
  }: {
    basePath: string;
    projectType: ProjectType;
    primary: NavModule[];
    canLaunch: boolean;
  }) => (
    <ol
      data-testid="primary-nav"
      data-base-path={basePath}
      data-project-type={projectType}
      data-can-launch={String(canLaunch)}
    >
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const project = (type: ProjectType): ProjectInfo => ({
  id: "project-1",
  name: "Projeto teste",
  type,
});

const PROJECT_SKIN_MATRIX = [
  { type: ProjectType.PESSOAL, color: "#0A6CF0", fill: "#E6EFFE" },
  { type: ProjectType.REFORMA, color: "#C2691E", fill: "#FBEBDC" },
  { type: ProjectType.COMPRA, color: "#7A3FC2", fill: "#EFE6FA" },
  { type: ProjectType.CASA, color: "#1E924A", fill: "#DEF3E6" },
  { type: ProjectType.CARRO, color: "#5E5A52", fill: "#EAE7E1" },
  { type: ProjectType.PLANTAS, color: "#23824D", fill: "#DDF4E5" },
] as const;

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
    mocks.projectId = "project-1";
    mocks.pathname = "/projects/project-1/dashboard";
    mocks.hasProjectType.mockReturnValue(true);
    mocks.hasProjectAccess.mockReturnValue(true);
    mocks.logout.mockResolvedValue(undefined);
  });

  it("blocks direct navigation when the project type objective was revoked", async () => {
    mocks.apiGet.mockResolvedValue(project(ProjectType.CARRO));
    mocks.hasModule.mockReturnValue(true);
    mocks.hasProjectType.mockReturnValue(false);

    render(<AppShell>Conteúdo revogado</AppShell>);

    await vi.waitFor(() => {
      expect(mocks.router.replace).toHaveBeenCalledWith("/no-permission");
    });
    expect(screen.queryByText("Conteúdo revogado")).not.toBeInTheDocument();
    expect(mocks.hasProjectType).toHaveBeenCalledWith(ProjectType.CARRO);
  });

  it("blocks a forged direct module URL even for an otherwise permitted project", async () => {
    mocks.pathname = "/projects/project-1/expenses";
    mocks.apiGet.mockResolvedValue(project(ProjectType.CASA));
    mocks.hasModule.mockImplementation(
      (module: string) => module !== "expenses",
    );

    render(<AppShell>Despesas diretas</AppShell>);

    await screen.findByText("Despesas diretas");
    await vi.waitFor(() => {
      expect(mocks.router.replace).toHaveBeenCalledWith("/no-permission");
    });
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
    expect(
      screen.getByText("Conteúdo").closest("[data-ui-skin]"),
    ).toHaveAttribute("data-ui-skin", "minimal");
  });

  it.each(PROJECT_SKIN_MATRIX)(
    "scopes the one minimal skin and canonical accent for $type",
    async ({ type, color, fill }) => {
      mocks.apiGet.mockResolvedValue(project(type));
      mocks.hasModule.mockReturnValue(true);

      render(<AppShell>Conteúdo {type}</AppShell>);

      const content = await screen.findByText(`Conteúdo ${type}`);
      const shell = content.closest("[data-ui-skin]");
      expect(shell).toHaveAttribute("data-ui-skin", "minimal");
      expect(shell).toHaveStyle({
        "--project-accent": color,
        "--project-accent-soft": fill,
      });
    },
  );


  it("keeps a newer REFORMA project authoritative when an older PESSOAL request resolves last", async () => {
    const pessoalRequest = deferred<ProjectInfo>();
    const reformaRequest = deferred<ProjectInfo>();
    mocks.projectId = "personal-old";
    mocks.pathname = "/projects/personal-old/monthly";
    mocks.hasModule.mockReturnValue(true);
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === "/projects/personal-old") return pessoalRequest.promise;
      if (path === "/projects/reforma-new") return reformaRequest.promise;
      throw new Error(`Unexpected API path: ${path}`);
    });

    const { rerender } = render(<AppShell>Conteúdo atual</AppShell>);

    mocks.projectId = "reforma-new";
    mocks.pathname = "/projects/reforma-new/dashboard";
    rerender(<AppShell>Conteúdo atual</AppShell>);
    await act(async () => {
      reformaRequest.resolve({
        id: "reforma-new",
        name: "Reforma atual",
        type: ProjectType.REFORMA,
      });
    });

    const shell = (await screen.findByText("Conteúdo atual")).closest(
      "[data-ui-skin]",
    );
    expect(shell).toHaveAttribute("data-project-type", ProjectType.REFORMA);
    expect(shell).toHaveStyle({
      "--project-accent": "#C2691E",
      "--project-accent-soft": "#FBEBDC",
    });
    expect(screen.getByTestId("project-provider")).toHaveAttribute(
      "data-project-id",
      "reforma-new",
    );
    expect(screen.getByTestId("project-provider")).toHaveAttribute(
      "data-project-type",
      ProjectType.REFORMA,
    );
    expect(screen.getByTestId("primary-nav")).toHaveAttribute(
      "data-base-path",
      "/projects/reforma-new",
    );
    expect(screen.getByTestId("primary-nav")).toHaveAttribute(
      "data-project-type",
      ProjectType.REFORMA,
    );
    expect(renderedLabels(screen.getByTestId("primary-nav"))).toEqual([
      "Dashboard",
      "Despesas",
      "Recebimentos",
    ]);
    expect(screen.queryByTestId("mobile-launch-sheet")).not.toBeInTheDocument();

    await act(async () => {
      pessoalRequest.resolve({
        id: "personal-old",
        name: "Pessoal antigo",
        type: ProjectType.PESSOAL,
      });
    });

    expect(shell).toHaveAttribute("data-project-type", ProjectType.REFORMA);
    expect(screen.getByTestId("project-provider")).toHaveAttribute(
      "data-project-id",
      "reforma-new",
    );
    expect(screen.getByTestId("primary-nav")).toHaveAttribute(
      "data-base-path",
      "/projects/reforma-new",
    );
    expect(renderedLabels(screen.getByTestId("primary-nav"))).toEqual([
      "Dashboard",
      "Despesas",
      "Recebimentos",
    ]);
    expect(screen.queryByTestId("mobile-launch-sheet")).not.toBeInTheDocument();
    expect(mocks.router.push).not.toHaveBeenCalled();
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });

  it("renders a minimal neutral project-loading shell", () => {
    mocks.apiGet.mockReturnValue(new Promise(() => undefined));
    mocks.hasModule.mockReturnValue(true);

    render(<AppShell>Conteúdo</AppShell>);

    const loading = screen.getByRole("status");
    expect(loading).toHaveAttribute("data-ui-loading", "minimal-neutral");
    expect(loading).toHaveClass("bg-[#eef0f3]");
    expect(loading).not.toHaveClass("bg-white");
    expect(loading.querySelector(".border-darc-red")).not.toBeInTheDocument();
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
