import { render, screen } from "@testing-library/react";
import { ProjectType } from "@reformaflow/domain";
import { describe, expect, it, vi } from "vitest";
import { MobileHeader } from "./MobileHeader";

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/notifications/NotificationsBell", () => ({
  NotificationsBell: () => <button type="button" aria-label="Notificações" />,
}));

function renderHeader(
  overrides: Partial<React.ComponentProps<typeof MobileHeader>> = {},
) {
  return render(
    <MobileHeader
      project={{ id: "p1", name: "Pessoal", type: ProjectType.PESSOAL }}
      hasMoreSheet
      maisCount={5}
      onOpenMais={vi.fn()}
      {...overrides}
    />,
  );
}

describe("MobileHeader", () => {
  it("exposes the project scope on the header (U2-E18)", () => {
    renderHeader();

    const banner = screen.getByRole("banner");
    expect(banner).toHaveAttribute("data-mobile-header", "minimal");
    expect(banner).toHaveAttribute("data-scope-project-id", "p1");
    expect(banner).toHaveAttribute("data-scope-project-type", ProjectType.PESSOAL);
  });

  it('anchors "Projetos" as a peer destination, not a back button (U1/U2-E18)', () => {
    renderHeader();

    const projetos = screen.getByRole("link", { name: "Projetos" });
    expect(projetos).toHaveAttribute("href", "/projects");
    expect(projetos).toHaveAttribute("data-nav-group", "projetos");
    expect(projetos).toHaveAttribute("data-nav-tier", "primary");
    expect(projetos).toHaveClass("min-h-11", "min-w-11");
    // O rótulo "voltar" foi rejeitado no U1 — não reaparece aqui.
    expect(
      screen.queryByRole("link", { name: "Voltar para projetos" }),
    ).not.toBeInTheDocument();
  });

  it("labels the Mais trigger with its destination count (data-mais-count)", () => {
    renderHeader({ maisCount: 7 });

    const trigger = screen.getByRole("button", { name: "Mais opções (7)" });
    expect(trigger).toHaveAttribute("data-mais-count", "7");
    expect(trigger).toHaveClass("min-h-11", "min-w-11");
  });

  it("hides the Mais trigger when there is no sheet", () => {
    renderHeader({ hasMoreSheet: false });
    expect(
      screen.queryByRole("button", { name: /Mais opções/ }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ProjectType.REFORMA,
    ProjectType.COMPRA,
    ProjectType.CASA,
    ProjectType.CARRO,
    ProjectType.PLANTAS,
  ])("keeps scope + 44px targets for %s", (type) => {
    renderHeader({
      project: { id: "project-1", name: "Projeto teste", type },
      maisCount: 3,
    });

    expect(screen.getByRole("banner")).toHaveAttribute(
      "data-scope-project-type",
      type,
    );
    expect(screen.getByRole("link", { name: "Projetos" })).toHaveClass(
      "min-h-11",
      "min-w-11",
    );
    expect(
      screen.getByRole("button", { name: "Mais opções (3)" }),
    ).toHaveClass("min-h-11", "min-w-11");
    expect(screen.getByTestId("notification-action")).toHaveClass(
      "min-h-11",
      "min-w-11",
    );
  });
});
