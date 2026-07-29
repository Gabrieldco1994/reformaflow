import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectType } from "@reformaflow/domain";
import {
  JourneyRuntimeProvider,
  useJourneyRuntime,
} from "./journey-runtime-context";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  push: vi.fn(),
  user: { id: "u1" },
}));

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: mocks.user, loading: false }),
}));
vi.mock("@/lib/api", () => ({
  api: { get: mocks.apiGet, post: mocks.apiPost },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/current/monthly",
  useRouter: () => ({ push: mocks.push }),
}));

function Fixture() {
  const runtime = useJourneyRuntime();
  return (
    <>
      <button
        type="button"
        // Valor fictício, de propósito: não é um JOURNEY_SAFE_ACTIONS real.
        // journey-action-markers.test.ts (domain) varre TODO apps/web/src,
        // inclusive arquivos de teste — usar uma chave real aqui contaria
        // como um segundo CTA marcado e quebraria aquele teste de cobertura.
        data-journey-action="__test-fixture-action__"
        onClick={() => undefined}
      >
        Ação segura
      </button>
      <button
        type="button"
        onClick={() =>
          void runtime.emitProjectCreated("current", ProjectType.PESSOAL)
        }
      >
        Criar projeto
      </button>
      {runtime.active && (
        <div data-testid="active">
          {runtime.active.journey.name}:{runtime.active.stepIndex}
          <button type="button" onClick={runtime.next}>
            Continuar
          </button>
        </div>
      )}
    </>
  );
}

function renderRuntime() {
  return render(
    <JourneyRuntimeProvider>
      {/* `main` real: é o landmark de fallback para onde o foco volta quando
          a jornada abriu sem clique de gatilho (caminho SCREEN_VISIT). */}
      <main data-testid="page-main">
        <Fixture />
      </main>
    </JourneyRuntimeProvider>,
  );
}

describe("JourneyRuntimeProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.apiGet.mockImplementation((path: string) => {
      const context = Object.fromEntries(
        new URL(`http://localhost${path}`).searchParams,
      ) as {
        triggerType?: string;
      };
      return Promise.resolve(context.triggerType === "SCREEN_VISIT" ? [] : []);
    });
    mocks.apiPost.mockResolvedValue({});
  });

  it("starts from an explicit project-created event and derives progress from returned steps", async () => {
    mocks.apiGet.mockImplementation((path: string) => {
      const context = Object.fromEntries(
        new URL(`http://localhost${path}`).searchParams,
      ) as {
        triggerType?: string;
      };
      return Promise.resolve(
        context.triggerType === "PROJECT_CREATED"
          ? [
              {
                journeyId: "j1",
                key: "tour:test",
                name: "Tour",
                triggerId: "t1",
                repeatPolicy: "ALWAYS",
                dismissPolicy: "DISMISS_UNTIL_LOGIN",
                crossProject: false,
                steps: [
                  {
                    stepKey: "feedback",
                    order: 0,
                    experience: "SUMMARY",
                    label: "A",
                    subtitle: "Resumo",
                    skippable: true,
                  },
                  {
                    stepKey: "expense",
                    order: 1,
                    experience: "FULL",
                    label: "B",
                    subtitle: null,
                    skippable: false,
                    slug: "expenses",
                  },
                ],
              },
            ]
          : [],
      );
    });
    renderRuntime();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Criar projeto" }));
    expect(await screen.findByTestId("active")).toHaveTextContent("Tour:0");
    await userEvent
      .setup()
      .click(
        within(screen.getByTestId("active")).getByRole("button", {
          name: "Continuar",
        }),
      );
    expect(screen.getByTestId("active")).toHaveTextContent("Tour:1");
    expect(mocks.push).toHaveBeenCalledWith("/projects/current/expenses");
    expect(sessionStorage.getItem("lifeone:journey-runtime")).toContain(
      '"stepIndex":1',
    );
  });

  // Regressão: navegar de dentro de next() só cobria a transição PARA a
  // próxima etapa — a etapa 0 (ativada direto por emit(), nunca passa por
  // next()) e uma jornada de UMA etapa FULL (nunca chama next() antes de
  // finish()) não navegavam nunca. O fix navega em função da etapa ATUAL via
  // useEffect, disparado na ativação e em toda troca de índice.
  describe("navega para a rota real da etapa FULL na ativação, não só na transição", () => {
    function mockSingleJourney(steps: unknown[]) {
      mocks.apiGet.mockImplementation((path: string) => {
        const context = Object.fromEntries(
          new URL(`http://localhost${path}`).searchParams,
        ) as { triggerType?: string };
        return Promise.resolve(
          context.triggerType === "PROJECT_CREATED"
            ? [
                {
                  journeyId: "j1",
                  key: "tour:full-nav",
                  name: "Tour",
                  triggerId: "t1",
                  repeatPolicy: "ALWAYS",
                  dismissPolicy: "DISMISS_UNTIL_LOGIN",
                  crossProject: false,
                  steps,
                },
              ]
            : [],
        );
      });
    }

    it("navigates on activation when the FIRST step is FULL (single-step journey)", async () => {
      mockSingleJourney([
        {
          stepKey: "expense",
          order: 0,
          experience: "FULL",
          label: "B",
          subtitle: null,
          skippable: false,
          slug: "expenses",
        },
      ]);
      renderRuntime();

      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Criar projeto" }));
      expect(await screen.findByTestId("active")).toHaveTextContent("Tour:0");
      expect(mocks.push).toHaveBeenCalledWith("/projects/current/expenses");
    });

    it("navigates on activation when step 0 is FULL, in a multi-step journey", async () => {
      mockSingleJourney([
        {
          stepKey: "receipt",
          order: 0,
          experience: "FULL",
          label: "B",
          subtitle: null,
          skippable: true,
          slug: "receipts",
        },
        {
          stepKey: "feedback",
          order: 1,
          experience: "SUMMARY",
          label: "A",
          subtitle: "Resumo",
          skippable: true,
        },
      ]);
      renderRuntime();

      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Criar projeto" }));
      expect(await screen.findByTestId("active")).toHaveTextContent("Tour:0");
      expect(mocks.push).toHaveBeenCalledWith("/projects/current/receipts");
    });

    it("navigates when the LAST step (reached via next()) is FULL", async () => {
      mockSingleJourney([
        {
          stepKey: "feedback",
          order: 0,
          experience: "SUMMARY",
          label: "A",
          subtitle: "Resumo",
          skippable: true,
        },
        {
          stepKey: "bill",
          order: 1,
          experience: "FULL",
          label: "B",
          subtitle: null,
          skippable: false,
          slug: "bills",
        },
      ]);
      renderRuntime();

      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Criar projeto" }));
      await screen.findByTestId("active");
      expect(mocks.push).not.toHaveBeenCalledWith("/projects/current/bills");

      await userEvent
        .setup()
        .click(
          within(screen.getByTestId("active")).getByRole("button", {
            name: "Continuar",
          }),
        );
      expect(screen.getByTestId("active")).toHaveTextContent("Tour:1");
      expect(mocks.push).toHaveBeenCalledWith("/projects/current/bills");
    });
  });

  it("resumes an active journey from sessionStorage", async () => {
    sessionStorage.setItem(
      "lifeone:journey-runtime",
      JSON.stringify({
        journey: {
          journeyId: "j1",
          key: "tour:test",
          name: "Retomada",
          triggerId: "t1",
          repeatPolicy: "ALWAYS",
          dismissPolicy: "DISMISS_UNTIL_LOGIN",
          crossProject: false,
          steps: [
            {
              stepKey: "feedback",
              order: 0,
              experience: "SUMMARY",
              label: "A",
              subtitle: "Resumo",
              skippable: true,
            },
          ],
        },
        stepIndex: 0,
        projectId: "current",
      }),
    );
    renderRuntime();
    expect(await screen.findByTestId("active")).toHaveTextContent("Retomada:0");
    await waitFor(() =>
      expect(mocks.apiGet).not.toHaveBeenCalledWith(
        "/journeys/eligible",
        expect.anything(),
      ),
    );
  });

  it("shows compatible projects for a cross-project journey", async () => {
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === "/projects")
        return Promise.resolve([{ id: "p1", name: "Casa", type: "CASA" }]);
      const context = Object.fromEntries(
        new URL(`http://localhost${path}`).searchParams,
      ) as {
        triggerType?: string;
      };
      return Promise.resolve(
        context.triggerType === "ACTION"
          ? [
              {
                journeyId: "j1",
                key: "tour:cross",
                name: "Cross",
                triggerId: "t1",
                repeatPolicy: "ALWAYS",
                dismissPolicy: "DISMISS_UNTIL_LOGIN",
                crossProject: true,
                steps: [
                  {
                    stepKey: "feedback",
                    order: 0,
                    experience: "SUMMARY",
                    label: "A",
                    subtitle: "Resumo",
                    skippable: true,
                  },
                ],
              },
            ]
          : [],
      );
    });
    renderRuntime();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Ação segura" }));
    expect(
      await screen.findByRole("combobox", { name: "Projeto da jornada" }),
    ).toBeInTheDocument();
  });

  describe("acessibilidade do painel", () => {
    function setupJourney(skippable: boolean) {
      mocks.apiGet.mockImplementation((path: string) => {
        const context = Object.fromEntries(
          new URL(`http://localhost${path}`).searchParams,
        ) as { triggerType?: string };
        return Promise.resolve(
          context.triggerType === "PROJECT_CREATED"
            ? [
                {
                  journeyId: "j1",
                  key: "tour:a11y",
                  name: "A11y",
                  triggerId: "t1",
                  repeatPolicy: "ALWAYS",
                  dismissPolicy: "DISMISS_UNTIL_LOGIN",
                  crossProject: false,
                  steps: [
                    {
                      stepKey: "feedback",
                      order: 0,
                      experience: "SUMMARY",
                      label: "A",
                      subtitle: "Resumo",
                      skippable,
                    },
                  ],
                },
              ]
            : [],
        );
      });
    }

    it("moves focus into the panel on open and returns it to the trigger on close", async () => {
      setupJourney(true);
      renderRuntime();
      const trigger = screen.getByRole("button", { name: "Criar projeto" });
      await userEvent.setup().click(trigger);

      const panel = await screen.findByRole("dialog");
      await waitFor(() => expect(panel).toHaveFocus());

      await userEvent
        .setup()
        .click(within(panel).getByRole("button", { name: "Fechar jornada" }));

      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(trigger).toHaveFocus();
    });

    it("closes on Escape when the current step is skippable", async () => {
      setupJourney(true);
      renderRuntime();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Criar projeto" }));
      await screen.findByRole("dialog");

      await userEvent.setup().keyboard("{Escape}");

      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
    });

    it("ignores Escape when the current step is NOT skippable", async () => {
      setupJourney(false);
      renderRuntime();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Criar projeto" }));
      const panel = await screen.findByRole("dialog");

      await userEvent.setup().keyboard("{Escape}");

      expect(screen.getByRole("dialog")).toBe(panel);
    });
  });

  // Regressão: SCREEN_VISIT é o ÚNICO gatilho automático vivo (o bootstrap só
  // semeia PROJECT_CREATED e nenhum consumidor de emitProjectCreated existe na
  // web). Nele, dispensar não escrevia nada em lugar nenhum: o effect de
  // SCREEN_VISIT re-rodava com `active === null`, o mesmo `pathname` voltava a
  // ser elegível (o backend só filtra por JourneyCompletion, e não há endpoint
  // de dismiss) e o painel reabria — fechar virava no-op. Os testes antigos
  // stubam SCREEN_VISIT como [] e usam PROJECT_CREATED, imunes ao bug.
  describe("dispensa no gatilho SCREEN_VISIT (o que roda em produção)", () => {
    function setupScreenVisitJourney() {
      mocks.apiGet.mockImplementation((path: string) => {
        const context = Object.fromEntries(
          new URL(`http://localhost${path}`).searchParams,
        ) as { triggerType?: string };
        return Promise.resolve(
          context.triggerType === "SCREEN_VISIT"
            ? [
                {
                  journeyId: "j1",
                  key: "tour:screen-visit",
                  name: "Visita",
                  triggerId: "t1",
                  repeatPolicy: "ALWAYS",
                  dismissPolicy: "DISMISS_UNTIL_LOGIN",
                  crossProject: false,
                  steps: [
                    {
                      stepKey: "feedback",
                      order: 0,
                      experience: "SUMMARY",
                      label: "A",
                      subtitle: "Resumo",
                      skippable: true,
                    },
                  ],
                },
              ]
            : [],
        );
      });
    }

    function screenVisitCalls() {
      return mocks.apiGet.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes("triggerType=SCREEN_VISIT"),
      ).length;
    }

    /** Espera a re-avaliação de elegibilidade que segue o fechamento. */
    async function waitForRecheck(previousCalls: number) {
      await waitFor(() =>
        expect(screenVisitCalls()).toBeGreaterThan(previousCalls),
      );
      await act(async () => {
        await Promise.resolve();
      });
    }

    it("does NOT reopen the panel after dismissing on the same pathname", async () => {
      setupScreenVisitJourney();
      renderRuntime();

      const panel = await screen.findByRole("dialog");
      const callsWhileOpen = screenVisitCalls();

      await userEvent
        .setup()
        .click(within(panel).getByRole("button", { name: "Fechar jornada" }));

      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      await waitForRecheck(callsWhileOpen);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("does NOT reopen the panel after Escape on the same pathname", async () => {
      setupScreenVisitJourney();
      renderRuntime();

      await screen.findByRole("dialog");
      const callsWhileOpen = screenVisitCalls();

      await userEvent.setup().keyboard("{Escape}");

      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      await waitForRecheck(callsWhileOpen);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Sem clique de gatilho não há elemento anterior para restaurar, e o painel
    // levou o foco consigo ao abrir: desmontar deixava o foco no <body> e o Tab
    // recomeçava do topo da página.
    it("returns focus to the page landmark when there was no trigger click", async () => {
      setupScreenVisitJourney();
      renderRuntime();

      const panel = await screen.findByRole("dialog");
      await waitFor(() => expect(panel).toHaveFocus());

      await userEvent.setup().keyboard("{Escape}");

      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(screen.getByTestId("page-main")).toHaveFocus();
      expect(document.body).not.toHaveFocus();
    });
  });
});
