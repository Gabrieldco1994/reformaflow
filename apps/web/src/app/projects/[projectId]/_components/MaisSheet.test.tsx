import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  getProjectNavModules,
  ProjectType,
  type NavModule,
} from "@reformaflow/domain";
import { describe, expect, it, vi } from "vitest";
import { MaisSheet } from "./MaisSheet";
import { getMobilePrimary } from "./mobile-nav";

type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  children: React.ReactNode;
};

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: LinkProps) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const basePath = "/projects/project-1";

// PLANTAS é lista única (todas as entradas caem no grupo "modulos" → "Módulos").
const plantasSecondary: NavModule[] = [
  {
    slug: "plants",
    label: "Minhas Plantas",
    iconName: "Sprout",
    module: "plantsAi",
    group: "modulos",
  },
  {
    slug: "reminders",
    label: "Lembretes",
    iconName: "Bell",
    module: "reminders",
    group: "modulos",
  },
  {
    slug: "plants-ai",
    label: "Diagnóstico IA",
    iconName: "ScanSearch",
    module: "plantsAi",
    group: "modulos",
  },
];

const pessoalSecondary = getMobilePrimary(
  ProjectType.PESSOAL,
  getProjectNavModules(ProjectType.PESSOAL),
).secondary;

const baseProps: React.ComponentProps<typeof MaisSheet> = {
  open: true,
  project: {
    id: "project-1",
    name: "Minhas plantas",
    type: ProjectType.PLANTAS,
  },
  basePath,
  pathname: basePath + "/plants-ai/diagnosis",
  search: "",
  secondary: plantasSecondary,
  isAdmin: false,
  canSeeBudgetHistory: false,
  onClose: vi.fn(),
  onLogout: vi.fn(),
};

describe("MaisSheet", () => {
  it("is a modal dialog tagged data-overlay=mais", () => {
    render(<MaisSheet {...baseProps} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("data-overlay", "mais");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("groups the complement of the dock by NAV_GROUPS, mirroring dock+rail labels", () => {
    render(
      <MaisSheet
        {...baseProps}
        project={{ id: "project-1", name: "Finanças", type: ProjectType.PESSOAL }}
        secondary={pessoalSecondary}
      />,
    );

    // Mesma taxonomia do dock e do rail: seções rotuladas por NAV_GROUPS.
    const movimentacoes = screen.getByRole("group", { name: "Movimentações" });
    expect(movimentacoes).toHaveAttribute("data-nav-group", "movimentacoes");
    expect(
      within(movimentacoes).getByRole("link", { name: "Despesas" }),
    ).toHaveAttribute("href", basePath + "/expenses");

    // D1: dre/neutros/planning/cash-flow voltaram — não somem mais do Mais.
    expect(screen.getByRole("group", { name: "Resultado" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Auditoria" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "DRE" }),
    ).toBeInTheDocument();
  });

  it("preserves supplied order within a single group and marks only the exact owning route active", () => {
    const { rerender } = render(<MaisSheet {...baseProps} />);

    const group = screen.getByRole("group", { name: "Módulos" });
    const links = within(group).getAllByRole("link");
    expect(
      links.map((link) => [
        link.textContent?.trim(),
        link.getAttribute("href"),
      ]),
    ).toEqual([
      ["Minhas Plantas", basePath + "/plants"],
      ["Lembretes", basePath + "/reminders"],
      ["Diagnóstico IA", basePath + "/plants-ai"],
    ]);

    expect(
      screen.getByRole("link", { name: "Diagnóstico IA" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "Minhas Plantas" }),
    ).not.toHaveAttribute("aria-current");

    rerender(
      <MaisSheet {...baseProps} pathname={basePath + "/plants/profile"} />,
    );

    expect(
      screen.getByRole("link", { name: "Minhas Plantas" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "Diagnóstico IA" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("renders the Apoio destination (rail parity, D8)", () => {
    render(<MaisSheet {...baseProps} />);
    expect(screen.getByRole("link", { name: "Apoio" })).toHaveAttribute(
      "href",
      basePath + "/apoio",
    );
  });

  it("preserves ?mes on module and Apoio hrefs while keeping active state lit (E-7)", () => {
    render(
      <MaisSheet
        {...baseProps}
        pathname={basePath + "/plants-ai"}
        search="mes=2026-03"
      />,
    );

    const diagnostico = screen.getByRole("link", { name: "Diagnóstico IA" });
    expect(diagnostico).toHaveAttribute(
      "href",
      basePath + "/plants-ai?mes=2026-03",
    );
    // pathHref (sem query) governa o ativo → não morre com ?mes.
    expect(diagnostico).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Apoio" })).toHaveAttribute(
      "href",
      basePath + "/apoio?mes=2026-03",
    );
  });

  it("is absent and untabbable while closed", async () => {
    const user = userEvent.setup();
    render(<MaisSheet {...baseProps} open={false} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await user.tab();
    expect(document.body).toHaveFocus();
  });

  it("opens as a modal dialog and Escape closes it with focus restored", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Abrir Mais
          </button>
          <MaisSheet {...baseProps} open={open} onClose={() => setOpen(false)} />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Abrir Mais" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toContainElement(
      screen.getByRole("button", { name: "Fechar" }),
    );

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  /**
   * #504 — mesmo ponto de entrada no mobile. A varredura de runtime mediu
   * `navHasBudgetLink = false` a 375px também; corrigir só o desktop deixaria
   * metade do defeito em produção.
   */
  it("#504 renders the frozen budget history tile when the gate allows it", () => {
    render(
      <MaisSheet
        {...baseProps}
        project={{ id: "project-1", name: "Finanças", type: ProjectType.PESSOAL }}
        secondary={pessoalSecondary}
        isAdmin
        canSeeBudgetHistory
      />,
    );

    expect(
      screen.getByRole("link", { name: "Histórico de Budget" }),
    ).toHaveAttribute("href", basePath + "/budget-allocation");
  });

  it("#504 hides the budget history tile whenever the gate denies it", () => {
    render(
      <MaisSheet
        {...baseProps}
        project={{ id: "project-1", name: "Finanças", type: ProjectType.PESSOAL }}
        secondary={pessoalSecondary}
        isAdmin
        canSeeBudgetHistory={false}
      />,
    );

    expect(
      screen.queryByRole("link", { name: "Histórico de Budget" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Usuários" })).toBeInTheDocument();
  });
});
