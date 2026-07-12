import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MonthComparison,
  MonthlyEntry,
  MonthlyOverviewResponse,
  MonthlyOverviewRow,
} from "../_types";
import MobileMonthCockpit from "./MobileMonthCockpit";

const comparison: MonthComparison = {
  current: null,
  previous: null,
  deltaDespesas: 0,
  deltaDespesasPct: null,
  deltaRecebimentos: 0,
  deltaRecebimentosPct: null,
  deltaSaldo: 0,
};

function row(mes: string): MonthlyOverviewRow {
  return {
    mes,
    totalDespesas: 0,
    totalRecebimentos: 0,
    despesasRealizadas: 0,
    recebimentosRealizados: 0,
    saldoMes: 0,
    saldoMesRealizado: 0,
    porOrigem: {},
    porCategoria: [],
  };
}

function entry(patch: Partial<MonthlyEntry>): MonthlyEntry {
  return {
    id: "expense-realized",
    data: "2026-07-10T12:00:00.000Z",
    tipo: "DESPESA",
    status: "PAGO",
    valor: 200_014,
    categoria: "Mercado",
    subcategoria: null,
    formaPagamento: "CARTAO_CREDITO",
    projectId: "pessoal-test",
    projectName: "Pessoal Teste",
    projectType: "PESSOAL",
    isNeutral: false,
    isNeutralConsumo: false,
    isEspelho: false,
    ...patch,
  };
}

function data(
  patch: Partial<MonthlyOverviewResponse> = {},
): MonthlyOverviewResponse {
  const entries = [
    entry({}),
    entry({
      id: "receipt-realized",
      tipo: "RECEBIMENTO",
      status: "EM_CAIXA",
      valor: 300_025,
      categoria: "Salário",
      formaPagamento: "PIX",
    }),
    entry({
      id: "expense-planned",
      data: "2026-07-25T12:00:00.000Z",
      status: "PLANEJADO",
      valor: 50_007,
      categoria: "Moradia",
    }),
  ];
  return {
    mesAtual: "2026-07",
    meses: [row("2026-06"), row("2026-07"), row("2026-08")],
    comparativo: comparison,
    mesAtualEntries: entries,
    entries,
    projetos: [{ id: "pessoal-test", name: "Pessoal Teste", type: "PESSOAL" }],
    caixa: {
      hoje: 1_234_567,
      saldoInicial: 1_000_000,
      temSaldoInicial: true,
      porMes: [
        { mes: "2026-06", caixa: 1_000_000 },
        { mes: "2026-07", caixa: 1_234_567 },
      ],
    },
    projecao: {
      caixaHoje: 1_234_567,
      entrouMes: 300_025,
      saiuMes: 200_014,
      faltaPagarMes: 50_007,
      recebimentosPrevistosMes: 15_465,
      sobraPrevista: 1_200_025,
    },
    ...patch,
  };
}

function renderCockpit(
  props: Partial<React.ComponentProps<typeof MobileMonthCockpit>> = {},
) {
  const overview = data();
  return render(
    <MobileMonthCockpit
      data={overview}
      monthKey="2026-07"
      entries={overview.entries}
      projectId="pessoal-test"
      eixo="competencia"
      {...props}
    />,
  );
}

describe("MobileMonthCockpit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00-03:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps canonical hero/support values and reveals the exact hero in one touch", () => {
    renderCockpit();
    const cockpit = screen.getByRole("region", {
      name: "Cockpit mensal mobile",
    });

    expect(within(cockpit).getByText("Caixa hoje")).toBeInTheDocument();
    expect(
      within(cockpit).getByRole("button", { name: "Mostrar valor exato" }),
    ).toHaveTextContent("R$ 12 mil");
    expect(
      within(cockpit).getByRole("article", { name: "Entrou" }),
    ).toHaveTextContent("R$ 3 mil");
    expect(
      within(cockpit).getByRole("article", { name: "Saiu" }),
    ).toHaveTextContent("R$ 2 mil");
    expect(
      within(cockpit).getByRole("article", { name: "Projeção" }),
    ).toHaveTextContent("R$ 12 mil");

    fireEvent.click(
      within(cockpit).getByRole("button", { name: "Mostrar valor exato" }),
    );
    expect(within(cockpit).getByText("R$ 12.345,67")).toBeInTheDocument();
  });

  it("forwards the selected month and keeps its exact canonical values separate from the current-month mini hero", () => {
    const overview = data({
      projecao: {
        status: "canonical",
        mes: "2026-06",
        caixaHoje: 1_234_567,
        entrouMes: 456_789,
        saiuMes: 123_456,
        faltaPagarMes: 7_891,
        recebimentosPrevistosMes: 2_345,
        sobraPrevista: 987_654,
      },
    });
    renderCockpit({ data: overview, monthKey: "2026-06", entries: [] });
    expect(screen.getByRole("article", { name: "Entrou" })).toHaveTextContent(
      "R$ 4,6 mil",
    );
    expect(screen.getByRole("article", { name: "Saiu" })).toHaveTextContent(
      "R$ 1,2 mil",
    );
    expect(screen.getByRole("article", { name: "Projeção" })).toHaveTextContent(
      "R$ 9,9 mil",
    );
    const miniHero = screen.getByRole("complementary", {
      name: "Resumo do mês atual",
    });
    expect(miniHero).toHaveTextContent("Julho 2026");
    expect(miniHero).toHaveTextContent("R$ 12 mil");
    expect(miniHero).not.toHaveTextContent("R$ 9,9 mil");
  });

  it("wires each disclosure to its controlled panel and keeps details one interaction away", () => {
    renderCockpit();
    for (const name of ["Análise do mês", "Próximas saídas conhecidas"]) {
      const trigger = screen.getByRole("button", { name });
      const panelId = trigger.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(document.getElementById(panelId!)).not.toBeInTheDocument();
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(document.getElementById(panelId!)).toBeInTheDocument();
    }
  });

  it("uses reduced-motion-safe disclosure animation and touch-sized controls", () => {
    renderCockpit();
    const disclosure = screen.getByRole("button", { name: "Análise do mês" });
    expect(disclosure.className).toContain("min-h-[56px]");
    expect(disclosure.querySelector("svg")?.className.baseVal).toContain(
      "motion-reduce:transition-none",
    );
    expect(
      screen.getByRole("slider", { name: "Ritmo diário projetado" }).className,
    ).toContain("min-h-[44px]");
  });

  it("uses the honest fallback label when the account has no opening balance", () => {
    const overview = data({
      caixa: {
        hoje: 100_011,
        saldoInicial: 0,
        temSaldoInicial: false,
        porMes: [],
      },
    });
    renderCockpit({ data: overview, entries: overview.entries });

    expect(screen.getByText("Resultado realizado")).toBeInTheDocument();
    expect(screen.queryByText("Caixa hoje")).not.toBeInTheDocument();
  });

  it("offers the scrubber only for the current month with honest simulation language", () => {
    const { rerender } = renderCockpit();
    const scrubber = screen.getByRole("slider", {
      name: "Ritmo diário projetado",
    });
    expect(scrubber).toBeInTheDocument();
    expect(screen.getAllByText(/realizado/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/projetado/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/inclui cartão/i).length).toBeGreaterThan(0);

    const overview = data();
    rerender(
      <MobileMonthCockpit
        data={overview}
        monthKey="2026-06"
        entries={[]}
        projectId="pessoal-test"
        eixo="competencia"
      />,
    );
    expect(
      screen.queryByRole("slider", { name: "Ritmo diário projetado" }),
    ).not.toBeInTheDocument();
  });

  it("opens analysis in one touch and preserves disclosure state while browsing months", () => {
    const { rerender } = renderCockpit();
    const disclosure = screen.getByRole("button", { name: "Análise do mês" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");

    const overview = data();
    rerender(
      <MobileMonthCockpit
        data={overview}
        monthKey="2026-06"
        entries={[]}
        projectId="pessoal-test"
        eixo="competencia"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Análise do mês" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("does not let scrubbing mutate canonical hero, projection, or realized flow", () => {
    renderCockpit();
    const cockpit = screen.getByRole("region", {
      name: "Cockpit mensal mobile",
    });
    const canonical = ["Entrou", "Saiu", "Projeção"].map(
      (name) => within(cockpit).getByRole("article", { name }).textContent,
    );
    const hero = within(cockpit).getByRole("button", {
      name: "Mostrar valor exato",
    }).textContent;

    fireEvent.change(
      within(cockpit).getByRole("slider", { name: "Ritmo diário projetado" }),
      {
        target: { value: "0" },
      },
    );

    expect(
      within(cockpit).getByRole("button", { name: "Mostrar valor exato" }),
    ).toHaveTextContent(hero ?? "");
    expect(
      ["Entrou", "Saiu", "Projeção"].map(
        (name) => within(cockpit).getByRole("article", { name }).textContent,
      ),
    ).toEqual(canonical);
    expect(
      within(cockpit).getByRole("article", { name: "Consumo realizado" }),
    ).toHaveTextContent("R$ 2 mil");
  });

  it("keeps the current-month mini hero identifiable while another month is open", () => {
    renderCockpit({ monthKey: "2026-06", entries: [] });

    const miniHero = screen.getByRole("complementary", {
      name: "Resumo do mês atual",
    });
    expect(miniHero).toHaveTextContent("Julho 2026");
    expect(miniHero).toHaveTextContent("R$ 12 mil");
  });

  it("marks known future entries as incomplete and read-only", () => {
    const future = entry({
      id: "known-future",
      data: "2026-08-20T12:00:00.000Z",
      status: "PLANEJADO",
      valor: 45_123,
    });
    renderCockpit({ monthKey: "2026-08", entries: [future] });

    expect(
      screen.getByRole("note", { name: "Mês futuro incompleto" }),
    ).toBeInTheDocument();
    expect(screen.getByText("R$ 451,23")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /pagar/i }),
    ).not.toBeInTheDocument();
  });

  it("does not fabricate deferred scenarios, Sankey, mutations, or Maria insights", () => {
    renderCockpit();

    expect(
      screen.queryByRole("button", { name: /cenário/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /pagar/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/sankey/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/maria/i)).not.toBeInTheDocument();
  });
});
