import { describe, expect, it } from "vitest";
import { applyScenario, type ScenarioPoint } from "./scenarios";

function serieFixture(): ScenarioPoint[] {
  return [
    { mes: "2026-07", saldoProjetado: 640_000 },
    { mes: "2026-08", saldoProjetado: 490_000 },
    { mes: "2026-09", saldoProjetado: 310_000 },
  ];
}

describe("applyScenario", () => {
  it("returns integer-cent values equal to input plus delta*index", () => {
    const serie = serieFixture();
    const result = applyScenario(serie, 50_000);
    expect(result.map((r) => r.saldoProjetado)).toEqual([
      640_000, 540_000, 410_000,
    ]);
    expect(result.map((r) => r.mes)).toEqual(serie.map((r) => r.mes));
  });

  it.each([-50_000, 0, 50_000, 100_000])(
    "leaves the first point exactly unchanged for any delta (%d)",
    (delta) => {
      const serie = serieFixture();
      const result = applyScenario(serie, delta);
      expect(result[0]!.saldoProjetado).toBe(serie[0]!.saldoProjetado);
    },
  );

  it("delta=0 is an exact reset (deep-equal to input) but a different array reference", () => {
    const serie = serieFixture();
    const result = applyScenario(serie, 0);
    expect(result).toEqual(serie);
    expect(result).not.toBe(serie);
  });

  it("does not mutate the input series or its points", () => {
    const serie = serieFixture();
    Object.freeze(serie);
    Object.freeze(serie[0]);
    const snapshot = JSON.parse(JSON.stringify(serie));
    expect(() => applyScenario(serie, 50_000)).not.toThrow();
    expect(serie).toEqual(snapshot);
  });

  it("negative delta (worse scenario) reduces future points, boundary at crossing zero", () => {
    const serie: ScenarioPoint[] = [
      { mes: "m0", saldoProjetado: 100 },
      { mes: "m1", saldoProjetado: 100 },
    ];
    const result = applyScenario(serie, -100);
    expect(result[1]!.saldoProjetado).toBe(0);
  });

  it("accepts an empty series without throwing", () => {
    expect(applyScenario([], 50_000)).toEqual([]);
  });

  it("rounding must stay integer even for non-round deltas", () => {
    const serie = serieFixture();
    const result = applyScenario(serie, 333);
    for (const point of result) {
      expect(Number.isInteger(point.saldoProjetado)).toBe(true);
    }
  });
});
