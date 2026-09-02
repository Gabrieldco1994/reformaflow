import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Expense, ExpensesPage, Project } from "@/types";
import { ExpensesView } from "./ExpensesView";
import { groupExpensesByMes } from "./_lib/grouping-by-month";

let mockProjectType = "REFORMA";
// #218: o gate de import de extrato é `hasFeature(type,'bankAccounts') && hasModule('bankAccounts')`.
// Default true — o eixo do gate exercitado por tipo é o `hasFeature`; os casos que
// provam a metade `hasModule` sobrescrevem para false.
let mockHasModule: (slug: string) => boolean = () => true;

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));
vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({ projectId: "reforma-1", projectType: mockProjectType }),
}));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { name: "Teste" }, hasModule: (slug: string) => mockHasModule(slug) }),
}));
// O componente real de empty state é do frontend-expert (PEÇA B). Mock de contrato:
// expõe o `projectId` recebido para provar o escopo do CTA.
vi.mock("../_components/SemContaEmptyState", () => {
  const SemContaEmptyState = ({ projectId }: { projectId: string }) => (
    <div data-testid="sem-conta-empty" data-pid={projectId} />
  );
  return { SemContaEmptyState, default: SemContaEmptyState };
});
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

function renderView(overrides?: {
  ownExpenses?: Expense[];
  crossExpenses?: Expense[];
  rateioDetalhe?: Array<{ sourceId: string; detalhe: unknown }>;
  importAccounts?: Array<Record<string, unknown>>;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const ownExpenses = overrides?.ownExpenses ?? expenses;
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
  // #218: query project-scoped do picker de conta (`['bank-accounts', PROJECT_ID]`).
  client.setQueryData(["bank-accounts", "reforma-1"], overrides?.importAccounts ?? []);
  client.setQueryData(
    ["cross-project-expenses", "reforma-1", "unified-view"],
    overrides?.crossExpenses ?? [],
  );
  for (const { sourceId, detalhe } of overrides?.rateioDetalhe ?? []) {
    client.setQueryData(["rateio-detalhe", "reforma-1", sourceId], detalhe);
  }

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

// Issue #428 follow-up: fonte PESSOAL rateada (RateioAllocation) em N alvos
// REFORMA aparecia com total dobrado na aba Despesas — `splitPersonalExpenseBase`
// só suprimia o alvo apontado por `linkedExpenseId` (1º alvo), vazando os demais.
describe("ExpensesView — PESSOAL com rateio (Telha Norte, issue #428 follow-up)", () => {
  const year = new Date().getFullYear();
  const dataPagamento = `${year}-06-10`;

  const sourceTelhaNorte: Expense = {
    id: "src-telha-norte",
    tipoDespesa: "OUTROS",
    titulo: "Telha Norte",
    valor: 100_000,
    quantidade: 1,
    valorTotal: 100_000,
    formaPagamento: "A_VISTA",
    dataPagamento,
    dataCompra: dataPagamento,
    status: "PAGO",
    bankLast4: "3636",
    linkedExpenseId: "tgt-telha",
  };
  const crossTargets: Expense[] = [
    {
      id: "tgt-telha",
      tipoDespesa: "OUTROS",
      titulo: "Telhas da reforma",
      valor: 40_000,
      quantidade: 1,
      valorTotal: 40_000,
      formaPagamento: "A_VISTA",
      dataPagamento,
      dataCompra: dataPagamento,
      status: "PAGO",
      project: { id: "reforma", name: "Reforma", type: "REFORMA" },
    },
    {
      id: "tgt-piso",
      tipoDespesa: "OUTROS",
      titulo: "Piso da reforma",
      valor: 35_000,
      quantidade: 1,
      valorTotal: 35_000,
      formaPagamento: "A_VISTA",
      dataPagamento,
      dataCompra: dataPagamento,
      status: "PAGO",
      project: { id: "reforma", name: "Reforma", type: "REFORMA" },
    },
    {
      id: "tgt-argamassa",
      tipoDespesa: "OUTROS",
      titulo: "Argamassa da reforma",
      valor: 25_000,
      quantidade: 1,
      valorTotal: 25_000,
      formaPagamento: "A_VISTA",
      dataPagamento,
      dataCompra: dataPagamento,
      status: "PAGO",
      project: { id: "reforma", name: "Reforma", type: "REFORMA" },
    },
  ];
  const rateioDetalheCanonico = {
    sourceExpenseId: "src-telha-norte",
    rateado: true,
    totalSourceCents: 100_000,
    rateadoCents: 100_000,
    sobraCents: 0,
    // #448: `hiddenTargetsCount`/`hiddenAllocationCents` saíram do contrato
    // (B1b) e `removedTargetsCount` é opcional. Esta view nunca dependeu de
    // nenhum deles — o fixture sem os campos é a prova.
    items: [
      { targetExpenseId: "tgt-telha", titulo: "Telhas da reforma", fornecedor: null, projectId: "reforma", projectName: "Reforma", projectType: "REFORMA", allocationCents: 40_000, plannedValorTotalCents: null, status: "PAGO" },
      { targetExpenseId: "tgt-piso", titulo: "Piso da reforma", fornecedor: null, projectId: "reforma", projectName: "Reforma", projectType: "REFORMA", allocationCents: 35_000, plannedValorTotalCents: null, status: "PAGO" },
      { targetExpenseId: "tgt-argamassa", titulo: "Argamassa da reforma", fornecedor: null, projectId: "reforma", projectName: "Reforma", projectType: "REFORMA", allocationCents: 25_000, plannedValorTotalCents: null, status: "PAGO" },
    ],
  };

  beforeEach(() => {
    mockProjectType = "PESSOAL";
  });

  it("fonte rateada em 3 alvos: naConta conta a fonte UMA vez (1000), não 1600 (bug real)", () => {
    renderView({
      ownExpenses: [sourceTelhaNorte],
      crossExpenses: crossTargets,
      rateioDetalhe: [{ sourceId: "src-telha-norte", detalhe: rateioDetalheCanonico }],
    });

    // Correto: só a fonte (100_000 = R$1.000). SEM o fix seria 160_000 (R$1.600):
    // 100_000 (fonte) + 35_000 (piso, vazado) + 25_000 (argamassa, vazado) —
    // só tgt-telha (apontado por linkedExpenseId) era suprimido.
    expect(screen.getByTestId("personal-kpis")).toHaveTextContent(
      JSON.stringify({ noCartao: 0, naConta: 100_000, aConfirmar: 0 }),
    );
  });

  it("fonte rateada em 1 alvo: continua correta (não regride)", () => {
    const detalheUmAlvo = { ...rateioDetalheCanonico, items: [rateioDetalheCanonico.items[0]], rateadoCents: 40_000 };
    renderView({
      ownExpenses: [{ ...sourceTelhaNorte, valorTotal: 40_000, valor: 40_000 }],
      crossExpenses: [crossTargets[0]],
      rateioDetalhe: [{ sourceId: "src-telha-norte", detalhe: detalheUmAlvo }],
    });

    expect(screen.getByTestId("personal-kpis")).toHaveTextContent(
      JSON.stringify({ noCartao: 0, naConta: 40_000, aConfirmar: 0 }),
    );
  });
});

// #218 (W5) — o `ExpensesView` monta em REFORMA e COMPRA e cabeia
// `onImportAccount` INCONDICIONALMENTE no `PayOptionsModal` (~L1455). Em
// REFORMA/COMPRA `bankAccounts` não é feature nem módulo autorizado → clicar
// "Extrato bancário" dispara `GET /projects/:id/bank-accounts` → 403 mascarado
// como `[]` (`data = []` default em ~L919). A #655 transformou isso num loop de
// 403 clicável e foi revertida (#656). O gate correto:
// `hasFeature(type,'bankAccounts') && hasModule('bankAccounts')`.
describe("ExpensesView — gate de import de extrato bancário (#218)", () => {
  beforeEach(() => {
    mockProjectType = "REFORMA";
    mockHasModule = () => true;
  });

  function abrirNovaDespesa() {
    // REFORMA/COMPRA renderizam também o FAB (mesmo `aria-label`); ambos os
    // gatilhos chamam `openPayOptions`. Pega o primeiro.
    fireEvent.click(screen.getAllByRole("button", { name: /Nova despesa/i })[0]);
  }

  it("REFORMA: sem botão 'Extrato bancário' no menu de lançamento", () => {
    mockProjectType = "REFORMA";
    renderView();
    abrirNovaDespesa();
    expect(
      screen.queryByRole("button", { name: /Extrato bancário/i }),
    ).not.toBeInTheDocument();
  });

  it("REFORMA: 'Fatura de cartão' continua presente (creditCards funciona — não regride)", () => {
    mockProjectType = "REFORMA";
    renderView();
    abrirNovaDespesa();
    expect(
      screen.getByRole("button", { name: /Fatura de cartão/i }),
    ).toBeInTheDocument();
  });

  it("COMPRA: sem botão 'Extrato bancário'", () => {
    mockProjectType = "COMPRA";
    renderView();
    abrirNovaDespesa();
    expect(
      screen.queryByRole("button", { name: /Extrato bancário/i }),
    ).not.toBeInTheDocument();
  });

  it("PESSOAL + hasModule('bankAccounts') true: 'Extrato bancário' presente", () => {
    mockProjectType = "PESSOAL";
    mockHasModule = () => true;
    renderView();
    abrirNovaDespesa();
    expect(
      screen.getByRole("button", { name: /Extrato bancário/i }),
    ).toBeInTheDocument();
  });

  it("PESSOAL mas hasModule('bankAccounts') false: 'Extrato bancário' AUSENTE (trava a forma hasFeature && hasModule)", () => {
    // Mutation-guard: trocar o gate por `if (projectType === 'PESSOAL')` faz este
    // caso passar quando deveria falhar. É ele que trava a forma do gate.
    mockProjectType = "PESSOAL";
    mockHasModule = (slug) => slug !== "bankAccounts";
    renderView();
    abrirNovaDespesa();
    expect(
      screen.queryByRole("button", { name: /Extrato bancário/i }),
    ).not.toBeInTheDocument();
  });

  it("PESSOAL + hasModule true, sem conta: picker mostra SemContaEmptyState escopado, sem texto morto", () => {
    mockProjectType = "PESSOAL";
    mockHasModule = () => true;
    renderView({ importAccounts: [] });
    abrirNovaDespesa();
    fireEvent.click(screen.getByRole("button", { name: /Extrato bancário/i }));

    const empty = screen.getByTestId("sem-conta-empty");
    expect(empty).toHaveAttribute("data-pid", "reforma-1");
    expect(
      screen.queryByText(/Nenhuma conta cadastrada\. Cadastre em/),
    ).not.toBeInTheDocument();
  });
});
