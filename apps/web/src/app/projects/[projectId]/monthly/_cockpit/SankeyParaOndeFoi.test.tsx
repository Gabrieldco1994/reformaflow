import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CategoriaBarra } from "./derive";
import SankeyParaOndeFoi, { buildSankeyRibbons } from "./SankeyParaOndeFoi";

function categoria(patch: Partial<CategoriaBarra>): CategoriaBarra {
  return {
    categoria: "Cartões",
    valor: 410_000,
    cor: "#0A6CF0",
    pct: 1,
    ...patch,
  };
}

describe("buildSankeyRibbons", () => {
  it("maps CategoriaBarra[] into ribbon widths proportional to valor, summing to the total", () => {
    const categorias: CategoriaBarra[] = [
      categoria({ categoria: "Cartões", valor: 410_000 }),
      categoria({ categoria: "Casa fixas", valor: 320_000, cor: "#1E924A" }),
    ];
    const ribbons = buildSankeyRibbons(categorias, 800_000);
    const totalPct = ribbons.reduce((sum, r) => sum + r.pct, 0);
    expect(totalPct).toBeLessThanOrEqual(1);
    expect(ribbons.map((r) => r.valor)).toEqual([410_000, 320_000]);
  });

  it("falls back to the sum of categorias when entrouTotal is not positive", () => {
    const categorias: CategoriaBarra[] = [
      categoria({ categoria: "Cartões", valor: 100 }),
      categoria({ categoria: "Casa fixas", valor: 300 }),
    ];
    const ribbons = buildSankeyRibbons(categorias, 0);
    expect(ribbons.map((r) => r.pct)).toEqual([0.25, 0.75]);
  });
});

describe("SankeyParaOndeFoi", () => {
  it("boundary: an empty categorias list renders a 'no data' state, not a crash", () => {
    expect(() =>
      render(<SankeyParaOndeFoi categorias={[]} entrouTotal={0} />),
    ).not.toThrow();
    expect(
      screen.getByText(/sem gastos neste período/i),
    ).toBeInTheDocument();
  });

  it("clicking a ribbon calls onSelectCategoria with the exact categoria label", () => {
    const onSelectCategoria = vi.fn();
    render(
      <SankeyParaOndeFoi
        categorias={[categoria({ categoria: "Cartões", valor: 410_000 })]}
        entrouTotal={800_000}
        onSelectCategoria={onSelectCategoria}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Cartões/i }));
    expect(onSelectCategoria).toHaveBeenCalledWith("Cartões");
  });
});
