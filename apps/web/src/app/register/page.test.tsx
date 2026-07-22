import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RegisterPage from "./page";

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

async function fillValidForm(browser: ReturnType<typeof userEvent.setup>) {
  await browser.type(screen.getByLabelText(/seu nome/i), "Maria");
  await browser.type(screen.getByLabelText(/email/i), "maria@example.com");
  await browser.type(screen.getByLabelText(/^senha$/i), "segredo1");
}

describe("/register 3-field registration", () => {
  it("exists as an explicit public registration page", () => {
    expect(RegisterPage).toBeDefined();
  });
});

describe("/register form behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.register.mockResolvedValue({ id: "u1" });
  });

  it("exposes name, email, and password fields only", () => {
    render(<RegisterPage />);

    expect(screen.getByLabelText(/seu nome/i)).toBeRequired();
    expect(screen.getByLabelText(/email/i)).toBeRequired();
    expect(screen.getByLabelText(/^senha$/i)).toBeRequired();
    
    expect(screen.queryByLabelText(/nome do seu espaço/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/usuário/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/confirmar senha/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("submits 3-field payload and routes to the objective picker", async () => {
    let finishRegistration!: (value: { id: string }) => void;
    mocks.register.mockImplementationOnce(
      () => new Promise((resolve) => { finishRegistration = resolve; }),
    );
    const browser = userEvent.setup();
    render(<RegisterPage />);
    await fillValidForm(browser);

    const submit = screen.getByRole("button", { name: /criar minha conta/i });
    await browser.click(submit);
    expect(submit).toBeDisabled();
    await browser.click(submit);

    await waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(1));
    expect(mocks.register).toHaveBeenCalledWith({
      ownerName: "Maria",
      email: "maria@example.com",
      password: "segredo1",
    }, expect.any(String));
    finishRegistration({ id: "u1" });
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/onboarding/objetivos"),
    );
  });

  it("validates name minimum length", async () => {
    const browser = userEvent.setup();
    render(<RegisterPage />);
    await browser.type(screen.getByLabelText(/email/i), "test@example.com");
    await browser.type(screen.getByLabelText(/^senha$/i), "segredo1");
    await browser.click(screen.getByRole("button", { name: /criar minha conta/i }));

    expect(mocks.register).not.toHaveBeenCalled();
    expect(screen.getByText(/informe seu nome/i)).toBeInTheDocument();
  });

  it("validates email format", async () => {
    const browser = userEvent.setup();
    render(<RegisterPage />);
    await browser.type(screen.getByLabelText(/seu nome/i), "Maria");
    await browser.type(screen.getByLabelText(/email/i), "invalid");
    await browser.type(screen.getByLabelText(/^senha$/i), "segredo1");
    await browser.click(screen.getByRole("button", { name: /criar minha conta/i }));

    expect(mocks.register).not.toHaveBeenCalled();
    expect(screen.getByText(/informe um email válido/i)).toBeInTheDocument();
  });

  it("validates password minimum length", async () => {
    const browser = userEvent.setup();
    render(<RegisterPage />);
    await browser.type(screen.getByLabelText(/seu nome/i), "Maria");
    await browser.type(screen.getByLabelText(/email/i), "maria@example.com");
    await browser.type(screen.getByLabelText(/^senha$/i), "short");
    await browser.click(screen.getByRole("button", { name: /criar minha conta/i }));

    expect(mocks.register).not.toHaveBeenCalled();
    expect(screen.getByText(/crie uma senha com pelo menos 8 caracteres/i)).toBeInTheDocument();
  });

  it("prevents double submission", async () => {
    mocks.register.mockImplementation(() => new Promise(() => {}));
    const browser = userEvent.setup();
    render(<RegisterPage />);
    await fillValidForm(browser);
    const submit = screen.getByRole("button", { name: /criar minha conta/i });
    await browser.click(submit);
    await browser.click(submit);
    await browser.click(submit);

    expect(mocks.register).toHaveBeenCalledTimes(1);
  });

  it("recovers from server failure", async () => {
    mocks.register.mockRejectedValue(new Error("email duplicado"));
    const browser = userEvent.setup();
    render(<RegisterPage />);
    await fillValidForm(browser);
    await browser.click(screen.getByRole("button", { name: /criar minha conta/i }));

    await waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(1));
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /criar minha conta/i })).toBeEnabled();
    expect(screen.getByText(/email duplicado/i)).toBeInTheDocument();
  });
});
