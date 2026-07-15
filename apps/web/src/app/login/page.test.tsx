import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./page";

const { replaceMock, loginMock, apiGetMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  loginMock: vi.fn(),
  apiGetMock: vi.fn(),
}));

let searchQuery = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(searchQuery),
}));
vi.mock("@/lib/api", () => ({ api: { get: apiGetMock } }));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ login: loginMock }),
}));

describe("/login signup discovery and redirect", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    loginMock.mockReset();
    loginMock.mockResolvedValue(undefined);
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue({
      registerEnabled: false,
      guestEnabled: false,
    });
    searchQuery = "";
  });

  it("shows self-signup only when the public config enables it", async () => {
    apiGetMock.mockResolvedValue({
      registerEnabled: true,
      guestEnabled: false,
    });
    render(<LoginPage />);

    expect(
      await screen.findByRole("link", { name: /criar minha conta/i }),
    ).toHaveAttribute("href", "/register");
    expect(apiGetMock).toHaveBeenCalledWith("/auth/config");
  });

  it("keeps self-signup hidden when disabled", async () => {
    render(<LoginPage />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("link", { name: /criar conta/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps self-signup hidden when config lookup fails", async () => {
    apiGetMock.mockRejectedValue(new Error("network"));
    render(<LoginPage />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("link", { name: /criar conta/i }),
    ).not.toBeInTheDocument();
  });

  it("redirects to /app when next is not provided", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText("Usuário"), "demo");
    await user.type(screen.getByLabelText("Senha"), "123456");
    await user.click(screen.getByRole("button", { name: "Entrar" }));

    await waitFor(() => {
      expect(loginMock).toHaveBeenCalledWith("demo", "123456");
    });
    expect(replaceMock).toHaveBeenCalledWith("/app");
  });

  it("preserves screen query when next contains app route params", async () => {
    searchQuery = "next=%2Fapp%3Fscreen%3Dlancar";
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText("Usuário"), "demo");
    await user.type(screen.getByLabelText("Senha"), "123456");
    await user.click(screen.getByRole("button", { name: "Entrar" }));

    await waitFor(() => {
      expect(loginMock).toHaveBeenCalledWith("demo", "123456");
    });
    expect(replaceMock).toHaveBeenCalledWith("/app?screen=lancar");
  });
});
