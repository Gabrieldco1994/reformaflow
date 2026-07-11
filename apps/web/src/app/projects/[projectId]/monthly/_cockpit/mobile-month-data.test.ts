import { describe, expect, it } from "vitest";
import type { MonthlyEntry } from "../_types";
import { buildMobileMonthData } from "./mobile-month-data";

let sequence = 0;

function entry(patch: Partial<MonthlyEntry> = {}): MonthlyEntry {
  sequence += 1;
  return {
    id: `entry-${sequence}`,
    data: "2026-07-10T12:00:00.000Z",
    tipo: "DESPESA",
    status: "PAGO",
    valor: 0,
    categoria: "Outros",
    subcategoria: null,
    formaPagamento: "PIX",
    projectId: "pessoal-test",
    projectName: "Pessoal Teste",
    projectType: "PESSOAL",
    isNeutral: false,
    isNeutralConsumo: false,
    isEspelho: false,
    ...patch,
  };
}

describe("buildMobileMonthData", () => {
  it("uses only realized consumption and conserves exact cents", () => {
    const result = buildMobileMonthData([
      entry({ valor: 10_001, categoria: "Mercado" }),
      entry({
        valor: 20_002,
        categoria: "Mercado",
        formaPagamento: "CARTAO_CREDITO",
      }),
      entry({ valor: 30_003, categoria: "Moradia" }),
      entry({ valor: 90_000, categoria: "Planejado", status: "PLANEJADO" }),
      entry({ valor: 80_000, categoria: "Espelho", isEspelho: true }),
      entry({ valor: 70_000, categoria: "Liquidação", isNeutral: true }),
      entry({
        valor: 60_000,
        categoria: "Investimento",
        isNeutralConsumo: true,
      }),
      entry({
        valor: 50_000,
        categoria: "Receita",
        tipo: "RECEBIMENTO",
        status: "EM_CAIXA",
      }),
    ]);

    expect(result).toEqual({
      realizedConsumptionCents: 60_006,
      realizedCategories: [
        { label: "Moradia", valueCents: 30_003 },
        { label: "Mercado", valueCents: 30_003 },
      ],
      isEmpty: false,
    });
    expect(
      result.realizedCategories.reduce(
        (sum: number, item: { valueCents: number }) => sum + item.valueCents,
        0,
      ),
    ).toBe(result.realizedConsumptionCents);
  });

  it("returns an honest empty contract when there is no realized consumption", () => {
    expect(
      buildMobileMonthData([
        entry({ status: "PLANEJADO", valor: 12_345 }),
        entry({ tipo: "RECEBIMENTO", status: "EM_CAIXA", valor: 67_890 }),
      ]),
    ).toEqual({
      realizedConsumptionCents: 0,
      realizedCategories: [],
      isEmpty: true,
    });
  });

  it("folds everything below top-N into Outros without losing one cent", () => {
    const result = buildMobileMonthData(
      [
        entry({ categoria: "A", valor: 10_007 }),
        entry({ categoria: "B", valor: 9_005 }),
        entry({ categoria: "C", valor: 8_003 }),
        entry({ categoria: "D", valor: 7_002 }),
        entry({ categoria: null, valor: 101 }),
      ],
      { topN: 3 },
    );

    expect(result.realizedCategories).toEqual([
      { label: "A", valueCents: 10_007 },
      { label: "B", valueCents: 9_005 },
      { label: "C", valueCents: 8_003 },
      { label: "Outros", valueCents: 7_103 },
    ]);
    expect(result.realizedConsumptionCents).toBe(34_118);
    expect(
      result.realizedCategories.reduce(
        (sum: number, item: { valueCents: number }) => sum + item.valueCents,
        0,
      ),
    ).toBe(34_118);
  });
});
