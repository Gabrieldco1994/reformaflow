import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { NovaDespesaLauncher } from "./NovaDespesaLauncher";

// #218 W5 (call site 2/3) — picker "Para qual conta?" do NovaDespesaLauncher.
vi.mock("../../_components/SemContaEmptyState", () => ({
  SemContaEmptyState: () => <div data-testid="sem-conta-empty" />,
}));

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

function renderLauncher() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["tenant", "credit-cards"], []);
  client.setQueryData(["tenant", "bank-accounts"], []);
  client.setQueryData(["tenant", "projects"], []);
  client.setQueryData(["bank-accounts", "p1"], []);

  render(
    <QueryClientProvider client={client}>
      <NovaDespesaLauncher
        projectId="p1"
        projectType="REFORMA"
        trigger={(open) => <button onClick={open}>abrir-launcher</button>}
      />
    </QueryClientProvider>,
  );
}

describe("NovaDespesaLauncher — picker de conta sem nenhuma cadastrada (#218)", () => {
  it('mostra SemContaEmptyState (não o texto morto) ao abrir "Extrato bancário" sem conta cadastrada', () => {
    renderLauncher();

    fireEvent.click(screen.getByRole("button", { name: "abrir-launcher" }));
    fireEvent.click(screen.getByRole("button", { name: /Extrato bancário/ }));

    expect(screen.getByTestId("sem-conta-empty")).toBeInTheDocument();
    expect(
      screen.queryByText(/Nenhuma conta cadastrada\. Cadastre em/),
    ).not.toBeInTheDocument();
  });
});
