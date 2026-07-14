import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ register: mocks.register }),
}));

const routes = import.meta.glob<{ default: React.ComponentType }>(
  "./page.tsx",
  {
    eager: true,
  },
);
const RegisterPage = routes["./page.tsx"]?.default;
const RegistrationRoute = RegisterPage as React.ComponentType;

async function fillValidForm(browser: ReturnType<typeof userEvent.setup>) {
  await browser.type(screen.getByLabelText(/tenant/i), "Acme");
  await browser.type(screen.getByLabelText(/nome da pessoa/i), "Maria");
  await browser.type(screen.getByLabelText(/usuário/i), " Maria.Silva ");
  await browser.type(screen.getByLabelText(/^senha$/i), "segredo");
  await browser.type(screen.getByLabelText(/confirmar senha/i), "segredo");
  await browser.click(screen.getByRole("checkbox", { name: /CASA/i }));
}

describe("/register public route contract", () => {
  it("exists as an explicit public registration page", () => {
    expect(
      RegisterPage,
      "missing apps/web/src/app/register/page.tsx",
    ).toBeDefined();
  });
});

describe.runIf(Boolean(RegisterPage))("/register form behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.register.mockResolvedValue({ id: "u1" });
  });

  it("exposes all required inputs and exactly the six canonical objective values", () => {
    render(<RegistrationRoute />);

    expect(screen.getByLabelText(/tenant/i)).toBeRequired();
    expect(screen.getByLabelText(/nome da pessoa/i)).toBeRequired();
    expect(screen.getByLabelText(/usuário/i)).toBeRequired();
    expect(screen.getByLabelText(/^senha$/i)).toBeRequired();
    expect(screen.getByLabelText(/confirmar senha/i)).toBeRequired();
    expect(
      screen
        .getAllByRole("checkbox")
        .map((checkbox) => (checkbox as HTMLInputElement).value),
    ).toEqual(["REFORMA", "COMPRA", "CASA", "CARRO", "PESSOAL", "PLANTAS"]);
  });

  it("submits one canonical payload once and enters manual project onboarding", async () => {
    const browser = userEvent.setup();
    render(<RegistrationRoute />);
    await fillValidForm(browser);

    const submit = screen.getByRole("button", { name: /criar conta/i });
    await Promise.all([browser.click(submit), browser.click(submit)]);

    await waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(1));
    expect(mocks.register).toHaveBeenCalledWith({
      tenantName: "Acme",
      ownerName: "Maria",
      username: "Maria.Silva",
      password: "segredo",
      confirmationPassword: "segredo",
      objectives: ["CASA"],
    });
    expect(mocks.replace).toHaveBeenCalledWith("/projects");
  });

  it("rejects mismatch and missing objectives without a request", async () => {
    const browser = userEvent.setup();
    render(<RegistrationRoute />);
    await browser.type(screen.getByLabelText(/tenant/i), "Acme");
    await browser.type(screen.getByLabelText(/nome da pessoa/i), "Maria");
    await browser.type(screen.getByLabelText(/usuário/i), "maria");
    await browser.type(screen.getByLabelText(/^senha$/i), "segredo");
    await browser.type(screen.getByLabelText(/confirmar senha/i), "diferente");
    await browser.click(screen.getByRole("button", { name: /criar conta/i }));

    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("recovers from a server failure without navigating or duplicating the request", async () => {
    mocks.register.mockRejectedValue(new Error("username unavailable"));
    const browser = userEvent.setup();
    render(<RegistrationRoute />);
    await fillValidForm(browser);
    await browser.click(screen.getByRole("button", { name: /criar conta/i }));

    await waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(1));
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /criar conta/i })).toBeEnabled();
  });
});
