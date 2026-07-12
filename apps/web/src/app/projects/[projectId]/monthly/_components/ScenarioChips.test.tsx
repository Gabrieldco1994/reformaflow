import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ScenarioChips from "./ScenarioChips";

function ControlledWrapper() {
  const [delta, setDelta] = useState(0);
  return <ScenarioChips selectedDelta={delta} onChange={setDelta} />;
}

describe("ScenarioChips", () => {
  it("renders the 4 canonical chips with literal cent deltas", () => {
    render(<ScenarioChips selectedDelta={0} onChange={() => {}} />);
    const comoEsta = screen.getByRole("button", { name: "como está" });
    expect(comoEsta).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "gastar +500" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "cortar 500" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "cortar 1.000" }),
    ).toBeInTheDocument();
  });

  it("clicking a chip calls onChange with the exact integer-cent delta and toggles aria-pressed", () => {
    const onChange = vi.fn();
    render(<ScenarioChips selectedDelta={0} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "cortar 1.000" }));
    expect(onChange).toHaveBeenCalledWith(100_000);

    render(<ScenarioChips selectedDelta={100_000} onChange={onChange} />);
    const buttons = screen.getAllByRole("button", { name: /cortar 1\.000/i });
    const pressedOnes = buttons.filter(
      (b) => b.getAttribute("aria-pressed") === "true",
    );
    expect(pressedOnes.length).toBeGreaterThan(0);
  });

  it("chips meet the typography floor", () => {
    render(<ScenarioChips selectedDelta={0} onChange={() => {}} />);
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).not.toMatch(/text-\[(?:[0-9]|10)px\]/);
      expect(button.className).toMatch(/min-h-\[44px\]/);
    }
  });

  it("is a pure controlled component: re-rendering with the same selected delta prop keeps the same chip highlighted", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ScenarioChips selectedDelta={50_000} onChange={onChange} />,
    );
    expect(
      screen.getByRole("button", { name: "cortar 500" }),
    ).toHaveAttribute("aria-pressed", "true");
    rerender(<ScenarioChips selectedDelta={50_000} onChange={onChange} />);
    expect(
      screen.getByRole("button", { name: "cortar 500" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "como está" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles the selected chip end-to-end when wired to a controlled parent", () => {
    render(<ControlledWrapper />);
    fireEvent.click(screen.getByRole("button", { name: "cortar 1.000" }));
    expect(
      screen.getByRole("button", { name: "cortar 1.000" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "como está" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
