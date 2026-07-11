import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";

interface RecurringBillFixture {
  id: string;
  nome: string;
  valor: number;
  categoria: string;
  frequencia: string;
  diaVencimento: number;
  status: string;
}

interface RecurringBillsViewProps {
  bills: RecurringBillFixture[];
  onToggleStatus: (bill: RecurringBillFixture) => void;
  onEdit: (bill: RecurringBillFixture) => void;
  onDelete: (id: string) => void;
}

async function loadView() {
  const module = await vi.importActual<{
    RecurringBillsView: ComponentType<RecurringBillsViewProps>;
  }>("./RecurringBillsView");
  return module.RecurringBillsView;
}

const bills: RecurringBillFixture[] = [
  {
    id: "bill-energy",
    nome: "Energia Sentinela",
    valor: 20_696,
    categoria: "LUZ",
    frequencia: "MENSAL",
    diaVencimento: 7,
    status: "ATIVO",
  },
  {
    id: "bill-insurance",
    nome: "Seguro Sentinela",
    valor: 150_000,
    categoria: "SEGURO",
    frequencia: "ANUAL",
    diaVencimento: 29,
    status: "PAUSADO",
  },
];

describe("RecurringBillsView", () => {
  it("preserves source order, every table field, and all row actions in cards", async () => {
    const RecurringBillsView = await loadView();
    const onToggleStatus = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();

    render(
      <RecurringBillsView
        bills={bills}
        onToggleStatus={onToggleStatus}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    const cards = screen.getAllByRole("article");
    expect(
      cards.map((card) => within(card).getByText(/Sentinela/).textContent),
    ).toEqual(["Energia Sentinela", "Seguro Sentinela"]);

    const energy = screen.getByRole("article", { name: "Energia Sentinela" });
    expect(energy).toHaveTextContent("Luz");
    expect(energy).toHaveTextContent("R$ 206,96");
    expect(energy).toHaveTextContent("Mensal");
    expect(energy).toHaveTextContent(/(?:vence )?dia 7/i);
    expect(energy).toHaveTextContent("Ativa");

    const insurance = screen.getByRole("article", { name: "Seguro Sentinela" });
    expect(insurance).toHaveTextContent("Seguro");
    expect(insurance).toHaveTextContent("R$ 1.500,00");
    expect(insurance).toHaveTextContent("Anual");
    expect(insurance).toHaveTextContent(/(?:vence )?dia 29/i);
    expect(insurance).toHaveTextContent("Pausada");

    fireEvent.click(within(energy).getByRole("button", { name: "Pausar" }));
    fireEvent.click(within(energy).getByRole("button", { name: "Editar" }));
    fireEvent.click(within(energy).getByRole("button", { name: "Excluir" }));
    fireEvent.click(within(insurance).getByRole("button", { name: "Ativar" }));

    expect(onToggleStatus).toHaveBeenNthCalledWith(1, bills[0]);
    expect(onToggleStatus).toHaveBeenNthCalledWith(2, bills[1]);
    expect(onEdit).toHaveBeenCalledWith(bills[0]);
    expect(onDelete).toHaveBeenCalledWith("bill-energy");
  });
});
