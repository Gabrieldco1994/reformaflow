import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MonthComparison,
  MonthlyEntry,
  MonthlyOverviewResponse,
  MonthlyOverviewRow,
} from "../_types";
import type { DreSaldoAcumuladoRow } from "../../dre/_types";
import MobileMonthCockpit from "./MobileMonthCockpit";

const RUNWAY: DreSaldoAcumuladoRow[] = Array.from({ length: 6 }, (_, index) => ({
  mes: `2026-${String(index + 7).padStart(2, "0")}`,
  recebimentos: 0,
  despesas: 0,
  recebimentosRealizados: null,
  despesasRealizadas: null,
  saldoProjetado: 1_200_000 - index * 100_000,
  saldoRealizado: null,
}));

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MobileMonthCockpit
        data={overview}
        monthKey="2026-07"
        entries={overview.entries}
        projectId="pessoal-test"
        eixo="competencia"
        runwaySerie={RUNWAY}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("MobileMonthCockpit", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00-03:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps both heroes outside the outer accordion and wires its default state", () => {
    renderCockpit();
    const cockpit = screen.getByRole("region", {
      name: "Cockpit mensal mobile",
    });
    const hero = within(cockpit).getByRole("button", {
      name: "Mostrar valor exato",
    });
    // Renderizado FORA da section (irmão), de propósito: é `position: fixed` e
    // não pode herdar margin-top do `space-y-3` do cockpit (ver comentário no
    // componente) — por isso a busca é em `screen`, não `within(cockpit)`.
    const miniHero = screen.getByTestId("mini-hero-capsule");
    const expected = [["Consumo", "false"]] as const;

    for (const [name, expanded] of expected) {
      const trigger = within(cockpit).getByRole("button", { name });
      const panelId = trigger.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      expect(trigger).toHaveAttribute("aria-expanded", expanded);
      expect(trigger.contains(hero)).toBe(false);
      expect(trigger.contains(miniHero)).toBe(false);
    }
  });

  it("omits the time-travel scrubber outside the current month, keeps consumption accordion", () => {
    renderCockpit({ monthKey: "2026-06", entries: [] });
    expect(
      screen.queryByRole("slider", { name: "Ritmo diário projetado" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Consumo" })).toBeInTheDocument();
  });

  it("persists outer accordions per project and month and restores them", () => {
    const key = "lifeone:monthly:accordions:pessoal-test:2026-07";
    const first = renderCockpit();
    fireEvent.click(screen.getByRole("button", { name: "Consumo" }));
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
      consumption: true,
    });
    first.unmount();

    renderCockpit();
    expect(screen.getByRole("button", { name: "Consumo" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      localStorage.getItem("lifeone:monthly:accordions:pessoal-test:2026-06"),
    ).toBeNull();
  });

  it.each(["not-json", JSON.stringify({ details: true })])(
    "uses defaults for malformed or partial accordion storage: %s",
    (stored) => {
      localStorage.setItem(
        "lifeone:monthly:accordions:pessoal-test:2026-07",
        stored,
      );
      expect(() => renderCockpit()).not.toThrow();
      expect(screen.getByRole("button", { name: "Consumo" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    },
  );

  it("does not change canonical values while outer accordions toggle", () => {
    renderCockpit();
    const values = ["Entrou", "Saiu", "Projeção"].map(
      (name) => screen.getByRole("article", { name }).textContent,
    );
    for (const name of ["Consumo"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    expect(
      ["Entrou", "Saiu", "Projeção"].map(
        (name) => screen.getByRole("article", { name }).textContent,
      ),
    ).toEqual(values);
  });

  it("keeps canonical hero/support values and reveals the exact hero in one touch", () => {
    renderCockpit();
    const cockpit = screen.getByRole("region", {
      name: "Cockpit mensal mobile",
    });
    const hero = within(cockpit).getByTestId("mobile-hero-time-travel");

    expect(within(hero).getByText("Caixa hoje")).toBeInTheDocument();
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
    expect(within(hero).getByText("R$ 12.345,67")).toBeInTheDocument();
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
    const miniHero = screen.getByTestId("mini-hero-capsule");
    expect(miniHero).toHaveTextContent("Julho 2026");
    expect(miniHero).toHaveTextContent("R$ 12 mil");
    expect(miniHero).not.toHaveTextContent("R$ 9,9 mil");
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

  it("does not render the fluxo do mês scrubber in current or other months", () => {
    const { rerender } = renderCockpit();
    expect(
      screen.queryByRole("slider", { name: "Ritmo diário projetado" }),
    ).not.toBeInTheDocument();

    const overview = data();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={client}>
        <MobileMonthCockpit
          data={overview}
          monthKey="2026-06"
          entries={[]}
          projectId="pessoal-test"
          eixo="competencia"
        />
      </QueryClientProvider>,
    );

    expect(
      screen.queryByRole("slider", { name: "Ritmo diário projetado" }),
    ).not.toBeInTheDocument();
  });

  it("keeps canonical hero and consumption values stable without the fluxo block", () => {
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

    fireEvent.click(within(cockpit).getByRole("button", { name: "Consumo" }));

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

    const miniHero = screen.getByTestId("mini-hero-capsule");
    expect(miniHero).toHaveTextContent("Julho 2026");
    expect(miniHero).toHaveTextContent("R$ 12 mil");
  });

  it("keeps future month without swipe-to-pay section", () => {
    const future = entry({
      id: "known-future",
      data: "2026-08-20T12:00:00.000Z",
      status: "PLANEJADO",
      valor: 45_123,
    });
    renderCockpit({ monthKey: "2026-08", entries: [future] });
    expect(screen.queryByRole("region", { name: "Próximas saídas" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /pagar/i }),
    ).not.toBeInTheDocument();
  });

  it("uses the passed six-month runway, integrates scenarios and delta, and keeps the canonical hero unchanged", () => {
    renderCockpit();
    const runway = screen.getByRole("region", { name: "Vai dar até dez?" });
    const heroBefore = screen.getByRole("button", { name: "Mostrar valor exato" }).textContent;

    expect(within(runway).getAllByTestId(/runway-month/)).toHaveLength(6);
    expect(within(runway).getByRole("group", { name: "Cenários e se…?" })).toBeInTheDocument();
    fireEvent.click(within(runway).getByRole("button", { name: "gastar +500" }));
    expect(within(runway).getByTestId("scenario-delta")).toHaveTextContent("-R$ 500");
    expect(screen.getByRole("button", { name: "Mostrar valor exato" })).toHaveTextContent(heroBefore ?? "");
    expect(screen.queryByText(/desliza a curva projetada do herói acima/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: "Cenários e se…?" })).toHaveLength(1);
  });

  it("does not render an empty runway card when fewer than six months are available", () => {
    renderCockpit({ runwaySerie: RUNWAY.slice(0, 5) });
    expect(screen.queryByRole("region", { name: "Vai dar até dez?" })).not.toBeInTheDocument();
  });

  it("renders sections in the required mobile reading order", () => {
    renderCockpit();
    const sections = [
      screen.getByTestId("mobile-hero-time-travel"),
      screen.getByRole("region", { name: "Vai dar até dez?" }),
      screen.getByRole("region", { name: /maria percebeu/i }),
      screen.getByRole("button", { name: "Consumo" }),
    ];
    sections.slice(1).forEach((section, index) => {
      expect(sections[index]!.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it("removes sticky aside, fluxo do mês and vai sair copy from mobile cockpit", () => {
    renderCockpit();
    expect(screen.queryByRole("complementary", { name: "Resumo do mês atual" })).not.toBeInTheDocument();
    expect(screen.queryByText(/valores canônicos|client-side|inovação/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fluxo do mês/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/vai sair/i)).not.toBeInTheDocument();
  });

  it("always puts the other-month warning in the capsule while current-month visibility stays scroll-driven", () => {
    const other = renderCockpit({ monthKey: "2026-06", entries: [] });
    const capsule = screen.getByTestId("mini-hero-capsule");
    expect(capsule).toHaveTextContent("Julho 2026");
    expect(capsule).toHaveTextContent(/consultando junho 2026/i);
    other.unmount();

    renderCockpit();
    const currentCapsule = screen.getByTestId("mini-hero-capsule");
    expect(currentCapsule).toHaveAttribute("aria-hidden", "true");
    Object.defineProperty(window, "scrollY", { configurable: true, value: 300 });
    fireEvent.scroll(window);
    expect(currentCapsule).toHaveAttribute("aria-hidden", "false");
  });

  it("keeps the mobile cockpit behind the mobile-only class (md:hidden) — desktop unaffected", () => {
    renderCockpit();
    const cockpit = screen.getByRole("region", {
      name: "Cockpit mensal mobile",
    });
    expect(cockpit.className).toMatch(/\bmd:hidden\b/);
  });
});
