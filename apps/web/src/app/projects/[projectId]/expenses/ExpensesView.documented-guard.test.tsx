import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Expense, ExpensesPage, Project } from "@/types";
import { api } from "@/lib/api";
import { ExpensesView } from "./ExpensesView";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({ projectId: "reforma-1", projectType: "REFORMA" }),
}));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { name: "Teste" }, hasModule: () => true }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/reforma-1/expenses",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("period=ALL"),
}));

function plain(id: string): Expense {
  return {
    id,
    titulo: `Item ${id}`,
    tipoDespesa: "OUTROS",
    valor: 1_000,
    quantidade: 1,
    valorTotal: 1_000,
    formaPagamento: "A_VISTA",
    dataPagamento: "2026-01-02",
    dataCompra: "2026-01-02",
    status: "PLANEJADO",
  };
}

const documented: Expense = {
  ...plain("doc"),
  schedule: {
    version: 1,
    occurrences: [{ index: 0, parcela: null, valor: 1_000, data: "2026-01-02", invoiceDueMonth: null }],
  },
};

function renderView(ownExpenses: Expense[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  const page: ExpensesPage = {
    items: ownExpenses,
    total: ownExpenses.length,
    page: 1,
    pageSize: 2_000,
    totalPages: 1,
  };
  const project: Project = { id: "reforma-1", name: "Reforma", rooms: [] };
  client.setQueryData(["expenses", "reforma-1"], page);
  client.setQueryData(["expenses", "reforma-1", "paid-origins"], { items: [] });
  client.setQueryData(["project", "reforma-1"], project);
  client.setQueryData(["tenant", "credit-cards"], []);
  client.setQueryData(["tenant", "bank-accounts"], []);
  client.setQueryData(["tenant", "projects"], []);
  client.setQueryData(["bank-accounts", "reforma-1"], []);
  client.setQueryData(["cross-project-expenses", "reforma-1", "unified-view"], []);
  return render(
    <QueryClientProvider client={client}>
      <ExpensesView />
    </QueryClientProvider>,
  );
}

describe("ExpensesView — bulk com cronograma documentado (#701, REFORMA)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.patch).mockResolvedValue({});
  });

  it("selecionar tudo + marcar como pago com documentado no meio de 5: só as 4 normais recebem PATCH", async () => {
    renderView([plain("a"), plain("b"), documented, plain("d"), plain("e")]);
    fireEvent.click(screen.getByRole("button", { name: /Selecionar para alterar data/ }));
    fireEvent.click(screen.getByRole("button", { name: "Selecionar tudo" }));
    expect(screen.getByText("4 selecionadas")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Marcar como pago/ }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(4));
    const urls = vi.mocked(api.patch).mock.calls.map(([url]) => url).sort();
    expect(urls).toEqual([
      "/projects/reforma-1/expenses/a",
      "/projects/reforma-1/expenses/b",
      "/projects/reforma-1/expenses/d",
      "/projects/reforma-1/expenses/e",
    ]);
  });

  it("documentado não tem checkbox no modo seleção; normais têm", () => {
    renderView([plain("a"), documented]);
    fireEvent.click(screen.getByRole("button", { name: /Selecionar para alterar data/ }));
    expect(screen.getAllByRole("button", { name: "Marcar" })).toHaveLength(1);
  });
});
