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
  search = "",
  primary = primaryFor(projectType),
  canLaunch = true,
  onOpenLaunch = vi.fn(),
}: Partial<React.ComponentProps<typeof MobileTabBar>> = {}) {
  return render(
    <MobileTabBar
      basePath={basePath}
      pathname={pathname}
      search={search}
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
  },
  {
    type: ProjectType.COMPRA,
    labels: ["Dashboard", "Despesas", "Preços"],
    slugs: ["dashboard", "expenses", "price-compare"],
  },
  {
    type: ProjectType.CASA,
    labels: ["Dashboard", "Contas", "Financiamento"],
    slugs: ["dashboard", "bills", "financing"],
  },
  {
    type: ProjectType.CARRO,
    labels: ["Dashboard", "Meu Carro", "Contas"],
    slugs: ["dashboard", "car-info", "bills"],
  },
  {
    type: ProjectType.PLANTAS,
    labels: ["Cronograma", "Diagnóstico IA", "Minhas Plantas"],
    slugs: ["dashboard", "plants-ai", "plants"],
  },
] as const;

describe("MobileTabBar — PESSOAL dock", () => {
  it("renders the four fixed destinations with data-dock-slot and a separate launcher", () => {
    const { container } = renderTabBar({ canLaunch: true });

    const nav = screen.getByRole("navigation");
    expect(nav).toHaveAttribute("data-dock", "minimal");
    expect(nav).toHaveClass("md:hidden");
    expect(nav).not.toHaveClass("lg:hidden");

    const slots = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("[data-dock-slot]"),
    );
    expect(slots.map((slot) => slot.getAttribute("data-dock-slot"))).toEqual([
      "monthly",
      "conta",
      "maria",
      "credit-cards",
    ]);
    expect(slots.map((slot) => slot.textContent)).toEqual([
      "Cockpit",
      "Conta",
      "Maria",
      "Cartões",
    ]);

    // Launcher: separado da pill, único, marcado para o invariante I7.
    const launch = screen.getByRole("button", { name: "Lançar" });
    expect(launch).toHaveAttribute("data-launcher", "true");
    expect(container.querySelectorAll('[data-launcher="true"]')).toHaveLength(1);
    const pill = screen.getByTestId("pessoal-tab-pill");
    expect(pill).not.toContainElement(launch);
  });

  it("guards every dock slot by permission — Maria stays, Cockpit/Conta/Cartões drop", () => {
    const { container } = renderTabBar({ primary: [], canLaunch: true });

    for (const slug of ["monthly", "conta", "credit-cards"]) {
      expect(
        container.querySelector(`[data-dock-slot="${slug}"]`),
      ).not.toBeInTheDocument();
    }
    // Maria é agent-first: fica no dock sob o gate de tipo, sem módulo de nav.
    expect(
      container.querySelector('[data-dock-slot="maria"]'),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lançar" })).toBeInTheDocument();
  });

  it("drops only Cartões when credit-cards permission is absent", () => {
    const primary = primaryFor(ProjectType.PESSOAL).filter(
      (m) => m.slug !== "credit-cards",
    );
    const { container } = renderTabBar({ primary });

    expect(
      container.querySelector('[data-dock-slot="credit-cards"]'),
    ).not.toBeInTheDocument();
    for (const slug of ["monthly", "conta", "maria"]) {
      expect(
        container.querySelector(`[data-dock-slot="${slug}"]`),
      ).toBeInTheDocument();
    }
  });

  it("marks the active slot with data-active=true AND aria-current=page (exclusive)", () => {
    const { container } = renderTabBar({ pathname: `${basePath}/conta` });

    const conta = container.querySelector('[data-dock-slot="conta"]')!;
    expect(conta).toHaveAttribute("data-active", "true");
    expect(conta).toHaveAttribute("aria-current", "page");

    const monthly = container.querySelector('[data-dock-slot="monthly"]')!;
    expect(monthly).not.toHaveAttribute("data-active");
    expect(monthly).not.toHaveAttribute("aria-current");
    const maria = container.querySelector('[data-dock-slot="maria"]')!;
    expect(maria).not.toHaveAttribute("aria-current");
  });

  it("preserves ?mes on every dock href AND keeps the active state lit (E-7)", () => {
    const { container } = renderTabBar({
      pathname: `${basePath}/conta`,
      search: "mes=2026-03",
    });

    // linkHref carrega o contexto compartilhado...
    expect(
      container.querySelector('[data-dock-slot="monthly"]'),
    ).toHaveAttribute("href", `${basePath}/monthly?mes=2026-03`);
    const conta = container.querySelector('[data-dock-slot="conta"]')!;
    expect(conta).toHaveAttribute("href", `${basePath}/conta?mes=2026-03`);
    // ...mas o estado ativo é computado do pathHref (sem query): não morre com ?mes.
    expect(conta).toHaveAttribute("data-active", "true");
    expect(conta).toHaveAttribute("aria-current", "page");
  });

  it("omits the launcher when expenses permission is absent (canLaunch=false)", () => {
    const { container } = renderTabBar({ canLaunch: false });

    expect(container.querySelectorAll('[data-launcher="true"]')).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Lançar" }),
    ).not.toBeInTheDocument();
    // Maria não depende do launcher.
    expect(
      container.querySelector('[data-dock-slot="maria"]'),
    ).toBeInTheDocument();
  });

  it("calls onOpenLaunch when the center launcher is clicked", async () => {
    const user = userEvent.setup();
    const onOpenLaunch = vi.fn();
    renderTabBar({ canLaunch: true, onOpenLaunch });

    await user.click(screen.getByRole("button", { name: "Lançar" }));

    expect(onOpenLaunch).toHaveBeenCalledTimes(1);
  });
});

describe("MobileTabBar — non-PESSOAL dock", () => {
  it.each(NON_PERSONAL_MATRIX)(
    "renders $type primary modules with data-dock-slot, project links and active state",
    ({ type, labels, slugs }) => {
      const activeIndex = 1;
      const { container } = renderTabBar({
        projectType: type,
        pathname: `${basePath}/${slugs[activeIndex]}/detail`,
        search: "mes=2026-03",
      });

      const slots = Array.from(
        container.querySelectorAll<HTMLAnchorElement>("[data-dock-slot]"),
      );
      expect(slots.map((s) => s.getAttribute("data-dock-slot"))).toEqual(slugs);
      expect(slots.map((s) => s.textContent)).toEqual(labels);

      slots.forEach((slot, index) => {
        // ?mes preservado no href de cada slot.
        expect(slot).toHaveAttribute(
          "href",
          `${basePath}/${slugs[index]}?mes=2026-03`,
        );
        expect(slot).toHaveClass("min-h-11");
        expect(slot.querySelector("svg")).toBeInTheDocument();
      });

      expect(slots[activeIndex]).toHaveAttribute("data-active", "true");
      expect(slots[activeIndex]).toHaveAttribute("aria-current", "page");
      expect(slots[activeIndex]).toHaveClass("minimal-tab-link--active");

      // Sem Maria, sem launcher fora do PESSOAL.
      expect(
        container.querySelector('[data-dock-slot="maria"]'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Lançar" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("navigation")).toHaveAttribute(
        "data-dock",
        "minimal",
      );
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

  it("uses exact segment boundaries for active state", () => {
    const primary = primaryFor(ProjectType.PLANTAS);
    const { container } = renderTabBar({
      projectType: ProjectType.PLANTAS,
      pathname: `${basePath}/plants-ai/result`,
      primary,
    });

    expect(
      container.querySelector('[data-dock-slot="plants-ai"]'),
    ).toHaveAttribute("aria-current", "page");
    expect(
      container.querySelector('[data-dock-slot="plants"]'),
    ).not.toHaveAttribute("aria-current");
  });
});
