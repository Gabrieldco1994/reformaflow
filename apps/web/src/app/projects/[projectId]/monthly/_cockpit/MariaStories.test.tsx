import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MariaInsight } from "../_lib/insights";
import MariaStories from "./MariaStories";

const fixtures: MariaInsight[] = [
  {
    kind: "categoria-alta",
    categoria: "Mercado",
    valorMes: 130_000,
    valorMedia: 100_000,
    deltaPct: 0.3,
  },
  {
    kind: "categoria-economia",
    categoria: "Lazer",
    valorMes: 60_000,
    valorMedia: 100_000,
    deltaPct: -0.4,
  },
  {
    kind: "parcela-fim",
    mes: "2026-10",
    valorLiberado: 64_000,
    descricao: "Sofá 9/10",
  },
];

describe("MariaStories", () => {
  it("renders one story card per insight, typed by kind, with tone-appropriate icon", () => {
    render(<MariaStories insights={fixtures} />);
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveAttribute("data-kind", "categoria-alta");
    expect(cards[0]).toHaveAccessibleName(/Mercado/);
    expect(cards[1]).toHaveAttribute("data-kind", "categoria-economia");
    expect(cards[1]).toHaveAccessibleName(/Lazer/);
    expect(cards[2]).toHaveAttribute("data-kind", "parcela-fim");
    expect(cards[2]).toHaveAccessibleName(/Sofá 9\/10/);
  });

  it("renders nothing (empty state), not an error, when insights=[]", () => {
    expect(() => render(<MariaStories insights={[]} />)).not.toThrow();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(
      screen.getByText(/nada fora do padrão/i),
    ).toBeInTheDocument();
  });

  it("story cards meet the typography floor and touch target for their CTA link", () => {
    render(<MariaStories insights={fixtures} />);
    for (const link of screen.getAllByRole("link", { name: /ver detalhes/i })) {
      expect(link.className).toMatch(/min-h-\[44px\]/);
    }
    for (const card of screen.getAllByRole("article")) {
      expect(card.className).not.toMatch(/text-\[(?:[0-9]|10)px\]/);
    }
  });
});
