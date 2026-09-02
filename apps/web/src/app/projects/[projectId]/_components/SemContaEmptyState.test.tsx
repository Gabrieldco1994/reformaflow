import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SemContaEmptyState } from "./SemContaEmptyState";

/**
 * #218 W5 — empty state acionável para conta bancária não cadastrada.
 * Navega para /bank-accounts?focus=openingBalance (gêmeo de SemCartaoEmptyState).
 */
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

describe("SemContaEmptyState", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('CTA "Nova conta" navega para /bank-accounts?focus=openingBalance escopado pelo projectId', () => {
    render(<SemContaEmptyState projectId="outro-proj" />);
    fireEvent.click(screen.getByRole("button", { name: "Nova conta" }));
    expect(mockPush).toHaveBeenCalledWith(
      "/projects/outro-proj/bank-accounts?focus=openingBalance",
    );
  });
});
