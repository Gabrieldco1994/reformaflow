import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { currentLotFixture } from "../_lib/import-workflow-fixtures";
import { ImportProposalCard } from "./ImportProposalCard";

describe("ImportProposalCard current-lot contract", () => {
  it.each([
    ["CONFIRM", "Confirmar compras deste lote"],
    ["EXECUTE", "Aplicar compras confirmadas"],
  ] as const)(
    "renders only the server-authorized %s action",
    (action, label) => {
      const onConfirm = vi.fn();
      render(
        <ImportProposalCard
          lot={currentLotFixture([action])}
          onConfirm={onConfirm}
        />,
      );

      const button = screen.getByRole("button", { name: label });
      expect(button).toBeEnabled();
      expect(screen.getAllByRole("button")).toHaveLength(1);
      fireEvent.click(button);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    },
  );

  it("renders the ready-only purchase projection and exact server totals", () => {
    const lot = currentLotFixture();
    render(<ImportProposalCard lot={lot} onConfirm={vi.fn()} />);

    const list = screen.getByRole("list", {
      name: "Compras prontas deste lote",
    });
    const purchase = within(list)
      .getByText("Compra documental com descrição extensa")
      .closest("li");
    expect(purchase).not.toBeNull();
    if (!purchase) throw new Error("Missing projected purchase");
    expect(within(purchase).getByText("Fornecedor")).toBeVisible();
    expect(
      within(purchase).getByText("06/10/2026 · Parcela 9 de 10"),
    ).toBeVisible();
    expect(within(purchase).getByText("Será adicionada")).toBeVisible();
    expect(within(purchase).getAllByText("R$ 999.999,99")).toHaveLength(2);

    fireEvent.click(within(purchase).getByText("Ver detalhes"));
    expect(within(purchase).getByText("Reforma da casa")).toBeVisible();
    expect(within(purchase).getByText(/9\/10 · 20\/11\/2026/)).toBeVisible();
    expect(within(purchase).getByText(/10\/10 · 20\/12\/2026/)).toBeVisible();
    expect(screen.getByText("Fatura 12/2026")).toBeVisible();
    expect(screen.getAllByText("R$ 500.000,00")).toHaveLength(2);
    expect(screen.getByText("Fatura 01/2027")).toBeVisible();
    expect(screen.getAllByText("R$ 499.999,99")).toHaveLength(2);
  });

  it("gives every purchase disclosure a unique contextual accessible name", () => {
    const lot = currentLotFixture();
    const firstPurchase = lot.purchases[0];
    lot.purchases.push({
      ...firstPurchase,
      title: "Cimento estrutural",
      merchant: "Casa do Construtor",
    });

    render(<ImportProposalCard lot={lot} onConfirm={vi.fn()} />);

    const summaries = screen.getAllByText("Ver detalhes", {
      selector: "summary",
    });
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toHaveAccessibleName(
      "Ver detalhes de Compra documental com descrição extensa, compra 1",
    );
    expect(summaries[1]).toHaveAccessibleName(
      "Ver detalhes de Cimento estrutural, compra 2",
    );
  });

  it("does not expose deferred identities, source observations, or proposal internals", () => {
    const lot = currentLotFixture();
    if (!lot.confirmationHash) throw new Error("Expected a confirmation hash");
    render(<ImportProposalCard lot={lot} onConfirm={vi.fn()} />);

    expect(
      screen.getByText(
        "Há outras compras fora deste lote. Elas continuam no rascunho para depois.",
      ),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent(/observa(?:ção|cao)/i);
    expect(document.body).not.toHaveTextContent(/adiad[ao]s?:?\s*\d/i);
    expect(document.body).not.toHaveTextContent(lot.confirmationHash);
    expect(document.body).not.toHaveTextContent(/revisão 7/i);
  });

  it("shows pending, notice, and error states without enabling a financial write", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ImportProposalCard
        lot={currentLotFixture()}
        pending
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Consultando compras prontas",
    );
    expect(
      screen.getByRole("button", { name: "Confirmar compras deste lote" }),
    ).toBeDisabled();

    rerender(
      <ImportProposalCard
        lot={currentLotFixture()}
        error="Não foi possível confirmar."
        notice="A revisão mudou."
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não foi possível confirmar.",
    );
    expect(screen.getByRole("status")).toHaveTextContent("A revisão mudou.");
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar compras deste lote" }),
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders an explicit unopened state and no action without a current lot", () => {
    render(<ImportProposalCard lot={null} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "A revisão das compras prontas ainda não foi aberta.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("announces applied success after removing the stale lot and financial action", () => {
    const { rerender } = render(
      <ImportProposalCard lot={currentLotFixture()} onConfirm={vi.fn()} />,
    );
    screen
      .getByRole("button", { name: "Confirmar compras deste lote" })
      .focus();

    rerender(
      <ImportProposalCard
        lot={null}
        notice="Compras deste lote adicionadas."
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Compras deste lote adicionadas.");
    expect(status).toHaveFocus();
    expect(
      screen.queryByText("A revisão das compras prontas ainda não foi aberta."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
