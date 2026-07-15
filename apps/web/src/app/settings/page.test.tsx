import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "./page";

const mocks = vi.hoisted(() => ({ updateObjectives: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    loading: false,
    user: {
      id: "u1",
      role: "USER",
      tenantId: "t1",
      allowedProjectTypes: ["CASA", "CARRO"],
    },
    updateObjectives: mocks.updateObjectives,
  }),
}));

describe("/settings authenticated objectives route contract", () => {
  it("exists as an explicit self-service settings page", () => {
    expect(SettingsPage).toBeDefined();
  });
});

describe(
  "self objective settings behavior",
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.updateObjectives.mockResolvedValue({
        allowedProjectTypes: ["CASA", "PLANTAS"],
      });
    });

    it("initializes from fresh user objectives and saves only the canonical selection", async () => {
      const browser = userEvent.setup();
      render(<SettingsPage />);

      expect(screen.getByRole("checkbox", { name: /^Cuidar da casa/i })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /^Cuidar do carro/i })).toBeChecked();
      await browser.click(screen.getByRole("checkbox", { name: /^Cuidar do carro/i }));
      await browser.click(screen.getByRole("checkbox", { name: /^Cuidar das minhas plantas/i }));
      await browser.click(screen.getByRole("button", { name: /salvar/i }));

      await waitFor(() =>
        expect(mocks.updateObjectives).toHaveBeenCalledTimes(1),
      );
      expect(mocks.updateObjectives).toHaveBeenCalledWith(["CASA", "PLANTAS"]);
    });

    it("does not submit an empty objective set", async () => {
      const browser = userEvent.setup();
      render(<SettingsPage />);
      await browser.click(screen.getByRole("checkbox", { name: /^Cuidar da casa/i }));
      await browser.click(screen.getByRole("checkbox", { name: /^Cuidar do carro/i }));
      await browser.click(screen.getByRole("button", { name: /salvar/i }));

      expect(mocks.updateObjectives).not.toHaveBeenCalled();
    });

    it("keeps the form retryable after a failed update", async () => {
      mocks.updateObjectives.mockRejectedValue(new Error("network"));
      const browser = userEvent.setup();
      render(<SettingsPage />);
      await browser.click(screen.getByRole("button", { name: /salvar/i }));

      await waitFor(() =>
        expect(mocks.updateObjectives).toHaveBeenCalledTimes(1),
      );
      expect(screen.getByRole("button", { name: /salvar/i })).toBeEnabled();
    });
  },
);
