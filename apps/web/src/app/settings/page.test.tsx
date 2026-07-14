import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateObjectives: vi.fn() }));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      role: "USER",
      tenantId: "t1",
      allowedProjectTypes: ["CASA", "CARRO"],
    },
    updateObjectives: mocks.updateObjectives,
  }),
}));

const routes = import.meta.glob<{ default: React.ComponentType }>(
  "./page.tsx",
  {
    eager: true,
  },
);
const SettingsPage = routes["./page.tsx"]?.default;
const SettingsRoute = SettingsPage as React.ComponentType;

describe("/settings authenticated objectives route contract", () => {
  it("exists as an explicit self-service settings page", () => {
    expect(
      SettingsPage,
      "missing apps/web/src/app/settings/page.tsx",
    ).toBeDefined();
  });
});

describe.runIf(Boolean(SettingsPage))(
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
      render(<SettingsRoute />);

      expect(screen.getByRole("checkbox", { name: /CASA/i })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /CARRO/i })).toBeChecked();
      await browser.click(screen.getByRole("checkbox", { name: /CARRO/i }));
      await browser.click(screen.getByRole("checkbox", { name: /PLANTAS/i }));
      await browser.click(screen.getByRole("button", { name: /salvar/i }));

      await waitFor(() =>
        expect(mocks.updateObjectives).toHaveBeenCalledTimes(1),
      );
      expect(mocks.updateObjectives).toHaveBeenCalledWith(["CASA", "PLANTAS"]);
    });

    it("does not submit an empty objective set", async () => {
      const browser = userEvent.setup();
      render(<SettingsRoute />);
      await browser.click(screen.getByRole("checkbox", { name: /CASA/i }));
      await browser.click(screen.getByRole("checkbox", { name: /CARRO/i }));
      await browser.click(screen.getByRole("button", { name: /salvar/i }));

      expect(mocks.updateObjectives).not.toHaveBeenCalled();
    });

    it("keeps the form retryable after a failed update", async () => {
      mocks.updateObjectives.mockRejectedValue(new Error("network"));
      const browser = userEvent.setup();
      render(<SettingsRoute />);
      await browser.click(screen.getByRole("button", { name: /salvar/i }));

      await waitFor(() =>
        expect(mocks.updateObjectives).toHaveBeenCalledTimes(1),
      );
      expect(screen.getByRole("button", { name: /salvar/i })).toBeEnabled();
    });
  },
);
