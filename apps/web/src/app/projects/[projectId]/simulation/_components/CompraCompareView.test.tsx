import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CashFlowEntry } from "@/types";
import type {
  CompraPriceMonitorItem,
  SimulationData,
} from "../_types";
import { CompraCompareView } from "./CompraCompareView";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn() },
}));

const data: SimulationData = {
  kpis: {
    totalRecebimentos: 100_000,
    previsaoGastos: 30_000,
    previsaoSaldo: 70_000,
  },
  recebimentosPorTipo: [],
  ambientes: [],
  porTipo: [],
  projecaoMensal: [
    { month: "2026-07", recebimentos: 100_000, despesas: 30_000 },
    { month: "2026-08", recebimentos: 0, despesas: 0 },
  ],
  savedValues: {},
};

const cashFlowEntries: CashFlowEntry[] = [
  {
    id: "expense-entry",
    expenseId: "expense-1",
    data: "2026-07-10",
    tipo: "DESPESA",
    valor: 30_000,
    status: "PLANEJADO",
    rollingBalance: 70_000,
    rollingBalanceRealizado: 100_000,
  },
];

const items: CompraPriceMonitorItem[] = [
  {
    id: "item-1",
    title: "Geladeira",
    lastBestPriceCents: 20_000,
    lastBestPrice: null,
    referencePriceCents: 25_000,
    isActive: true,
    monitoringEndDate: null,
  },
];

describe("CompraCompareView", () => {
  beforeEach(async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockResolvedValue({
      "scenario-a": { "monthly_excl|pm_item-1": "1" },
      "scenario-b": {
        "monthly_pay|pm_item-1|mode": "parcelado",
        "monthly_pay|pm_item-1|parcelas": "2",
        "monthly_pay|pm_item-1|inicio": "2026-07",
      },
    });
  });

  it("compara total planejado, saldo e impacto mensal de dois cenários", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <CompraCompareView
          projectId="project-1"
          scenarios={[
            {
              id: "scenario-a",
              name: "Sem produto",
              createdAt: "",
              updatedAt: "",
            },
            {
              id: "scenario-b",
              name: "Com produto",
              createdAt: "",
              updatedAt: "",
            },
          ]}
          compareIdA="scenario-a"
          compareIdB="scenario-b"
          setCompareIdA={vi.fn()}
          setCompareIdB={vi.fn()}
          baseData={data}
          cashFlowEntries={cashFlowEntries}
          items={items}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("R$ 300,00")).toBeInTheDocument();
    expect(screen.getAllByText("R$ 500,00")).toHaveLength(2);
    expect(screen.getByText("Total planejado")).toBeInTheDocument();
    expect(screen.getByText("Saldo projetado")).toBeInTheDocument();
    expect(screen.getByText("Impacto mensal")).toBeInTheDocument();
  });

  it("mostra erro explícito quando a comparação falha", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.get).mockRejectedValueOnce(new Error("network"));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <CompraCompareView
          projectId="project-1"
          scenarios={[
            { id: "scenario-a", name: "A", createdAt: "", updatedAt: "" },
            { id: "scenario-b", name: "B", createdAt: "", updatedAt: "" },
          ]}
          compareIdA="scenario-a"
          compareIdB="scenario-b"
          setCompareIdA={vi.fn()}
          setCompareIdB={vi.fn()}
          baseData={data}
          cashFlowEntries={cashFlowEntries}
          items={items}
        />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        "Não foi possível carregar a comparação. Tente novamente.",
      ),
    ).toBeInTheDocument();
  });
});
