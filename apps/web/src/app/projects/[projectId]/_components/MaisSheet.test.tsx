import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ProjectType, type NavModule } from "@reformaflow/domain";
import { describe, expect, it, vi } from "vitest";
import { MaisSheet } from "./MaisSheet";

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
// `group` é obrigatório em `NavModule` desde U1 (#450): PLANTAS é um tipo de
// lista única, logo todas as entradas são "modulos" — igual ao PROJECT_NAV.
const secondary: NavModule[] = [
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

const baseProps: React.ComponentProps<typeof MaisSheet> = {
  open: true,
  project: {
    id: "project-1",
    name: "Minhas plantas",
    type: ProjectType.PLANTAS,
  },
  basePath,
  pathname: basePath + "/plants-ai/diagnosis",
  secondary,
  isAdmin: false,
  canSeeBudgetHistory: false,
  onClose: vi.fn(),
  onLogout: vi.fn(),
};

describe("MaisSheet", () => {
  it("preserves supplied order and marks only the exact owning route active", () => {
    const { rerender } = render(<MaisSheet {...baseProps} />);

    const links = screen.getAllByRole("link");
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
          <MaisSheet
            {...baseProps}
            open={open}
            onClose={() => setOpen(false)}
          />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Abrir Mais" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toContainElement(screen.getByRole("button", { name: "Fechar" }));

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
