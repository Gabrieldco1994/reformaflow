import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResumoCards } from "./ResumoCards";

const values = {
  caixaHoje: 10_101,
  entrouMes: 20_202,
  saiuMes: 30_303,
  faltaPagarMes: 40_404,
  recebimentosPrevistosMes: 50_505,
  sobraPrevista: 60_606,
} as const;

describe("ResumoCards", () => {
  it("separates realized facts from projection without moving any sentinel value", () => {
    render(
      <ResumoCards
        {...values}
        activeQuickFilter={null}
        onQuickFilterSelect={vi.fn()}
      />,
    );

    const realized = screen.getByRole("region", { name: "Realizado" });
    expect(realized).toHaveTextContent("Entrou no mês");
    expect(realized).toHaveTextContent("R$ 202,02");
    expect(realized).toHaveTextContent("Saiu no mês");
    expect(realized).toHaveTextContent("R$ 303,03");
    expect(realized).not.toHaveTextContent("R$ 404,04");
    expect(realized).not.toHaveTextContent("R$ 505,05");
    expect(realized).not.toHaveTextContent("R$ 606,06");

    const projection = screen.getByRole("region", { name: "Projeção" });
    expect(projection).toHaveTextContent("Ainda falta pagar");
    expect(projection).toHaveTextContent("R$ 404,04");
    expect(projection).toHaveTextContent("+ R$ 505,05 previsto ainda a entrar");
    expect(projection).toHaveTextContent("Sobra prevista");
    expect(projection).toHaveTextContent("R$ 606,06");
    expect(projection).not.toHaveTextContent("R$ 202,02");
    expect(projection).not.toHaveTextContent("R$ 303,03");
  });

  it("emits only the three existing quick-filter keys and keeps Sobra noninteractive", () => {
    const onQuickFilterSelect = vi.fn();
    render(
      <ResumoCards
        {...values}
        activeQuickFilter={null}
        onQuickFilterSelect={onQuickFilterSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Entrou no mês/ }));
    fireEvent.click(screen.getByRole("button", { name: /Saiu no mês/ }));
    fireEvent.click(screen.getByRole("button", { name: /Ainda falta pagar/ }));

    expect(onQuickFilterSelect.mock.calls.map(([key]) => key)).toEqual([
      "entrouMes",
      "saiuMes",
      "faltaPagarMes",
    ]);
    const projection = screen.getByRole("region", { name: "Projeção" });
    expect(
      within(projection).queryByRole("button", { name: /Sobra prevista/ }),
    ).not.toBeInTheDocument();
    expect(within(projection).getByText("Sobra prevista")).toBeInTheDocument();
  });

  it("shows the sem conta note on Saiu no mês only when saiuSemConta > 0", () => {
    const { rerender } = render(
      <ResumoCards
        {...values}
        saiuSemConta={5_000}
        activeQuickFilter={null}
        onQuickFilterSelect={vi.fn()}
      />,
    );

    expect(screen.getByText(/inclui.*sem conta vinculada/i)).toBeInTheDocument();

    rerender(
      <ResumoCards
        {...values}
        saiuSemConta={0}
        activeQuickFilter={null}
        onQuickFilterSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText(/sem conta vinculada/i)).not.toBeInTheDocument();

    rerender(
      <ResumoCards
        {...values}
        activeQuickFilter={null}
        onQuickFilterSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText(/sem conta vinculada/i)).not.toBeInTheDocument();
  });
});
