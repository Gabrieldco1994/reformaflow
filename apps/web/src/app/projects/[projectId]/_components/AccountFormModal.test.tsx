import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AccountFormModal from "./AccountFormModal";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe("AccountFormModal", () => {
  it("starts on the credit card form and switches to bank account on toggle", async () => {
    const user = userEvent.setup();
    render(
      <AccountFormModal projectId="p1" defaultType="CARD" onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    expect(screen.getByText("Novo cartão")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Conta bancária" }));

    expect(screen.getByText("Nova conta bancária")).toBeInTheDocument();
  });

  it("starts on the bank account form when defaultType is BANK", () => {
    render(
      <AccountFormModal projectId="p1" defaultType="BANK" onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    expect(screen.getByText("Nova conta bancária")).toBeInTheDocument();
  });
});
