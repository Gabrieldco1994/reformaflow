import type { ComponentProps, ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { MovimentacaoRow } from "../../conta/_components/MovimentacaoRow";
import type { MonthlyEntry, MonthlyOverviewResponse } from "../_types";
import {
  buildCaixaData,
  deriveCockpitTop,
  deriveTotals,
  deriveYear,
} from "./derive";
import FluxoCaixaAnualChart from "./FluxoCaixaAnualChart";
import YearView from "./YearView";

type RowProps = ComponentProps<typeof MovimentacaoRow>;
type ChartPoint = {
  receita: number;
  despesa: number;
  sobraAcumuladaReal: number;
  sobraAcumuladaRealPlus: number;
};

const probes = vi.hoisted(() => ({
  chart: vi.fn(),
  row: vi.fn(),
  action: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./CategoriasBarras", () => ({ default: () => null }));
vi.mock("./CategoriaDespesasModal", () => ({ default: () => null }));
vi.mock("./ArvoreGastos", () => ({ default: () => null }));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => children,
  ComposedChart: ({ data }: { data: ChartPoint[] }) => {
    probes.chart(data);
    return null;
  },
  Bar: () => null,
  Line: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));
vi.mock("../../conta/_components/MovimentacaoRow", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../conta/_components/MovimentacaoRow")
    >();
  return {
    ...actual,
    MovimentacaoRow: (props: RowProps) => {
      probes.row(props);
      // Observe callbacks, but render the real row and execute its real handlers.
      return (
        <div data-testid="annual-income-row">
          <actual.MovimentacaoRow
            {...props}
            onEditReceita={(item) => {
              probes.action("edit", item);
              props.onEditReceita(item);
            }}
            onToggleReceita={(id, status) => {
              probes.action("receive", id, status);
              props.onToggleReceita(id, status);
            }}
            onRemoveReceita={(id) => {
              probes.action("delete", id);
              props.onRemoveReceita(id);
            }}
          />
        </div>
      );
    },
  };
});

function entry(
  id: string,
  data: string,
  tipo: MonthlyEntry["tipo"],
  valor: number,
  patch: Partial<MonthlyEntry> = {},
): MonthlyEntry {
  return {
    id,
    data: `${data}T00:00:00.000Z`,
    tipo,
    valor,
    status: tipo === "RECEBIMENTO" ? "PREVISTO" : "PLANEJADO",
    categoria: null,
    subcategoria: null,
    formaPagamento: null,
    projectId: "pessoal-a",
    projectName: "Pessoal A",
    projectType: "PESSOAL",
    ...patch,
  };
}

function overview(entries: MonthlyEntry[]): MonthlyOverviewResponse {
  return {
    mesAtual: "2029-09",
    entries,
    meses: [],
    mesAtualEntries: [],
    projetos: [],
    cards: [],
    comparativo: {
      current: null,
      previous: null,
      deltaDespesas: 0,
      deltaDespesasPct: null,
      deltaRecebimentos: 0,
      deltaRecebimentosPct: null,
      deltaSaldo: 0,
    },
    caixa: {
      hoje: 123_456,
      saldoInicial: 98_765,
      temSaldoInicial: true,
      carteiraHoje: 321,
      porMes: [{ mes: "2029-09", caixa: 123_456 }],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2029-09-24T12:00:00.000Z"));
  vi.mocked(api.get).mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("#707 annual carry adversarial boundaries", () => {
  it.each([
    { expense: 101, closing: -1, carry: null },
    { expense: 100, closing: 0, carry: null },
    { expense: 99, closing: 1, carry: { valor: 1 } },
  ])(
    "clips only after combining carried 100 with expense $expense",
    ({ expense, closing, carry }) => {
      const data = overview([
        entry("opening", "2025-12-31", "RECEBIMENTO", 100),
        entry("expense", "2026-12-31", "DESPESA", expense),
      ]);
      expect(deriveYear(data, 2026)).toMatchObject({
        carryEntry: { valor: 100, sourceYear: 2025 },
        receitaAno: 100,
        despesaAno: expense,
        resultadoAno: closing,
        patrimonioInicioAno: 100,
        patrimonioFimAno: closing,
      });
      expect(deriveYear(data, 2027)).toMatchObject({ carryEntry: carry });
    },
  );

  it("does not carry historical debt into a later positive first cent", () => {
    const data = overview([
      entry("loss", "2023-01-01", "DESPESA", 101, { status: "PAGO" }),
      entry("recovery", "2025-01-01", "RECEBIMENTO", 1, { status: "EM_CAIXA" }),
    ]);
    expect(deriveYear(data, 2025)).toMatchObject({
      carryEntry: null,
      resultadoAno: 1,
      patrimonioInicioAno: 0,
      patrimonioFimAno: 1,
    });
    expect(deriveYear(data, 2026)).toMatchObject({
      carryEntry: { valor: 1, sourceYear: 2025 },
      receitaAno: 1,
      resultadoAno: 1,
    });
  });

  it("propagates across more than 600 empty months independently of selection and entry order", () => {
    const data = overview([
      entry("later-debit", "2031-12-31", "DESPESA", 6),
      entry("old-centavos", "1970-12-31", "RECEBIMENTO", 7),
    ]);
    const snapshot = structuredClone(data);
    for (const source of data.entries!) Object.freeze(source);
    Object.freeze(data.entries);
    Object.freeze(data.meses);
    Object.freeze(data.mesAtualEntries);
    Object.freeze(data);
    const totals = deriveTotals(data);
    const top = deriveCockpitTop(data);

    expect(deriveYear(data, 2032)).toMatchObject({
      carryEntry: { valor: 1, sourceYear: 2031 },
      receitaAno: 1,
      patrimonioFimAno: 1,
    });
    expect(deriveYear(data, 1970)).toMatchObject({
      carryEntry: null,
      resultadoAno: 7,
    });
    expect(deriveYear({ ...data, mesAtual: "2030-01" }, 2030)).toMatchObject({
      carryEntry: { valor: 7, sourceYear: 2029 },
      receitaAno: 7,
      patrimonioFimAno: 7,
    });
    expect(deriveYear(data, 2032)).toEqual(
      deriveYear(overview([...data.entries!].reverse()), 2032),
    );
    expect(data).toEqual(snapshot);
    expect(data.entries).toHaveLength(2);
    expect(deriveTotals(data)).toEqual(totals);
    expect(deriveCockpitTop(data)).toEqual(top);
    expect(data.caixa).toEqual(snapshot.caixa);
  });

  it("cannot reconstruct carry from summary or current-month rows when history is absent", () => {
    const data = buildCaixaData(
      overview([entry("summary-only", "2025-12-31", "RECEBIMENTO", 999_999)]),
    );
    data.entries = undefined;
    data.mesAtualEntries = [
      entry("current-only", "2026-01-01", "RECEBIMENTO", 888_888),
    ];
    expect(data.meses).toHaveLength(1);
    expect(deriveYear(data, 2026)).toMatchObject({
      carryEntry: null,
      receitaAno: 0,
      despesaAno: 0,
      resultadoAno: 0,
      patrimonioInicioAno: 0,
      patrimonioFimAno: 0,
    });
  });

  it("excludes neutral fallback enums and paid projections without modifying reconciled cash", () => {
    const data = overview([
      entry("income", "2025-06-01", "RECEBIMENTO", 10_001, {
        status: "EM_CAIXA",
      }),
      entry("bank-debit", "2025-06-02", "DESPESA", 4_000, {
        status: "PAGO",
        bankLast4: "1234",
      }),
      entry("target", "2025-06-02", "DESPESA", 4_000, {
        status: "PAGO",
        isSettlementProjection: true,
      }),
      entry("mirror", "2025-06-02", "DESPESA", 4_000, { isEspelho: true }),
      entry("investment", "2025-06-03", "DESPESA", 900_000, {
        tipoDespesaCodigo: "INVESTIMENTOS",
        status: "PAGO",
        bankLast4: "1234",
      }),
      entry("redemption", "2025-06-04", "RECEBIMENTO", 800_000, {
        isNeutralConsumo: true,
        status: "EM_CAIXA",
        bankLast4: "1234",
      }),
      entry("internal", "2025-06-05", "DESPESA", 700_000, {
        tipoDespesaCodigo: "MOVIMENTACAO_INTERNA",
        status: "PAGO",
      }),
    ]);
    const snapshot = structuredClone(data);
    const cash = buildCaixaData(data);
    expect(deriveYear(cash, 2025)).toMatchObject({
      receitaAno: 10_001,
      despesaAno: 4_000,
      resultadoAno: 6_001,
    });
    const next = deriveYear(cash, 2026);
    expect(next).toMatchObject({
      carryEntry: { valor: 6_001, status: "PREVISTO", bankLast4: null },
      patrimonioInicioAno: 6_001,
      patrimonioFimAno: 6_001,
      resultadoAno: 6_001,
    });
    expect(data).toEqual(snapshot);
    expect(cash.caixa).toEqual(snapshot.caixa);
    expect(cash.entries).toHaveLength(7);
  });

  it("uses the exact closing-day boundary before assigning the annual carry", () => {
    const data = overview([
      entry("income", "2025-12-01", "RECEBIMENTO", 10_000),
      entry("before-close", "2025-12-19", "DESPESA", 2_000, {
        cardLast4: "1234",
      }),
      entry("on-close", "2025-12-20", "DESPESA", 3_000, { cardLast4: "1234" }),
    ]);
    data.cards = [
      { last4: "1234", nickname: "Card", closingDay: 20, dueDay: 25 },
    ];
    const snapshot = structuredClone(data);
    const cash = buildCaixaData(data);
    expect(cash.entries!.map(({ id, data }) => ({ id, data }))).toEqual([
      { id: "income", data: "2025-12-01T00:00:00.000Z" },
      { id: "before-close", data: "2025-12-25T00:00:00.000Z" },
      { id: "on-close", data: "2026-01-25T00:00:00.000Z" },
    ]);
    expect(deriveYear(cash, 2026)).toMatchObject({
      carryEntry: { valor: 8_000 },
      receitaAno: 8_000,
      despesaAno: 3_000,
      resultadoAno: 5_000,
      patrimonioInicioAno: 8_000,
      patrimonioFimAno: 5_000,
    });
    expect(deriveYear(cash, 2027)).toMatchObject({
      carryEntry: { valor: 5_000 },
    });
    expect(data).toEqual(snapshot);
  });
});

describe("#707 real annual chart", () => {
  it.each(["2025-01", "2027-01", "2029-09"])(
    "uses statuses, not month age (%s), for realized accumulation",
    (mesAtual) => {
      const data = overview([
        entry("prior", "2025-01-01", "RECEBIMENTO", 10_000, {
          status: "EM_CAIXA",
        }),
        entry("received", "2026-01-01", "RECEBIMENTO", 2_500, {
          status: "EM_CAIXA",
        }),
        entry("forecast", "2026-01-01", "RECEBIMENTO", 700),
        entry("paid", "2026-01-01", "DESPESA", 1_000, { status: "PAGO" }),
        entry("planned", "2026-01-01", "DESPESA", 500),
        entry("later-paid", "2026-12-01", "DESPESA", 200, { status: "PAGO" }),
      ]);
      data.mesAtual = mesAtual;
      const year = deriveYear(data, 2026);
      render(<FluxoCaixaAnualChart meses={year.meses} mode="acumuladaReal" />);
      const points = probes.chart.mock.lastCall![0] as ChartPoint[];
      expect(points).toHaveLength(12);
      expect(points[0]).toMatchObject({
        receita: 132,
        despesa: 15,
        sobraAcumuladaReal: 15,
        sobraAcumuladaRealPlus: 117,
      });
      expect(points[11]).toMatchObject({
        sobraAcumuladaReal: 13,
        sobraAcumuladaRealPlus: 115,
      });
      expect(year.meses[0]).toMatchObject({ sobraRealizada: 1_500 });
      expect(year.meses[11]).toMatchObject({ sobraRealizada: -200 });
      expect(year.receitaAno).toBe(13_200);
      expect(year.meses.reduce((sum, month) => sum + month.rec, 0)).toBe(
        13_200,
      );
      expect(year.meses.slice(1).map((month) => month.rec)).toEqual(
        Array(11).fill(0),
      );
      expect(year.resultadoAno).toBe(11_500);
    },
  );
});

describe("#707 actual YearView and MovimentacaoRow", () => {
  it("replaces carry on year and server-scoped payload changes without executable receipt actions or PATCHes", () => {
    // These are already-authorized server responses, not a frontend ACL simulation.
    const fullScope = overview([
      entry("same-id", "2025-01-01", "RECEBIMENTO", 1_001),
      entry("authorized-project", "2025-02-01", "RECEBIMENTO", 2_000, {
        projectId: "obra-a",
        projectType: "REFORMA",
      }),
      entry("expense", "2026-01-01", "DESPESA", 1_000),
    ]);
    const restrictedScope = overview([fullScope.entries![0]!]);
    const otherActor = overview([
      entry("same-id", "2025-01-01", "RECEBIMENTO", 7, {
        projectId: "pessoal-b",
      }),
    ]);
    const snapshots = structuredClone([fullScope, restrictedScope, otherActor]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    client.setQueryData(["monthly-overview", "pessoal-a", null], fullScope);
    client.setQueryData(["monthly-overview", "pessoal-b", null], otherActor);
    const view = (
      data: MonthlyOverviewResponse,
      year: number,
      projectId: string,
    ) => (
      <QueryClientProvider client={client}>
        <YearView data={data} year={year} projectId={projectId} />
      </QueryClientProvider>
    );
    const rendered = render(view(fullScope, 2026, "pessoal-a"));
    try {
      for (const [data, year, projectId, valor, sourceYear] of [
        [fullScope, 2026, "pessoal-a", 3_001, 2025],
        [fullScope, 2027, "pessoal-a", 2_001, 2026],
        [restrictedScope, 2026, "pessoal-a", 1_001, 2025],
        [otherActor, 2026, "pessoal-b", 7, 2025],
        [fullScope, 2026, "pessoal-a", 3_001, 2025],
      ] as const) {
        probes.row.mockClear();
        rendered.rerender(view(data, year, projectId));
        expect(probes.row).toHaveBeenCalledTimes(1);
        const props = probes.row.mock.lastCall![0] as RowProps;
        expect(props.item).toMatchObject({
          source: "YEAR_SURPLUS",
          sourceYear,
          kind: "entrada",
          id: null,
          bankLast4: null,
          status: "PREVISTO",
          valor,
          data: `${year}-01-01T00:00:00.000Z`,
        });
        expect(props.onShowDetail).toBeUndefined();
        const row = screen.getByTestId("annual-income-row");
        for (const button of within(row).queryAllByRole("button"))
          fireEvent.click(button);
        expect(probes.action).not.toHaveBeenCalled();
      }
      expect([fullScope, restrictedScope, otherActor]).toEqual(snapshots);
      expect(
        client.getQueryData(["monthly-overview", "pessoal-a", null]),
      ).toEqual(snapshots[0]);
      expect(
        client.getQueryData(["monthly-overview", "pessoal-b", null]),
      ).toEqual(snapshots[2]);
      for (const write of [api.post, api.put, api.patch, api.delete]) {
        expect(write).not.toHaveBeenCalled();
      }
    } finally {
      rendered.unmount();
      client.clear();
    }
  });
});
