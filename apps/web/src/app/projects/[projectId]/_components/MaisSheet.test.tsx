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

  it("marks the body only while the sheet is open", () => {
    const { rerender } = render(<MaisSheet {...baseProps} />);
    expect(document.body.dataset.overlayOpen).toBe("true");
    rerender(<MaisSheet {...baseProps} open={false} />);
    expect(document.body.dataset.overlayOpen).toBeUndefined();
  });

  it("groups the complement of the dock by NAV_GROUPS, mirroring dock+rail labels", () => {
    render(
      <MaisSheet
        {...baseProps}
        project={{ id: "project-1", name: "Finanças", type: ProjectType.PESSOAL }}
        secondary={pessoalSecondary}
      />,
    );

    // Mesma taxonomia do dock e do rail: seções rotuladas por NAV_GROUPS, na
    // ORDEM de NAV_GROUPS (nunca a ordem de chegada dos itens).
    //
    // U4 (#453): "Movimentações" NÃO aparece mais aqui, e isso é correto, não
    // regressão. Os 4 slugs que o povoavam (expenses/receipts/credit-cards/
    // bank-accounts) saíram de PROJECT_NAV[PESSOAL] e o único membro restante
    // do grupo — `conta` — está DOCADO, logo fora do complemento. Grupo sem
    // membro não é emitido (contrato de `buildNavGroups`).
    const groups = screen.getAllByRole("group");
    expect(
      groups.map((group) => group.getAttribute("aria-label")),
    ).toEqual(["Planejamento", "Resultado", "Auditoria"]);

    // REGRESSÃO QUE ESTE CASO EXISTE PARA PEGAR: um cabeçalho de seção sem
    // nenhum link. É exatamente o que a PRÓXIMA remoção de slug causaria se
    // alguém emitisse o grupo antes de filtrar. Vale para todo grupo, sempre.
    for (const group of groups) {
      expect(
        within(group).getAllByRole("link").length,
        `grupo "${group.getAttribute("aria-label")}" renderizado sem nenhum link`,
      ).toBeGreaterThan(0);
    }
    expect(
      screen.queryByRole("group", { name: "Movimentações" }),
    ).not.toBeInTheDocument();

    // Itens caem no grupo declarado, com href do próprio slug.
    const planejamento = screen.getByRole("group", { name: "Planejamento" });
    expect(planejamento).toHaveAttribute("data-nav-group", "planejamento");
    expect(
      within(planejamento).getByRole("link", { name: "Recorrentes" }),
    ).toHaveAttribute("href", basePath + "/recorrentes");

    // D1: dre/neutros/planning/cash-flow voltaram — não somem mais do Mais.
    const resultado = screen.getByRole("group", { name: "Resultado" });
    const auditoria = screen.getByRole("group", { name: "Auditoria" });
    expect(within(resultado).getByRole("link", { name: "DRE" })).toHaveAttribute(
      "href",
      basePath + "/dre",
    );
    expect(
      within(auditoria).getByRole("link", { name: "Fluxo de Caixa" }),
    ).toBeInTheDocument();
    expect(
      within(auditoria).getByRole("link", { name: "Neutros" }),
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
