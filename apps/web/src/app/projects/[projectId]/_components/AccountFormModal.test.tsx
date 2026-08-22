import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import AccountFormModal from "./AccountFormModal";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("AccountFormModal", () => {
  it("marks its fullscreen wrapper while the nested account form stays bare", () => {
    const modal = wrap(
      <AccountFormModal projectId="p1" defaultType="BANK" onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    expect(document.body.dataset.overlayOpen).toBe("true");
    modal.unmount();
    expect(document.body.dataset.overlayOpen).toBeUndefined();
  });

  it("starts on the credit card form and switches to bank account on toggle", async () => {
    const user = userEvent.setup();
    wrap(
      <AccountFormModal projectId="p1" defaultType="CARD" onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    expect(screen.getByText("Novo cartão")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Conta bancária" }));

    expect(screen.getByText("Nova conta bancária")).toBeInTheDocument();
  });

  it("starts on the bank account form when defaultType is BANK", () => {
    wrap(
      <AccountFormModal projectId="p1" defaultType="BANK" onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    expect(screen.getByText("Nova conta bancária")).toBeInTheDocument();
  });
});
