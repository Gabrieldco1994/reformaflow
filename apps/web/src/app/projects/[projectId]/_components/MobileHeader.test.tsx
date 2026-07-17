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

describe("MobileHeader", () => {
  it("uses the minimal PESSOAL header with 44px action targets", () => {
    render(
      <MobileHeader
        project={{ id: "p1", name: "Pessoal", type: ProjectType.PESSOAL }}
        hasMoreSheet
        onOpenMais={vi.fn()}
      />,
    );

    expect(screen.getByRole("banner")).toHaveAttribute(
      "data-mobile-header",
      "minimal",
    );
    expect(screen.getByRole("banner")).toHaveClass("safe-pt");
    expect(
      screen.getByRole("link", { name: "Voltar para projetos" }),
    ).toHaveClass("min-h-11", "min-w-11");
    expect(screen.getByRole("button", { name: "Mais opções" })).toHaveClass(
      "min-h-11",
      "min-w-11",
    );
    expect(screen.getByTestId("notification-action")).toHaveClass(
      "min-h-11",
      "min-w-11",
    );
  });

  it.each([
    ProjectType.REFORMA,
    ProjectType.COMPRA,
    ProjectType.CASA,
    ProjectType.CARRO,
    ProjectType.PLANTAS,
  ])("uses the minimal header and 44px action targets for %s", (type) => {
    render(
      <MobileHeader
        project={{ id: "project-1", name: "Projeto teste", type }}
        hasMoreSheet
        onOpenMais={vi.fn()}
      />,
    );

    expect(screen.getByRole("banner")).toHaveAttribute(
      "data-mobile-header",
      "minimal",
    );
    expect(screen.getByRole("banner")).toHaveClass("safe-pt");
    expect(
      screen.getByRole("link", { name: "Voltar para projetos" }),
    ).toHaveClass("min-h-11", "min-w-11");
    expect(screen.getByRole("button", { name: "Mais opções" })).toHaveClass(
      "min-h-11",
      "min-w-11",
    );
    expect(screen.getByTestId("notification-action")).toHaveClass(
      "min-h-11",
      "min-w-11",
    );
  });
});
