import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getProjectNavModules, ProjectType } from "@reformaflow/domain";
import { MobileTabBar } from "./MobileTabBar";
import { getMobilePrimary } from "./mobile-nav";

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

const basePath = "/projects/p1";

function primaryFor(type: ProjectType) {
  return getMobilePrimary(type, getProjectNavModules(type)).primary;
}

function renderTabBar({
  projectType = ProjectType.PESSOAL,
  pathname = `${basePath}/monthly`,
  primary = primaryFor(projectType),
  canLaunch = true,
  onOpenLaunch = vi.fn(),
}: Partial<React.ComponentProps<typeof MobileTabBar>> = {}) {
  return render(
    <MobileTabBar
      basePath={basePath}
      pathname={pathname}
      projectType={projectType}
      primary={primary}
      canLaunch={canLaunch}
      onOpenLaunch={onOpenLaunch}
    />,
  );
}

const NON_PERSONAL_MATRIX = [
  {
    type: ProjectType.REFORMA,
    labels: ["Dashboard", "Despesas", "Recebimentos"],
    slugs: ["dashboard", "expenses", "receipts"],
    accent: "#C2691E",
  },
  {
    type: ProjectType.COMPRA,
    labels: ["Dashboard", "Despesas", "Recebimentos"],
    slugs: ["dashboard", "expenses", "receipts"],
    accent: "#7A3FC2",
  },
  {
    type: ProjectType.CASA,
    labels: ["Dashboard", "Contas", "Despesas"],
    slugs: ["dashboard", "bills", "expenses"],
    accent: "#1E924A",
  },
  {
    type: ProjectType.CARRO,
    labels: ["Dashboard", "Meu Carro", "Contas"],
    slugs: ["dashboard", "car-info", "bills"],
    accent: "#5E5A52",
  },
  {
    type: ProjectType.PLANTAS,
    labels: ["Cronograma", "Diagnóstico IA", "Minhas Plantas"],
    slugs: ["dashboard", "plants-ai", "plants"],
    accent: "#23824D",
  },
] as const;

describe("MobileTabBar", () => {
  it("renders Cockpit, Conta, Maria e Cartões in the PESSOAL pill and separate launch button", () => {
    renderTabBar({ canLaunch: true });

    const pill = screen.getByTestId("pessoal-tab-pill");
    const links = within(pill).getAllByRole("link");
    const launch = screen.getByRole("button", { name: "Lançar" });
    const today = screen.getByRole("link", { name: "Cockpit" });

    expect(links).toHaveLength(4);
    expect(links.map((link) => link.textContent)).toEqual([
      "Cockpit",
      "Conta",
      "Maria",
      "Cartões",
    ]);
    expect(today).toHaveAttribute("href", `${basePath}/monthly`);
    expect(today).toHaveAttribute("aria-current", "page");
    expect(today).toHaveClass("bg-[#111214]", "text-white");
    expect(screen.getByRole("link", { name: "Conta" })).toHaveAttribute(
      "href",
      `${basePath}/conta`,
    );
    expect(launch).toHaveClass("h-16", "w-16", "bg-white");
    expect(pill).not.toContainElement(launch);
    expect(screen.getByRole("link", { name: "Maria" })).toHaveAttribute(
      "href",
      `${basePath}/maria`,
    );
    expect(screen.getByRole("link", { name: "Cartões" })).toHaveAttribute(
      "href",
      `${basePath}/credit-cards`,
    );
    expect(screen.getByRole("navigation")).toHaveClass("md:hidden");
    expect(screen.getByRole("navigation")).not.toHaveClass("lg:hidden");
  });

  it("omits Cockpit/Conta when PESSOAL monthly permission is absent and keeps Maria/Cartões", () => {
    renderTabBar({ primary: [], canLaunch: true });

    expect(
      screen.queryByRole("link", { name: "Cockpit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Conta" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lançar" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Maria" })).toHaveAttribute(
      "href",
      `${basePath}/maria`,
    );
    expect(screen.getByRole("link", { name: "Cartões" })).toHaveAttribute(
      "href",
      `${basePath}/credit-cards`,
    );
  });

  it("omits Lançar when PESSOAL expenses permission is absent", () => {
    renderTabBar({ canLaunch: false });

    expect(screen.getByRole("link", { name: "Cockpit" })).toHaveAttribute(
      "href",
      `${basePath}/monthly`,
    );
    expect(screen.getByRole("link", { name: "Conta" })).toHaveAttribute(
      "href",
      `${basePath}/conta`,
    );
    expect(
      screen.queryByRole("button", { name: "Lançar" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Maria" })).toHaveAttribute(
      "href",
      `${basePath}/maria`,
    );
    expect(screen.getByRole("link", { name: "Cartões" })).toHaveAttribute(
      "href",
      `${basePath}/credit-cards`,
    );
  });

  it("calls onOpenLaunch when the PESSOAL center FAB is clicked", async () => {
    const user = userEvent.setup();
    const onOpenLaunch = vi.fn();
    renderTabBar({ canLaunch: true, onOpenLaunch });

    await user.click(screen.getByRole("button", { name: "Lançar" }));

    expect(onOpenLaunch).toHaveBeenCalledTimes(1);
  });

  it("marks Conta as active on the conta route for PESSOAL", () => {
    renderTabBar({
      pathname: `${basePath}/conta`,
      canLaunch: true,
    });

    expect(screen.getByRole("link", { name: "Conta" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Cockpit" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("marks Maria as the only active pill tab on the assistant route", () => {
    renderTabBar({ pathname: `${basePath}/maria` });

    expect(screen.getByRole("link", { name: "Maria" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Cockpit" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("link", { name: "Conta" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("link", { name: "Cartões" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it.each(NON_PERSONAL_MATRIX)(
    "renders the permission-filtered $type primary modules with project links and active accent",
    ({ type, labels, slugs, accent }) => {
      const activeIndex = 1;
      renderTabBar({
        projectType: type,
        pathname: `${basePath}/${slugs[activeIndex]}/detail`,
      });

      const links = screen.getAllByRole("link");
      expect(links.map((link) => link.textContent)).toEqual(labels);

      links.forEach((link, index) => {
        expect(link).toHaveAttribute("href", `${basePath}/${slugs[index]}`);
        expect(link).toHaveClass("min-h-11");
        expect(link.querySelector("svg")).toBeInTheDocument();
      });

      expect(links[activeIndex]).toHaveAttribute("aria-current", "page");
      expect(links[activeIndex]).toHaveClass("minimal-tab-link--active");
      expect(links[activeIndex]).not.toHaveAttribute("style");
      expect(accent).toMatch(/^#[0-9A-F]{6}$/);
      expect(
        screen.queryByRole("link", { name: "Cockpit" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Lançar" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "Maria" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("navigation")).toHaveClass("md:hidden");
    },
  );

  it.each([1, 2])(
    "renders only the %i non-PESSOAL primary links supplied after permission filtering",
    (count) => {
      const primary = primaryFor(ProjectType.CASA).slice(0, count);
      renderTabBar({
        projectType: ProjectType.CASA,
        pathname: `${basePath}/${primary[0].slug}`,
        primary,
      });

      expect(screen.getAllByRole("link")).toHaveLength(count);
      for (const module of primary) {
        expect(
          screen.getByRole("link", { name: module.label }),
        ).toHaveAttribute("href", `${basePath}/${module.slug}`);
      }
    },
  );

  it("does not render a non-PESSOAL bar when no primary module is visible", () => {
    renderTabBar({
      projectType: ProjectType.CASA,
      pathname: `${basePath}/dashboard`,
      primary: [],
    });

    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("uses exact segment boundaries for active state and aria-current", () => {
    const primary = primaryFor(ProjectType.PLANTAS);
    const { rerender } = renderTabBar({
      projectType: ProjectType.PLANTAS,
      pathname: `${basePath}/plants-ai/result`,
      primary,
    });

    expect(
      screen.getByRole("link", { name: "Diagnóstico IA" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "Minhas Plantas" }),
    ).not.toHaveAttribute("aria-current");

    rerender(
      <MobileTabBar
        basePath={basePath}
        pathname={`${basePath}/plants/profile`}
        projectType={ProjectType.PLANTAS}
        primary={primary}
        canLaunch={false}
        onOpenLaunch={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Diagnóstico IA" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      screen.getByRole("link", { name: "Minhas Plantas" }),
    ).toHaveAttribute("aria-current", "page");
  });
});
