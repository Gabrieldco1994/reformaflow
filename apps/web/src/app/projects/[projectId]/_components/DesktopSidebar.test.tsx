import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { getProjectNavModules, ProjectType } from "@reformaflow/domain";
import { DesktopSidebar } from "./DesktopSidebar";

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

// NotificationsBell pulls in data/hooks; stub it for a focused smoke test.
vi.mock("@/components/notifications/NotificationsBell", () => ({
  NotificationsBell: () => <div data-testid="notifications-bell" />,
}));

const basePath = "/projects/p1";

const props = {
  project: { id: "p1", name: "Casa Nova", type: "REFORMA" as const },
  basePath,
  pathname: `${basePath}/dashboard`,
  visibleNav: getProjectNavModules(ProjectType.REFORMA),
  isAdmin: false,
  userName: "Ana",
  onLogout: vi.fn(),
};

describe("DesktopSidebar", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  it("preserves supplied row order and marks only the owning route current", () => {
    const canonical = getProjectNavModules(ProjectType.REFORMA);
    const visibleNav = [canonical[3], canonical[0], canonical[1]];
    render(
      <DesktopSidebar
        project={{ id: "p1", name: "Casa Nova", type: "REFORMA" }}
        basePath={basePath}
        pathname={`${basePath}/dashboard/detail`}
        visibleNav={visibleNav}
        isAdmin={false}
        userName="Ana"
        onLogout={vi.fn()}
      />,
    );

    const links = within(screen.getByRole("navigation")).getAllByRole("link");
    expect(
      links.map((link) => [
        link.getAttribute("aria-label"),
        link.getAttribute("href"),
      ]),
    ).toEqual([
      ["Fluxo de Caixa", `${basePath}/cash-flow`],
      ["Dashboard", `${basePath}/dashboard`],
      ["Despesas", `${basePath}/expenses`],
    ]);
    expect(
      links
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual(["Dashboard"]);
    expect(screen.getByText("Casa Nova")).toBeInTheDocument();
  });

  it("renders the admin Usuários link when isAdmin", () => {
    render(
      <DesktopSidebar
        project={{ id: "p1", name: "Casa Nova", type: "REFORMA" }}
        basePath={basePath}
        pathname={`${basePath}/dashboard`}
        visibleNav={getProjectNavModules(ProjectType.REFORMA)}
        isAdmin
        userName="Ana"
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByText("Usuários")).toBeInTheDocument();
  });

  it("uses exact route segments for PLANTAS active state", () => {
    const visibleNav = getProjectNavModules(ProjectType.PLANTAS);
    const plantProps = {
      ...props,
      project: { id: "p1", name: "Minhas plantas", type: ProjectType.PLANTAS },
      visibleNav,
    };
    const activeLabels = () =>
      screen
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.getAttribute("aria-label"));
    const { rerender } = render(
      <DesktopSidebar {...plantProps} pathname={`${basePath}/plants-ai`} />,
    );

    expect(
      screen.getByRole("link", { name: "Diagnóstico IA" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "Minhas Plantas" }),
    ).not.toHaveAttribute("aria-current");
    expect(activeLabels()).toEqual(["Diagnóstico IA"]);

    rerender(
      <DesktopSidebar
        {...plantProps}
        pathname={`${basePath}/plants/plant-1`}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Diagnóstico IA" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      screen.getByRole("link", { name: "Minhas Plantas" }),
    ).toHaveAttribute("aria-current", "page");
    expect(activeLabels()).toEqual(["Minhas Plantas"]);
  });

  it("is collapsed by default and expands only through its explicit accessible toggle", () => {
    const { container } = render(<DesktopSidebar {...props} />);
    const sidebar = container.querySelector("aside");
    const toggle = screen.getByRole("button", {
      name: /expandir menu lateral/i,
    });

    expect(sidebar).not.toHaveClass("hover:w-56");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: /projetos/i })).toHaveAttribute(
      "href",
      "/projects",
    );
    fireEvent.click(screen.getByRole("button", { name: /sair/i }));
    expect(props.onLogout).toHaveBeenCalledTimes(1);
  });

  it("persists toggles and restores the sidebar state", () => {
    const first = render(<DesktopSidebar {...props} />);
    fireEvent.click(
      screen.getByRole("button", { name: /expandir menu lateral/i }),
    );
    expect(localStorage.getItem("lifeone:sidebar:collapsed")).toBe("false");
    first.unmount();

    render(<DesktopSidebar {...props} />);
    expect(
      screen.getByRole("button", { name: /recolher menu lateral/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it.each(["not-json", "{"])(
    "falls back to collapsed for malformed storage value %s",
    (value) => {
      localStorage.setItem("lifeone:sidebar:collapsed", value);
      expect(() => render(<DesktopSidebar {...props} />)).not.toThrow();
      expect(
        screen.getByRole("button", { name: /expandir menu lateral/i }),
      ).toHaveAttribute("aria-expanded", "false");
    },
  );

  it("remains usable when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });

    expect(() => render(<DesktopSidebar {...props} />)).not.toThrow();
    const toggle = screen.getByRole("button", {
      name: /expandir menu lateral/i,
    });
    expect(() => fireEvent.click(toggle)).not.toThrow();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});
