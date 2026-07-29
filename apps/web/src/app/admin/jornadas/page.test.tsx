import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOURNEY_CATALOG, ProjectType, resolveJourneySteps } from "@reformaflow/domain";
import AdminJornadasPage from "./page";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  isAdmin: true,
}));

/**
 * Fake de `admin/journeys` no nível do HTTP (não do seam do editor): list/get/
 * create/update com estado, servindo o MESMO formato da API real. Assim o teste
 * cobre também a tradução `toApiShape`/`fromApiShape`, que é onde o editor
 * deixou de persistir antes.
 */
interface AnyJourney {
  id: string;
  key: string;
  name: string;
  description: string | null;
  active: boolean;
  steps: unknown[];
  triggers: unknown[];
}

const server = vi.hoisted(() => {
  return {
    journeys: [] as AnyJourney[],
    seq: 0,
    reset(seed: AnyJourney[]) {
      server.journeys = JSON.parse(JSON.stringify(seed));
      server.seq = 0;
    },
  };
});

/** A API real devolve `id` em toda linha persistida; o fake precisa fazer o
 * mesmo, senão o editor recebe triggers/steps sem id e o teste passa por sorte. */
function withIds(journeyId: string, body: Record<string, unknown>) {
  return {
    ...body,
    id: journeyId,
    steps: (body.steps as Array<Record<string, unknown>>).map((step, i) => ({
      ...step,
      id: `${journeyId}-s${i}`,
    })),
    triggers: (body.triggers as Array<Record<string, unknown>>).map((trigger, i) => ({
      ...trigger,
      id: `${journeyId}-t${i}`,
    })),
  };
}

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path === "/admin/journeys") return JSON.parse(JSON.stringify(server.journeys));
      if (path === "/projects") return [];
      throw new Error(`GET não mapeado: ${path}`);
    }),
    put: vi.fn(async (path: string, body: Record<string, unknown>) => {
      const id = path.split("/").pop()!;
      const index = server.journeys.findIndex((j) => j.id === id);
      if (index < 0) throw new Error("Jornada não encontrada.");
      const key = server.journeys[index].key;
      server.journeys[index] = { ...withIds(id, body), key } as AnyJourney;
      return JSON.parse(JSON.stringify(server.journeys[index]));
    }),
    post: vi.fn(async (path: string, body: Record<string, unknown>) => {
      if (path !== "/admin/journeys") throw new Error(`POST não mapeado: ${path}`);
      server.seq += 1;
      const created = withIds(`srv-${server.seq}`, body) as AnyJourney;
      server.journeys = [...server.journeys, created];
      return JSON.parse(JSON.stringify(created));
    }),
  },
}));

/** Catálogo do domínio no formato que a API devolveria. */
function seedFromCatalog() {
  return Object.values(JOURNEY_CATALOG).map((definition, index) => ({
    id: `seed-${index}`,
    key: definition.key,
    name: definition.name,
    description: definition.description ?? null,
    active: true,
    steps: resolveJourneySteps(definition.steps).map((step, order) => ({
      id: `seed-${index}-${order}`,
      stepKey: step.key,
      order,
      experience: "SUMMARY",
      label: step.label,
      subtitle: step.subtitle ?? null,
      enabled: step.enabled,
      skippable: step.skippable,
    })),
    triggers: [
      {
        id: `seed-${index}-t0`,
        triggerType: "PROJECT_CREATED",
        targetProjectType: definition.triggers[0]?.targetProjectType ?? null,
        targetProjectId: definition.triggers[0]?.targetProjectId ?? null,
        crossProject: definition.triggers[0]?.crossProject ?? false,
        screenKey: null,
        actionKey: null,
        device: "any",
        repeatPolicy: "ONCE_PER_USER",
        dismissPolicy: "DISMISS_UNTIL_LOGIN",
        active: true,
      },
    ],
  }));
}

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
    server.reset(seedFromCatalog());
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

  it("persiste a jornada criada na API, não em memória", async () => {
    const user = userEvent.setup();
    const { api } = await import("@/lib/api");
    const antes = server.journeys.length;
    renderPage();
    await waitForTrack();

    await user.click(screen.getByRole("button", { name: /nova jornada/i }));
    await user.type(screen.getByLabelText(/nome da jornada/i), "Tour salvo");
    await user.selectOptions(screen.getByLabelText(/template/i), "onboarding:PESSOAL");
    await user.click(screen.getByRole("button", { name: /criar jornada/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/admin/journeys", expect.anything()));
    expect(server.journeys).toHaveLength(antes + 1);

    const [, body] = vi.mocked(api.post).mock.calls[0] as [string, Record<string, unknown>];
    expect(body.key).toMatch(/^custom:tour-salvo-\d+$/);
    expect(body.name).toBe("Tour salvo");
    // A API exige label em todo passo — mandar vazio devolvia 400.
    for (const step of body.steps as Array<Record<string, unknown>>) {
      expect(step.label).toBeTruthy();
    }
    // Gatilho carrega os campos que o editor edita no nível da jornada.
    expect(body.triggers).not.toHaveLength(0);
    for (const trigger of body.triggers as Array<Record<string, unknown>>) {
      expect(trigger.device).toBe("any");
      expect(trigger.repeatPolicy).toBe("ONCE_PER_USER");
      expect(trigger.dismissPolicy).toBe("DISMISS_UNTIL_LOGIN");
    }
  });

  it("salva a edição com PUT no id da jornada e reflete o que a API devolveu", async () => {
    const user = userEvent.setup();
    const { api } = await import("@/lib/api");
    renderPage();
    await waitForTrack();

    await user.selectOptions(screen.getByLabelText(/onde aparece/i), ProjectType.CASA);
    await user.click(screen.getByRole("button", { name: /salvar jornada/i }));

    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [path, body] = vi.mocked(api.put).mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toMatch(/^\/admin\/journeys\/seed-\d+$/);
    for (const trigger of body.triggers as Array<Record<string, unknown>>) {
      expect(trigger.targetProjectType).toBe(ProjectType.CASA);
    }
    // O estado persistido no servidor mudou de fato.
    const persisted = server.journeys.find((j) => j.id === path.split("/").pop());
    expect((persisted?.triggers as Array<Record<string, unknown>>)[0].targetProjectType).toBe(
      ProjectType.CASA,
    );
  });

  it("mantém a ordem da trilha ao mandar para a API (order sequencial)", async () => {
    const user = userEvent.setup();
    const { api } = await import("@/lib/api");
    renderPage();
    await waitForTrack();

    const steps = screen.getAllByTestId(/journey-card-/);
    await user.click(within(steps[1]).getByRole("button", { name: /mover .* para antes/i }));
    await user.click(screen.getByRole("button", { name: /salvar jornada/i }));

    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [, body] = vi.mocked(api.put).mock.calls[0] as [string, Record<string, unknown>];
    const enviados = body.steps as Array<Record<string, unknown>>;
    expect(enviados.map((s) => s.order)).toEqual(enviados.map((_, i) => i));
  });
});
