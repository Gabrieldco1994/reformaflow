import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CockpitTopDerived, DiaSaldo } from "./derive";
import HeroTimeTravel from "./HeroTimeTravel";

function top(patch: Partial<CockpitTopDerived> = {}): CockpitTopDerived {
  return {
    caixaValor: 1_234_567,
    caixaReal: true,
    caixaDelta: 0,
    caixaSpark: [],
    resultadoMes: 100_011,
    resultadoEntrou: 300_025,
    resultadoGastou: 200_014,
    resultadoDeltaPct: null,
    entrouMes: 300_025,
    saidaJaSaiu: 200_014,
    saidaVaiSair: 50_007,
    saidaTotal: 250_021,
    projecaoMes: 1_200_025,
    aReceberMes: 15_465,
    aPagarMes: 50_007,
    mesAtualKey: "2026-07",
    pctMesDecorrido: 0.5,
    projectionSource: "canonical",
    projectionDegraded: false,
    ...patch,
  };
}

function series(): DiaSaldo[] {
  return [
    { dia: 1, realizado: 1_000_00, projetado: 1_000_00 },
    { dia: 2, realizado: null, projetado: 0 },
    { dia: 3, realizado: null, projetado: -1_00 },
  ];
}

function renderHero(overrides: Partial<React.ComponentProps<typeof HeroTimeTravel>> = {}) {
  return render(
    <HeroTimeTravel
      top={top()}
      series={series()}
      hoje={1}
      diasNoMes={3}
      showTimeTravel
      {...overrides}
    />,
  );
}

describe("HeroTimeTravel", () => {
  it("renders the canonical real-cash headline unchanged at every scrub position", () => {
    renderHero();
    const canonicalBefore = screen.getByRole("button", {
      name: "Mostrar valor exato",
    }).textContent;
    const slider = screen.getByRole("slider", {
      name: "Ritmo diário projetado",
    });
    for (const value of ["1", "2", "3"]) {
      fireEvent.change(slider, { target: { value } });
      expect(
        screen.getByRole("button", { name: "Mostrar valor exato" }),
      ).toHaveTextContent(canonicalBefore ?? "");
    }
  });

  it("scrubbing to today (index 0 / m.hoje) shows realizado, not projetado", () => {
    renderHero();
    expect(screen.getByText(/Realizado · dia 1/)).toBeInTheDocument();
  });

  it("tone turns negative exactly when the scrubbed value is < 0, not <= 0", () => {
    renderHero();
    const slider = screen.getByRole("slider", {
      name: "Ritmo diário projetado",
    });
    fireEvent.change(slider, { target: { value: "2" } });
    expect(screen.getByTestId("hero-time-travel-value").className).not.toMatch(
      /ck-neg/,
    );
    fireEvent.change(slider, { target: { value: "3" } });
    expect(screen.getByTestId("hero-time-travel-value").className).toMatch(
      /ck-neg/,
    );
  });

  it("slider input meets the 44px touch target and produces an aria-valuetext narrating the day", () => {
    renderHero();
    const slider = screen.getByRole("slider", {
      name: "Ritmo diário projetado",
    });
    expect(slider.className).toMatch(/min-h-\[44px\]/);
    fireEvent.change(slider, { target: { value: "3" } });
    expect(slider).toHaveAttribute("aria-valuetext", "Dia 3, projetado");
  });

  it("does not mutate the canonical hero when the underlying series is scrubbed twice in sequence", () => {
    renderHero();
    const canonicalBefore = screen.getByRole("button", {
      name: "Mostrar valor exato",
    }).textContent;
    const slider = screen.getByRole("slider", {
      name: "Ritmo diário projetado",
    });
    fireEvent.change(slider, { target: { value: "2" } });
    fireEvent.change(slider, { target: { value: "3" } });
    expect(
      screen.getByRole("button", { name: "Mostrar valor exato" }),
    ).toHaveTextContent(canonicalBefore ?? "");
  });

  it("keeps the canonical hero unaffected by an active scenario delta", () => {
    renderHero({ scenarioDelta: 100_000 });
    expect(
      screen.getByRole("button", { name: "Mostrar valor exato" }),
    ).toHaveTextContent("R$ 12 mil");
  });

  it("deforms the projected value by the accumulated scenario delta on future days, leaving the first future day fixed", () => {
    // Same references across rerenders, mirroring a real parent's memoized
    // `series`/`top` — only `scenarioDelta` changes, so the day-reset effect
    // (tied to month/series identity) must NOT fire here.
    const stableTop = top();
    const stableSeries = series();
    const { rerender } = render(
      <HeroTimeTravel
        top={stableTop}
        series={stableSeries}
        hoje={1}
        diasNoMes={3}
        showTimeTravel
        scenarioDelta={0}
      />,
    );
    const slider = screen.getByRole("slider", {
      name: "Ritmo diário projetado",
    });
    fireEvent.change(slider, { target: { value: "2" } });
    const baseline = screen.getByTestId("hero-time-travel-value").textContent;

    rerender(
      <HeroTimeTravel
        top={stableTop}
        series={stableSeries}
        hoje={1}
        diasNoMes={3}
        showTimeTravel
        scenarioDelta={50_000}
      />,
    );
    // Day 2 is the first future day — contract keeps it fixed for any delta.
    expect(screen.getByTestId("hero-time-travel-value").textContent).toBe(
      baseline,
    );

    fireEvent.change(
      screen.getByRole("slider", { name: "Ritmo diário projetado" }),
      { target: { value: "3" } },
    );
    // Day 3 is the second future day — accumulates one delta step.
    expect(screen.getByTestId("hero-time-travel-value")).toHaveTextContent(
      "R$ 499,00",
    );
  });
});
