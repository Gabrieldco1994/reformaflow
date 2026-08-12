import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Expense, ExpensesPage, Project } from "@/types";
import { ExpensesView } from "./ExpensesView";
import { groupExpensesByMes } from "./_lib/grouping-by-month";

let mockProjectType = "REFORMA";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));
vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({ projectId: "reforma-1", projectType: mockProjectType }),
}));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { name: "Teste" } }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/reforma-1/expenses",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("period=ALL"),
}));
vi.mock("./_components/ExpenseKpiCards", () => ({
  ExpenseKpiCards: ({
    totalPago,
    filteredCount,
    filteredPlanejadoCount,
    filteredPagoCount,
  }: {
    totalPago: number;
    filteredCount: number;
    filteredPlanejadoCount: number;
    filteredPagoCount: number;
  }) => (
    <>
      <output data-testid="paid-kpi">{totalPago}</output>
      <output data-testid="kpi-counts">
        {filteredCount}/{filteredPlanejadoCount}/{filteredPagoCount}
      </output>
    </>
  ),
}));
vi.mock("./_components/PersonalExpenseKpis", () => ({
  PersonalExpenseKpis: ({
    gastosControle,
  }: {
    gastosControle: {
      noCartao: number;
      naConta: number;
      aConfirmar: number;
    };
  }) => (
    <output data-testid="personal-kpis">
      {JSON.stringify(gastosControle)}
    </output>
  ),
}));

const expenses: Expense[] = [
  {
    id: "avista",
    tipoDespesa: "OUTROS",
    valor: 3_000,
    quantidade: 1,
    valorTotal: 3_000,
    formaPagamento: "A_VISTA",
    dataPagamento: "2026-01-02",
    dataCompra: "2026-01-02",
    status: "PAGO",
  },
  {
    id: "parcelado",
    tipoDespesa: "OUTROS",
    valor: 10_000,
    quantidade: 1,
    valorTotal: 10_000,
    formaPagamento: "PARCELADO",
    quantidadeParcela: 2,
    dataInicioParcela: "2026-01-05",
    dataCompra: "2026-01-03",
    paidParcelas: "[0]",
    status: "PLANEJADO",
  },
  {
    id: "quinzenal",
    tipoDespesa: "OUTROS",
    valor: 10_000,
    quantidade: 1,
    valorTotal: 10_000,
    formaPagamento: "QUINZENAL",
    quantidadeParcela: 2,
    dataInicioParcela: "2026-01-10",
    dataCompra: "2026-01-04",
    paidParcelas: "[0]",
    status: "PLANEJADO",
  },
];

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const page: ExpensesPage = {
    items: expenses,
    total: expenses.length,
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
  client.setQueryData(
    ["cross-project-expenses", "reforma-1", "unified-view"],
    [],
  );

  return render(
    <QueryClientProvider client={client}>
      <ExpensesView />
    </QueryClientProvider>,
  );
}

describe("ExpensesView — KPI Pago em projetos de reforma", () => {
  beforeEach(() => {
    mockProjectType = "REFORMA";
  });

  it("reconcilia A_VISTA e parcelas pagas com a soma dos cabeçalhos mensais", () => {
    const monthlyPaid = groupExpensesByMes(expenses).reduce(
      (sum, month) => sum + month.totalPago,
      0,
    );

    renderView();

    expect(monthlyPaid).toBe(13_000);
    expect(screen.getByTestId("paid-kpi")).toHaveTextContent(
      String(monthlyPaid),
    );
    expect(screen.getByTestId("kpi-counts")).toHaveTextContent("5/2/3");
  });

  it("preserva o eixo de competência no KPI Pago de PESSOAL", () => {
    mockProjectType = "PESSOAL";

    renderView();

    expect(screen.getByTestId("personal-kpis")).toHaveTextContent(
      JSON.stringify({ noCartao: 0, naConta: 3_000, aConfirmar: 20_000 }),
    );
  });
});
