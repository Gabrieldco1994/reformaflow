import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOURNEY_CATALOG, ProjectType } from "@reformaflow/domain";
import AdminJornadasPage from "./page";
import { resetMockJourneys } from "./_lib/mock-journeys";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  isAdmin: true,
}));

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    isAdmin: mocks.isAdmin,
    loading: false,
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
}));

function renderPage() {
  return render(<AdminJornadasPage />);
}

async function waitForTrack() {
  await screen.findByTestId("journey-track");
}

describe("AdminJornadasPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAdmin = true;
    resetMockJourneys();
  });

  it("redireciona quem não é admin", async () => {
    mocks.isAdmin = false;
    renderPage();
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/no-permission"),
    );
  });

  it("lista as jornadas do catálogo e abre uma edição com preview", async () => {
    renderPage();
    await waitForTrack();

    expect(
      screen.getByRole("heading", { name: "Jornadas", level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(JOURNEY_CATALOG["onboarding:PESSOAL"].name),
    ).toBeInTheDocument();
    expect(screen.getByTestId("journey-preview")).toBeInTheDocument();
  });

  it("edita onde aparece e quando começa sem depender de contagem fixa", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForTrack();

    await user.selectOptions(
      screen.getByLabelText(/onde aparece/i),
      ProjectType.CASA,
    );
    await user.selectOptions(
      screen.getByLabelText(/começa quando/i),
      "PROJECT_CREATED",
    );
    await user.click(screen.getByRole("button", { name: /salvar jornada/i }));

    await waitFor(() =>
      expect(screen.getByText(/alterações salvas/i)).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/onde aparece/i)).toHaveValue(
      ProjectType.CASA,
    );
    expect(screen.getByLabelText(/começa quando/i)).toHaveValue(
      "PROJECT_CREATED",
    );
  });

  it("reordena o trail e toggles a step without hard-coded step counts", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForTrack();

    const steps = screen.getAllByTestId(/journey-card-/);
    expect(steps.length).toBeGreaterThan(0);
    const firstLabel = within(steps[0]).getByTestId(
      "journey-step-label",
    ).textContent;
    await user.click(
      within(steps[1]).getByRole("button", { name: /mover .* para antes/i }),
    );
    expect(
      within(screen.getAllByTestId(/journey-card-/)[0]).getByTestId(
        "journey-step-label",
      ),
    ).toHaveTextContent(
      within(steps[1]).getByTestId("journey-step-label").textContent ?? "",
    );
    expect(firstLabel).not.toBeNull();
    await user.click(
      within(screen.getAllByTestId(/journey-card-/)[0]).getByRole("button", {
        name: /desligar/i,
      }),
    );
    expect(screen.getByText(/fora da jornada/i)).toBeInTheDocument();
  });

  it("cria uma jornada a partir de um template do catálogo", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForTrack();

    await user.click(screen.getByRole("button", { name: /nova jornada/i }));
    await user.type(
      screen.getByLabelText(/nome da jornada/i),
      "Tour de boas-vindas",
    );
    await user.selectOptions(
      screen.getByLabelText(/template/i),
      "onboarding:PESSOAL",
    );
    await user.click(screen.getByRole("button", { name: /criar jornada/i }));

    await waitFor(() =>
      expect(screen.getByText("Tour de boas-vindas")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("journey-track")).toBeInTheDocument();
  });
});
