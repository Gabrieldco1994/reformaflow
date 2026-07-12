import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
  it("renders the visible nav labels", () => {
    const visibleNav = getProjectNavModules(ProjectType.REFORMA);
    render(
      <DesktopSidebar
        project={{ id: "p1", name: "Casa Nova", type: "REFORMA" }}
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
