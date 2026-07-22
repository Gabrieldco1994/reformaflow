import { describe, expect, it } from "vitest";
import type { CashFlowEntry } from "@/types";
import type { CompraPriceMonitorItem, SimulationData } from "../_types";
import {
  calculateCompraScenario,
  effectivePriceCents,
  parseCompraScenarioValues,
  priceMonitorScenarioId,
} from "./compra-scenario";

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
    { month: "2026-09", recebimentos: 0, despesas: 0 },
  ],
  savedValues: {},
};

const cashFlowEntries: CashFlowEntry[] = [
  {
    id: "receipt-1",
    data: "2026-07-05",
    tipo: "RECEBIMENTO",
    valor: 100_000,
    status: "EM_CAIXA",
    rollingBalance: 100_000,
    rollingBalanceRealizado: 100_000,
  },
  {
    id: "entry-1",
    expenseId: "expense-1",
    data: "2026-07-10",
    tipo: "DESPESA",
    valor: 30_000,
    status: "PLANEJADO",
    rollingBalance: 70_000,
    rollingBalanceRealizado: 100_000,
  },
];

const item: CompraPriceMonitorItem = {
  id: "item-1",
  title: "Geladeira",
  lastBestPriceCents: 10_001,
  lastBestPrice: null,
  referencePriceCents: 12_000,
  isActive: true,
  monitoringEndDate: null,
};

describe("cenários financeiros de COMPRA", () => {
  it("garante horizonte de 12 meses para não perder parcelas", () => {
    const shortData = {
      ...data,
      projecaoMensal: data.projecaoMensal.slice(0, 2),
    };
    const metrics = calculateCompraScenario({
      data: shortData,
      cashFlowEntries,
      items: [item],
      excludes: new Set(),
      payConfigs: {
        [priceMonitorScenarioId(item.id)]: {
          mode: "parcelado",
          parcelas: "12",
          inicio: "2026-07",
          valor: "",
        },
      },
      now: new Date("2026-07-01T00:00:00.000Z"),
    });

    expect(metrics.monthList).toHaveLength(12);
    expect(
      Object.values(metrics.monthlyProductExpenses).reduce(
        (sum, value) => sum + value,
        0,
      ),
    ).toBe(10_001);
  });

  it("usa melhor preço em centavos e faz fallback para preço legado/referência", () => {
    expect(effectivePriceCents(item)).toBe(10_001);
    expect(
      effectivePriceCents({
        ...item,
        lastBestPriceCents: null,
        lastBestPrice: 99.9,
      }),
    ).toBe(9_990);
    expect(
      effectivePriceCents({
        ...item,
        lastBestPriceCents: null,
        lastBestPrice: null,
      }),
    ).toBe(12_000);
  });

  it("reutiliza o motor mensal e preserva a soma exata ao parcelar", () => {
    const metrics = calculateCompraScenario({
      data,
      cashFlowEntries,
      items: [item],
      excludes: new Set(),
      payConfigs: {
        [priceMonitorScenarioId(item.id)]: {
          mode: "parcelado",
          parcelas: "3",
          inicio: "2026-07",
          valor: "",
        },
      },
      now: new Date("2026-07-01T00:00:00.000Z"),
    });

    expect(metrics.monthlyProductExpenses).toEqual(expect.objectContaining({
      "2026-07": 3_333,
      "2026-08": 3_333,
      "2026-09": 3_335,
    }));
    expect(
      Object.values(metrics.monthlyProductExpenses).reduce(
        (sum, value) => sum + value,
        0,
      ),
    ).toBe(10_001);
    expect(metrics.totalPlanejadoCents).toBe(40_001);
    expect(metrics.saldoProjetadoCents).toBe(59_999);
    expect(metrics.impactoMensalCents).toBe(3_335);
  });

  it("exclui produto por cenário sem remover a despesa real", () => {
    const metrics = calculateCompraScenario({
      data,
      cashFlowEntries,
      items: [item],
      excludes: new Set([priceMonitorScenarioId(item.id)]),
      payConfigs: {},
      now: new Date("2026-07-01T00:00:00.000Z"),
    });

    expect(metrics.totalPlanejadoCents).toBe(30_000);
    expect(metrics.includedProductCount).toBe(0);
  });

  it("reconstitui exclusões e pagamento a partir de SimulationValue", () => {
    expect(
      parseCompraScenarioValues({
        "monthly_excl|pm_item-1": "1",
        "monthly_pay|pm_item-2|mode": "parcelado",
        "monthly_pay|pm_item-2|parcelas": "6",
        "monthly_pay|pm_item-2|inicio": "2026-09",
      }),
    ).toEqual({
      excludes: new Set(["pm_item-1"]),
      payConfigs: {
        "pm_item-2": {
          mode: "parcelado",
          parcelas: "6",
          inicio: "2026-09",
          valor: "",
        },
      },
    });
  });
});
