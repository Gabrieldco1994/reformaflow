import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MiniHeroCapsule from "./MiniHeroCapsule";

describe("MiniHeroCapsule", () => {
  it("is hidden by default and becomes visible once scroll position passes the threshold", () => {
    const { rerender } = render(
      <MiniHeroCapsule visible={false} value="R$ 12 mil" />,
    );
    expect(
      screen.getByRole("status", { hidden: true }),
    ).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    rerender(<MiniHeroCapsule visible value="R$ 12 mil" />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-hidden", "false");
  });

  it("never clips its content (overflow-x-visible regression guard)", () => {
    render(<MiniHeroCapsule visible value="R$ 12 mil" />);
    const capsule = screen.getByRole("status");
    expect(capsule.className).not.toMatch(/overflow-hidden|overflow-x-hidden/);
    const valueNode = screen.getByText("R$ 12 mil");
    expect(valueNode.className).not.toMatch(/truncate|text-ellipsis/);
  });

  it("shows the same canonical number as the outer mini-hero (no duplicate source of truth)", () => {
    const value = "R$ 12 mil";
    render(<MiniHeroCapsule visible value={value} />);
    render(
      <aside aria-label="Resumo do mês atual">
        <p>{value}</p>
      </aside>,
    );
    const [capsuleValue, outerValue] = screen.getAllByText(value);
    expect(capsuleValue.textContent).toBe(outerValue.textContent);
  });
});
