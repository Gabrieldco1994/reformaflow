import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { MobileLaunchSheetContainer } from "./MobileLaunchSheetContainer";

// #218 W5 (call site 3/3) — picker "Para qual conta?" do launcher mobile.
vi.mock("../SemContaEmptyState", () => ({
  SemContaEmptyState: () => <div data-testid="sem-conta-empty" />,
}));

vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({
    projectId: "p1",
    projectType: "REFORMA",
    projectName: "Reforma",
  }),
}));

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

function renderContainer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["project", "p1", "bank-accounts"], []);
  client.setQueryData(["project", "p1", "credit-cards"], []);
  client.setQueryData(["tenant", "credit-cards"], []);
  client.setQueryData(["tenant", "bank-accounts"], []);
  client.setQueryData(["tenant", "projects"], []);

  return render(
    <QueryClientProvider client={client}>
      <MobileLaunchSheetContainer projectId="p1" open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("MobileLaunchSheetContainer — picker de conta sem nenhuma cadastrada (#218)", () => {
  it("mostra SemContaEmptyState (não o texto morto) ao escolher Extrato bancário sem conta cadastrada", () => {
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: /Fatura \/ Extrato/ }));
    fireEvent.click(screen.getByRole("button", { name: /Extrato bancário/ }));

    expect(screen.getByTestId("sem-conta-empty")).toBeInTheDocument();
    expect(
      screen.queryByText(/Nenhuma conta cadastrada\. Cadastre em/),
    ).not.toBeInTheDocument();
  });
});
