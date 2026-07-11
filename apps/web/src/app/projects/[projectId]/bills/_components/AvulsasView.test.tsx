import { fireEvent, render, screen, within } from "@testing-library/react";
import { ProjectType } from "@reformaflow/domain";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";

interface AvulsaFixture {
  id: string;
  tipoDespesa: string;
  titulo?: string | null;
  fornecedor?: string | null;
  valorTotal: number;
  status: "PLANEJADO" | "PAGO";
  formaPagamento: string;
  dataPagamento?: string | null;
  dataInicioParcela?: string | null;
}

interface AvulsasViewProps {
  expenses: AvulsaFixture[];
  projectType: ProjectType;
  onEdit: (expense: AvulsaFixture) => void;
  onDelete: (id: string) => void;
}

async function loadView() {
  const module = await vi.importActual<{
    AvulsasView: ComponentType<AvulsasViewProps>;
  }>("./AvulsasView");
  return module.AvulsasView;
}

const expenses: AvulsaFixture[] = [
  {
    id: "expense-paid",
    tipoDespesa: "MORADIA",
    titulo: "Conserto sentinela",
    fornecedor: "Oficina da Casa",
    valorTotal: 20_696,
    status: "PAGO",
    formaPagamento: "PIX",
    dataPagamento: "2026-07-05T12:00:00.000Z",
  },
  {
    id: "expense-planned",
    tipoDespesa: "IMPREVISTOS",
    titulo: "Reserva sentinela",
    valorTotal: 150_000,
    status: "PLANEJADO",
    formaPagamento: "PARCELADO",
    dataInicioParcela: "2026-07-21T12:00:00.000Z",
  },
];

describe("AvulsasView", () => {
  it("keeps mobile cards in source order with desktop field and action parity", async () => {
    const AvulsasView = await loadView();
    const onEdit = vi.fn();
    const onDelete = vi.fn();

    render(
      <AvulsasView
        expenses={expenses}
        projectType={ProjectType.CASA}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    const cards = screen.getAllByRole("article");
    expect(
      cards.map((card) => within(card).getByText(/sentinela/i).textContent),
    ).toEqual(["Conserto sentinela", "Reserva sentinela"]);

    const paid = screen.getByRole("article", { name: "Conserto sentinela" });
    expect(paid).toHaveTextContent("05/07/2026");
    expect(paid).toHaveTextContent("Moradia");
    expect(paid).toHaveTextContent("R$ 206,96");
    expect(paid).toHaveTextContent("Pago");

    const planned = screen.getByRole("article", { name: "Reserva sentinela" });
    expect(planned).toHaveTextContent("21/07/2026");
    expect(planned).toHaveTextContent("Imprevistos");
    expect(planned).toHaveTextContent("R$ 1.500,00");
    expect(planned).toHaveTextContent("Planejado");

    fireEvent.click(within(paid).getByRole("button", { name: "Editar" }));
    fireEvent.click(within(paid).getByRole("button", { name: "Excluir" }));

    expect(onEdit).toHaveBeenCalledWith(expenses[0]);
    expect(onDelete).toHaveBeenCalledWith("expense-paid");
  });
});
