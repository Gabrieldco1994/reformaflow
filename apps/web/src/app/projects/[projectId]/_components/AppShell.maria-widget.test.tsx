import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectType } from "@reformaflow/domain";
import { AppShell } from "./AppShell";

const mocks = vi.hoisted(() => ({
  widgetMounts: 0,
  apiGet: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: { get: mocks.apiGet } }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "personal-a" }),
  usePathname: () => "/projects/personal-a/maria",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => mocks.router,
}));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    user: { id: "actor-a", name: "Ana" },
    isAdmin: false,
    loading: false,
    hasModule: () => true,
    hasProjectType: () => true,
    hasProjectAccess: () => true,
    logout: vi.fn(),
  }),
}));
vi.mock("@/contexts/project-context", () => ({
  ProjectProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/stores/copilot-store", () => ({
  useCopilotStore: () => true,
}));
vi.mock("@/components/agent/FinancialAgentWidget", () => ({
  FinancialAgentWidget: () => {
    mocks.widgetMounts += 1;
    return <aside aria-label="Copiloto Financeiro aberto" />;
  },
}));
vi.mock("./DesktopSidebar", () => ({ DesktopSidebar: () => null }));
vi.mock("./MobileHeader", () => ({ MobileHeader: () => null }));
vi.mock("./MobileTabBar", () => ({ MobileTabBar: () => null }));
vi.mock("./MaisSheet", () => ({ MaisSheet: () => null }));
vi.mock("./mobile-launch/MobileLaunchSheetContainer", () => ({
  MobileLaunchSheetContainer: () => null,
}));

describe("AppShell on the dedicated Maria route", () => {
  beforeEach(() => {
    mocks.widgetMounts = 0;
    mocks.apiGet.mockReset();
    mocks.apiGet.mockResolvedValue({
      id: "personal-a",
      name: "Pessoal",
      type: ProjectType.PESSOAL,
      onboardedAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("does_not_mount_the_global_financial_widget_on_Maria_even_if_previously_open", async () => {
    render(<AppShell>Conversa exclusiva da Maria</AppShell>);

    expect(
      await screen.findByText("Conversa exclusiva da Maria"),
    ).toBeVisible();
    expect(mocks.widgetMounts).toBe(0);
    expect(
      screen.queryByRole("complementary", {
        name: "Copiloto Financeiro aberto",
      }),
    ).not.toBeInTheDocument();
  });
});
