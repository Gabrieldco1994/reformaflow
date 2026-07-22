import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CashFlowEntry } from "@/types";
import type {
  CompraPriceMonitorItem,
  PayConfig,
  SimulationData,
} from "../_types";
import { CompraScenarioView } from "./CompraScenarioView";

vi.mock("../../price-compare/_components/ComprarAgoraModal", () => ({
  ComprarAgoraModal: ({ item }: { item: CompraPriceMonitorItem | null }) =>
    item ? <div data-testid="buy-modal">{item.title}</div> : null,
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

const entries: CashFlowEntry[] = [
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

function Harness() {
  const [excludes, setExcludes] = useState<Set<string>>(new Set());
  const [payConfigs, setPayConfigs] = useState<Record<string, PayConfig>>({});
  return (
    <CompraScenarioView
      projectId="project-1"
      data={data}
      cashFlowEntries={entries}
      items={items}
      itemsLoading={false}
      itemsError={false}
      excludes={excludes}
      setExcludes={setExcludes}
      payConfigs={payConfigs}
      setPayConfigs={setPayConfigs}
      scheduleSave={vi.fn()}
    />
  );
}

describe("CompraScenarioView", () => {
  it("inclui/exclui item e abre o Comprar agora existente", () => {
    render(<Harness />);

    expect(screen.getAllByText("R$ 500,00")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Incluído" }));
    expect(
      screen.getByRole("button", { name: "Excluído" }),
    ).toBeInTheDocument();
    expect(screen.getByText("R$ 300,00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Excluído" }));
    fireEvent.click(screen.getByRole("button", { name: /comprar agora/i }));
    expect(screen.getByTestId("buy-modal")).toHaveTextContent("Geladeira");
  });

  it("parcelamento altera o impacto mensal ao vivo", () => {
    render(<Harness />);

    fireEvent.change(screen.getByLabelText("Pagamento de Geladeira"), {
      target: { value: "parcelado" },
    });
    fireEvent.change(screen.getByLabelText("Parcelas de Geladeira"), {
      target: { value: "2" },
    });

    expect(screen.getAllByText("R$ 100,00").length).toBeGreaterThan(0);
  });
});
