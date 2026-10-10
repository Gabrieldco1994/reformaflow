import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportProposalCard } from "./ImportProposalCard";

const lot = {
  version: 1 as const,
  state: "READY_WITH_PENDING" as const,
  revision: 8,
  confirmationHash: "a".repeat(64),
  purchases: [
    {
      title: "Tinta acrílica",
      merchant: "Bela Tintas",
      purchaseDate: "2026-10-08",
      totalCents: 10001,
      installmentIndex: 1,
      installmentCount: 3,
      schedule: {
        version: 1 as const,
        occurrences: [
          {
            index: 0,
            parcela: "1/3",
            valor: 10001,
            data: "2026-10-28",
            invoiceDueMonth: "2026-10",
          },
        ],
      },
      targets: [],
      disposition: "CREATE" as const,
    },
  ],
  createdEconomicTotalCents: 10001,
  bankCashDeltaCents: 0 as const,
  invoiceDeltas: [],
  hasRemainingWork: true,
  actions: ["CONFIRM" as const],
};

describe("ImportProposalCard ready-only current lot", () => {
  it("renders only server-projected purchases and the generic remainder message", () => {
    render(
      <ImportProposalCard
        lot={lot}
        pending={false}
        error={null}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Revisão do lote" }),
    ).toBeVisible();
    expect(screen.getByText("Tinta acrílica")).toBeVisible();
    expect(screen.getAllByText("R$ 100,01").length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText(
        "Há outras compras fora deste lote. Elas continuam no rascunho para depois.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Confirmar compras deste lote" }),
    ).toBeVisible();

    expect(document.body).not.toHaveTextContent(/adiad[ao]s?:?\s*\d/i);
    expect(document.body).not.toHaveTextContent(/total do documento/i);
    expect(document.body).not.toHaveTextContent(
      /observa(?:ção|cao)|revisão 8/i,
    );
    expect(document.body).not.toHaveTextContent(lot.confirmationHash);
  });
});
