import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingObjetivosPage from "./page";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("@/lib/api", () => ({
  api: { patch: mocks.patch },
}));

const LABELS: Record<string, RegExp> = {
  PESSOAL: /organizar minha vida financeira/i,
  REFORMA: /reformar/i,
  COMPRA: /fazer uma grande compra/i,
  CASA: /cuidar da casa/i,
  CARRO: /cuidar do carro/i,
  PLANTAS: /cuidar das minhas plantas/i,
};

async function toggle(browser: ReturnType<typeof userEvent.setup>, ...types: string[]) {
  for (const type of types) {
    await browser.click(screen.getByLabelText(LABELS[type]));
  }
}

describe("/onboarding/objetivos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.patch.mockResolvedValue(undefined);
  });

  it("renders the 6 objectives with none pre-selected", () => {
    render(<OnboardingObjetivosPage />);

    for (const label of Object.values(LABELS)) {
      const checkbox = screen.getByLabelText(label) as HTMLInputElement;
      expect(checkbox).not.toBeChecked();
    }
  });

  it("PESSOAL alone -> replace('/onboarding/setup?type=PESSOAL')", async () => {
    const browser = userEvent.setup();
    render(<OnboardingObjetivosPage />);
    await toggle(browser, "PESSOAL");
    await browser.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/onboarding/setup?type=PESSOAL"),
    );
  });

  it("REFORMA alone -> replace('/onboarding/setup?type=REFORMA')", async () => {
    const browser = userEvent.setup();
    render(<OnboardingObjetivosPage />);
    await toggle(browser, "REFORMA");
    await browser.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/onboarding/setup?type=REFORMA"),
    );
  });

  it("COMPRA alone -> replace('/onboarding/setup?type=COMPRA')", async () => {
    const browser = userEvent.setup();
    render(<OnboardingObjetivosPage />);
    await toggle(browser, "COMPRA");
    await browser.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/onboarding/setup?type=COMPRA"),
    );
  });

  it("CASA alone -> replace('/onboarding/setup?type=CASA')", async () => {
    const browser = userEvent.setup();
    render(<OnboardingObjetivosPage />);
    await toggle(browser, "CASA");
    await browser.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/onboarding/setup?type=CASA"),
    );
  });

  it("CARRO alone -> replace('/onboarding/setup?type=CARRO')", async () => {
    const browser = userEvent.setup();
    render(<OnboardingObjetivosPage />);
    await toggle(browser, "CARRO");
    await browser.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/onboarding/setup?type=CARRO"),
    );
  });

  it("PLANTAS alone -> replace('/onboarding/setup?type=PLANTAS')", async () => {
    const browser = userEvent.setup();
    render(<OnboardingObjetivosPage />);
    await toggle(browser, "PLANTAS");
    await browser.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/onboarding/setup?type=PLANTAS"),
    );
  });

  it("CASA + CARRO -> replace('.../setup?type=PESSOAL') and PATCH carries both", async () => {
    const browser = userEvent.setup();
    render(<OnboardingObjetivosPage />);
    await toggle(browser, "CASA", "CARRO");
    await browser.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/onboarding/setup?type=PESSOAL"),
    );
    expect(mocks.patch).toHaveBeenCalledWith("/auth/objectives", {
      projectTypes: ["CASA", "CARRO"],
    });
  });

  it("CASA + CARRO + REFORMA -> PESSOAL, PATCH carries all three", async () => {
    const browser = userEvent.setup();
    render(<OnboardingObjetivosPage />);
    await toggle(browser, "CASA", "CARRO", "REFORMA");
    await browser.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/onboarding/setup?type=PESSOAL"),
    );
    expect(mocks.patch).toHaveBeenCalledWith("/auth/objectives", {
      projectTypes: ["CASA", "CARRO", "REFORMA"],
    });
  });

  it("PESSOAL + CARRO -> PESSOAL, PATCH carries both", async () => {
    const browser = userEvent.setup();
    render(<OnboardingObjetivosPage />);
    await toggle(browser, "PESSOAL", "CARRO");
    await browser.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/onboarding/setup?type=PESSOAL"),
    );
    expect(mocks.patch).toHaveBeenCalledWith("/auth/objectives", {
      projectTypes: ["PESSOAL", "CARRO"],
    });
  });

  it("nothing selected -> does not PATCH, does not navigate, shows 'Escolha pelo menos um'", async () => {
    const browser = userEvent.setup();
    render(<OnboardingObjetivosPage />);
    await browser.click(screen.getByRole("button", { name: /continuar/i }));

    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByText(/escolha pelo menos um/i)).toBeInTheDocument();
  });

  it("resolves the PATCH before navigating (setup must not run without permission)", async () => {
    let resolvePatch!: () => void;
    mocks.patch.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolvePatch = resolve; }),
    );
    const browser = userEvent.setup();
    render(<OnboardingObjetivosPage />);
    await toggle(browser, "CARRO");
    await browser.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(mocks.replace).not.toHaveBeenCalled();

    resolvePatch();
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/onboarding/setup?type=CARRO"),
    );
  });

  it("PATCH fails -> does not navigate, shows error, button becomes usable again", async () => {
    mocks.patch.mockRejectedValue(new Error("falha ao salvar objetivos"));
    const browser = userEvent.setup();
    render(<OnboardingObjetivosPage />);
    await toggle(browser, "CARRO");
    await browser.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByText(/falha ao salvar objetivos/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continuar/i })).toBeEnabled();
  });

  it("double-clicking the CTA does not fire two PATCH calls", async () => {
    mocks.patch.mockImplementation(() => new Promise(() => {}));
    const browser = userEvent.setup();
    render(<OnboardingObjetivosPage />);
    await toggle(browser, "CARRO");
    const submit = screen.getByRole("button", { name: /continuar/i });
    await browser.click(submit);
    await browser.click(submit);
    await browser.click(submit);

    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });
});
