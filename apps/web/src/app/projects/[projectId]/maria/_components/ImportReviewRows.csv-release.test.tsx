import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { currentLotFixture } from "../_lib/import-workflow-fixtures";
import { ImportProposalCard } from "./ImportProposalCard";

describe("CSV release ready-only review", () => {
  it("renders every purchase supplied by current-lot with exact dispositions", () => {
    const lot = currentLotFixture();
    lot.purchases.push({
      ...lot.purchases[0],
      title: "Compra já existente",
      merchant: null,
      totalCents: 12345,
      installmentIndex: null,
      installmentCount: null,
      disposition: "KEEP_EXISTING",
    });
    lot.createdEconomicTotalCents = 1_000_012_344;

    render(<ImportProposalCard lot={lot} onConfirm={vi.fn()} />);

    const rows = within(
      screen.getByRole("list", { name: "Compras prontas deste lote" }),
    ).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Será adicionada");
    expect(rows[1]).toHaveTextContent("Compra existente será mantida");
    expect(rows[1]).toHaveTextContent("R$ 123,45");
    expect(screen.getByText("R$ 10.000.123,44")).toBeVisible();
  });

  it("keeps deferred, excluded, and ignored rows opaque behind one remainder signal", () => {
    render(
      <ImportProposalCard lot={currentLotFixture()} onConfirm={vi.fn()} />,
    );

    expect(
      screen.getByText(
        "Há outras compras fora deste lote. Elas continuam no rascunho para depois.",
      ),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent("Mercado para revisar depois");
    expect(document.body).not.toHaveTextContent("Pagamento recebido da fatura");
    expect(document.body).not.toHaveTextContent(
      "Compra excluída conscientemente",
    );
    expect(document.body).not.toHaveTextContent(
      /67 adiadas|71 excluídas|73 ignoradas/,
    );
  });

  it("offers no target/type editing controls in the immutable review", () => {
    render(
      <ImportProposalCard lot={currentLotFixture()} onConfirm={vi.fn()} />,
    );

    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByLabelText(/tipo de destino/i)).toBeNull();
    expect(screen.queryByLabelText(/mão de obra/i)).toBeNull();
  });

  it("does not invent an action when the server returns none", () => {
    render(
      <ImportProposalCard lot={currentLotFixture([])} onConfirm={vi.fn()} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByRole("list", { name: "Compras prontas deste lote" }),
    ).toBeVisible();
  });
});
