import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { MonthlyEntry, MonthlyOverviewResponse } from "../_types";
import {
  buildCaixaData,
  deriveCockpitTop,
  deriveTotals,
  deriveYear,
} from "./derive";
import FluxoCaixaAnualChart from "./FluxoCaixaAnualChart";

type ChartMonth = {
  receita: number;
  sobraAcumuladaReal: number;
  sobraAcumuladaRealPlus: number;
};
const chart = vi.hoisted(() => ({ data: [] as ChartMonth[] }));
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: ({ children }: { children: ReactNode }) => children,
  ComposedChart: ({ data }: { data: ChartMonth[] }) => {
    chart.data = data;
    return null;
  },
}));

const entry = (
  id: string,
  year: number,
  tipo: MonthlyEntry["tipo"],
  valor: number,
  patch: Partial<MonthlyEntry> = {},
): MonthlyEntry => ({
  id,
  data: `${year}-01-01T00:00:00.000Z`,
  tipo,
  valor,
  status: tipo === "RECEBIMENTO" ? "PREVISTO" : "PLANEJADO",
  categoria: null,
  subcategoria: null,
  formaPagamento: null,
  projectId: "pessoal",
  projectName: "Pessoal",
  projectType: "PESSOAL",
  ...patch,
});

const data = (entries: MonthlyEntry[]): MonthlyOverviewResponse => ({
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
    saldoInicial: 100_000,
    temSaldoInicial: true,
    carteiraHoje: 789,
    porMes: [{ mes: "2029-09", caixa: 123_456 }],
  },
});

const chain = () =>
  data([
    entry("prior", 2026, "RECEBIMENTO", 1_922_100),
    entry("income", 2027, "RECEBIMENTO", 26_829_000),
    entry("expense", 2027, "DESPESA", 7_822_000),
  ]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2029-09-24T16:31:13.000Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("annual automatic income", () => {
  it("carries the complete closing through successive years exactly once", () => {
    const d = chain();
    const y = deriveYear(d, 2027);

    expect(deriveYear(d, 2026).carryEntry).toBeNull();
    expect(y).toMatchObject({
      receitaAno: 28_751_100,
      despesaAno: 7_822_000,
      resultadoAno: 20_929_100,
      patrimonioInicioAno: 1_922_100,
      patrimonioFimAno: 20_929_100,
    });
    expect(y.carryEntry).toMatchObject({
      source: "YEAR_SURPLUS",
      sourceYear: 2026,
      kind: "entrada",
      id: null,
      bankLast4: null,
      status: "PREVISTO",
      data: "2027-01-01T00:00:00.000Z",
      valor: 1_922_100,
    });
    expect(y.meses).toHaveLength(12);
    expect(y.meses[0]).toMatchObject({
      rec: 28_751_100,
      desp: 7_822_000,
      sobra: 20_929_100,
      patrimonio: 20_929_100,
      sobraRealizada: 0,
    });
    expect(y.meses.slice(1).map((m) => m.rec)).toEqual(Array(11).fill(0));
    expect(y.meses.reduce((sum, m) => sum + m.sobra, 0)).toBe(20_929_100);
    expect(deriveYear(d, 2028).carryEntry?.valor).toBe(20_929_100);
    expect(deriveYear(d, 2029).carryEntry?.valor).toBe(20_929_100);
    expect(deriveYear(d, 2027)).toEqual(y);
  });

  it.each([-1, 0, 1])("handles a closing of %i centavos", (closing) => {
    const d = data([
      entry("income", 2026, "RECEBIMENTO", 100),
      entry("expense", 2026, "DESPESA", 100 - closing),
    ]);
    const next = deriveYear(d, 2027);
    expect(next.resultadoAno).toBe(Math.max(0, closing));
    if (closing > 0) {
      expect(next.carryEntry?.valor).toBe(1);
    } else {
      expect(next.carryEntry).toBeNull();
    }
  });

  it("recomputes the chain after decrease, deletion and a later deficit", () => {
    const d = chain();
    const changed = data(
      d.entries!.map((e) =>
        e.id === "prior" ? { ...e, valor: 1_000_000 } : e,
      ),
    );
    expect(deriveYear(changed, 2028).carryEntry?.valor).toBe(20_007_000);

    const deleted = data(d.entries!.filter((e) => e.id !== "prior"));
    expect(deriveYear(deleted, 2027).carryEntry).toBeNull();
    expect(deriveYear(deleted, 2028).carryEntry?.valor).toBe(19_007_000);

    const deficit = data(d.entries!.filter((e) => e.id !== "income"));
    expect(deriveYear(deficit, 2027).resultadoAno).toBe(-5_899_900);
    expect(deriveYear(deficit, 2028).carryEntry).toBeNull();
  });

  it("uses full entry history despite missing monthly ranges and empty years", () => {
    const d = data([
      entry("old", 2023, "RECEBIMENTO", 10_000),
      entry("new", 2027, "RECEBIMENTO", 500),
    ]);
    expect(deriveYear(d, 2027).carryEntry?.valor).toBe(10_000);
    expect(deriveYear(d, 2028).carryEntry?.valor).toBe(10_500);
    expect(deriveYear(data([]), 2028).carryEntry).toBeNull();
    expect(
      deriveYear({ ...d, entries: undefined }, 2028).carryEntry,
    ).toBeNull();
  });

  it("preserves consolidated mirror, neutral and additive-settlement rules", () => {
    const d = data([
      entry("income", 2026, "RECEBIMENTO", 100_000),
      entry("target", 2026, "DESPESA", 10_000, {
        projectId: "obra",
        projectType: "REFORMA",
      }),
      entry("mirror", 2026, "DESPESA", 10_000, { isEspelho: true }),
      entry("bank-source", 2026, "DESPESA", 20_000, {
        status: "PAGO",
        bankLast4: "1234",
      }),
      entry("paid-projection", 2026, "DESPESA", 20_000, {
        projectId: "obra",
        projectType: "REFORMA",
        status: "PAGO",
        isSettlementProjection: true,
      }),
      entry("remaining", 2026, "DESPESA", 30_000, {
        projectId: "obra",
        projectType: "REFORMA",
      }),
      entry("settlement", 2026, "DESPESA", 900_000, { isNeutral: true }),
      entry("investment", 2026, "DESPESA", 800_000, { isNeutralConsumo: true }),
      entry("redemption", 2026, "RECEBIMENTO", 700_000, {
        isNeutralConsumo: true,
      }),
    ]);
    expect(deriveYear(d, 2026).despesaAno).toBe(60_000);
    expect(deriveYear(d, 2027).carryEntry?.valor).toBe(40_000);
  });

  it("uses card due-year before calculating carry", () => {
    const d = data([
      entry("income", 2026, "RECEBIMENTO", 10_000),
      entry("card", 2026, "DESPESA", 4_000, {
        data: "2026-12-25T00:00:00.000Z",
        cardLast4: "1234",
      }),
    ]);
    d.cards = [{ last4: "1234", nickname: "Card", closingDay: 20, dueDay: 25 }];
    const cashAxis = buildCaixaData(d);

    expect(deriveYear(cashAxis, 2026).resultadoAno).toBe(10_000);
    expect(deriveYear(cashAxis, 2027)).toMatchObject({
      receitaAno: 10_000,
      despesaAno: 4_000,
      resultadoAno: 6_000,
    });
  });

  it("does not duplicate realized history as another opening base or mutate cash", () => {
    const d = chain();
    d.entries![0] = { ...d.entries![0]!, status: "EM_CAIXA" };
    const snapshot = structuredClone(d);
    const totals = deriveTotals(d);
    const top = deriveCockpitTop(d);

    for (const year of [2027, 2028, 2027, 2030]) deriveYear(d, year);

    expect(deriveYear(d, 2027).patrimonioFimAno).toBe(20_929_100);
    expect(d).toEqual(snapshot);
    expect(d.entries).toHaveLength(3);
    expect(deriveTotals(d)).toEqual(totals);
    expect(deriveCockpitTop(d)).toEqual(top);
    expect(d.caixa).toMatchObject({ hoje: 123_456, carteiraHoje: 789 });
  });

  it("excludes generated income from source history", () => {
    const d = chain();
    const carry = deriveYear(d, 2027).carryEntry!;
    const generated = {
      ...entry("generated", 2027, "RECEBIMENTO", carry.valor),
      source: carry.source,
    };
    const withDerived = data([...d.entries!, generated]);
    expect(deriveYear(withDerived, 2028)).toEqual(deriveYear(d, 2028));
  });

  it.each(["PREVISTO", "EM_CAIXA"])(
    "elapsed January carry never enters real accumulation (%s source income)",
    (status) => {
      const d = chain();
      d.entries![1] = { ...d.entries![1]!, status };
      const { rerender } = render(
        <FluxoCaixaAnualChart
          meses={deriveYear(d, 2027).meses}
          mode="acumuladaReal"
        />,
      );
      const realized = status === "EM_CAIXA" ? 268_290 : 0;
      expect(chart.data[0]).toMatchObject({
        receita: 287_511,
        sobraAcumuladaReal: realized,
      });
      expect(chart.data[11]).toMatchObject({
        sobraAcumuladaReal: realized,
        sobraAcumuladaRealPlus: 209_291,
      });

      d.entries![2] = { ...d.entries![2]!, status: "PAGO" };
      rerender(
        <FluxoCaixaAnualChart
          meses={deriveYear(d, 2027).meses}
          mode="acumuladaReal"
        />,
      );
      expect(chart.data[11]).toMatchObject({
        sobraAcumuladaReal: realized - 78_220,
        sobraAcumuladaRealPlus: 209_291,
      });
    },
  );
});
