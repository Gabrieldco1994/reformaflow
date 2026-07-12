import { describe, expect, it } from "vitest";
import type { CategoriaBarra, ComprometimentoMes } from "../_cockpit/derive";
import { buildMariaStories } from "./insights";

function categoria(patch: Partial<CategoriaBarra> = {}): CategoriaBarra {
  return {
    categoria: "Mercado",
    valor: 100_000,
    cor: "#000000",
    pct: 1,
    ...patch,
  };
}

describe("buildMariaStories", () => {
  it("flags a category strictly above 15% of its monthly average", () => {
    const result = buildMariaStories({
      categorias: [categoria({ categoria: "Mercado", valor: 115_001 })],
      mediaMensalPorTipo: new Map([["Mercado", 100_000]]),
      comprometimento: [],
    });
    expect(result).toEqual([
      {
        kind: "categoria-alta",
        categoria: "Mercado",
        valorMes: 115_001,
        valorMedia: 100_000,
        deltaPct: expect.any(Number),
      },
    ]);
  });

  it("boundary: exactly 15% above is NOT flagged", () => {
    const result = buildMariaStories({
      categorias: [categoria({ categoria: "Mercado", valor: 115_000 })],
      mediaMensalPorTipo: new Map([["Mercado", 100_000]]),
      comprometimento: [],
    });
    expect(
      result.find((i) => i.kind === "categoria-alta"),
    ).toBeUndefined();
  });

  it("flags a category strictly below 15% of its average as economia", () => {
    const result = buildMariaStories({
      categorias: [categoria({ categoria: "Mercado", valor: 84_999 })],
      mediaMensalPorTipo: new Map([["Mercado", 100_000]]),
      comprometimento: [],
    });
    expect(result).toContainEqual({
      kind: "categoria-economia",
      categoria: "Mercado",
      valorMes: 84_999,
      valorMedia: 100_000,
      deltaPct: expect.any(Number),
    });
  });

  it("boundary: exactly 15% below is NOT flagged", () => {
    const result = buildMariaStories({
      categorias: [categoria({ categoria: "Mercado", valor: 85_000 })],
      mediaMensalPorTipo: new Map([["Mercado", 100_000]]),
      comprometimento: [],
    });
    expect(
      result.find((i) => i.kind === "categoria-economia"),
    ).toBeUndefined();
  });

  it("guards against zero/absent historical average (no div-by-zero, no insight)", () => {
    const result = buildMariaStories({
      categorias: [categoria({ categoria: "Novo", valor: 50_000 })],
      mediaMensalPorTipo: new Map(),
      comprometimento: [],
    });
    expect(result.length).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/null|NaN|Infinity/);
  });

  it("detects a parcela ending between two consecutive comprometimento months", () => {
    const comprometimento: ComprometimentoMes[] = [
      {
        mes: "2026-09",
        total: 200_000,
        itens: [
          {
            descricao: "Sofá 9/10",
            parcela: "9/10",
            cardLast4: "1234",
            valor: 64_000,
          },
          { descricao: "Outro", parcela: null, cardLast4: "1234", valor: 136_000 },
        ],
      },
      {
        mes: "2026-10",
        total: 136_000,
        itens: [
          { descricao: "Outro", parcela: null, cardLast4: "1234", valor: 136_000 },
        ],
      },
    ];
    const result = buildMariaStories({
      categorias: [],
      mediaMensalPorTipo: new Map(),
      comprometimento,
    });
    expect(result).toContainEqual({
      kind: "parcela-fim",
      mes: "2026-10",
      valorLiberado: 64_000,
      descricao: "Sofá 9/10",
    });
  });

  it.each([[[]], [[{ mes: "2026-09", total: 100, itens: [] }]]])(
    "comprometimento with 0 or 1 month never produces parcela-fim",
    (comprometimento) => {
      const result = buildMariaStories({
        categorias: [],
        mediaMensalPorTipo: new Map(),
        comprometimento: comprometimento as ComprometimentoMes[],
      });
      expect(result.filter((i) => i.kind === "parcela-fim")).toEqual([]);
    },
  );

  it("is deterministic: same input always yields same order and content", () => {
    const input = {
      categorias: [categoria({ categoria: "Mercado", valor: 120_000 })],
      mediaMensalPorTipo: new Map([["Mercado", 100_000]]),
      comprometimento: [
        { mes: "2026-09", total: 200_000, itens: [] },
        { mes: "2026-10", total: 100_000, itens: [] },
      ],
    };
    const a = buildMariaStories(input);
    const b = buildMariaStories(input);
    expect(a).toEqual(b);
  });

  it("returns an empty array, not an error, when nothing qualifies", () => {
    const result = buildMariaStories({
      categorias: [],
      mediaMensalPorTipo: new Map(),
      comprometimento: [],
    });
    expect(result).toEqual([]);
  });
});
