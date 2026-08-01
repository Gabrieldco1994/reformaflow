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
  user: { id: "u1" } as { id: string } | null,
  authLoading: false,
  pathname: "/projects/current/monthly",
}));

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: mocks.user, loading: mocks.authLoading }),
}));
vi.mock("@/lib/api", () => ({
  api: { get: mocks.apiGet, post: mocks.apiPost },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
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
          void runtime.emitProjectsCreated([
            { id: "current", type: ProjectType.PESSOAL },
          ])
        }
      >
        Criar projeto
      </button>
      <button
        type="button"
        onClick={() =>
          void runtime.emitProjectsCreated([
            { id: "p-reforma", type: ProjectType.REFORMA },
            { id: "p-casa", type: ProjectType.CASA },
          ])
        }
      >
        Criar dois projetos
      </button>
      {runtime.active && (
        <div data-testid="active">
          {runtime.active.journey.name}:{runtime.active.stepIndex}
          <span data-testid="active-project">{runtime.active.projectId}</span>
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
    mocks.user = { id: "u1" };
    mocks.authLoading = false;
    mocks.pathname = "/projects/current/monthly";
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
    await userEvent.setup().click(
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

      await userEvent.setup().click(
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

  // Regressão: o gatilho SCREEN_VISIT antes esperava um boolean `restored`
  // (setado num effect de montagem) além de auth/pathname/`!active` — dois
  // gates sequenciais e um round-trip antes do painel poder existir. Agora a
  // retomada é lida de forma síncrona no initializer do `useState`, então só
  // resta o gate de auth real.
  describe("disparo do SCREEN_VISIT (retomada síncrona + gate de auth)", () => {
    function screenVisitCalls() {
      return mocks.apiGet.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes("triggerType=SCREEN_VISIT"),
      ).length;
    }

    it("resumes an active journey from sessionStorage even while auth is still resolving", async () => {
      mocks.authLoading = true;
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
      // Retomada é lida no initializer, no primeiro render — não depende de
      // auth ter resolvido.
      expect(screen.getByTestId("active")).toHaveTextContent("Retomada:0");
      expect(screenVisitCalls()).toBe(0);
      await act(async () => {
        await Promise.resolve();
      });
    });

    it("does not emit SCREEN_VISIT before auth resolves, then emits once auth resolves", async () => {
      mocks.authLoading = true;
      const { rerender } = renderRuntime();
      await act(async () => {
        await Promise.resolve();
      });
      expect(screenVisitCalls()).toBe(0);

      mocks.authLoading = false;
      rerender(
        <JourneyRuntimeProvider>
          <main data-testid="page-main">
            <Fixture />
          </main>
        </JourneyRuntimeProvider>,
      );
      await waitFor(() => expect(screenVisitCalls()).toBe(1));
    });

    it("does not emit SCREEN_VISIT twice for the same navigation on extra re-renders", async () => {
      const { rerender } = renderRuntime();
      await waitFor(() => expect(screenVisitCalls()).toBe(1));

      rerender(
        <JourneyRuntimeProvider>
          <main data-testid="page-main">
            <Fixture />
          </main>
        </JourneyRuntimeProvider>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(screenVisitCalls()).toBe(1);
    });

    // Regressão do cadastro: `emitProjectCreated` é chamado de dentro do
    // `handleSubmit` do RegisterForm, cujo closure ainda vê `user === null`
    // (o `setUser` do register só chega no render seguinte). O gatilho era
    // descartado em silêncio — nenhuma requisição — e a jornada de onboarding
    // nunca abria para conta nova.
    function projectCreatedCalls() {
      return mocks.apiGet.mock.calls.filter((call) =>
        String(call[0]).includes("triggerType=PROJECT_CREATED"),
      ).length;
    }

    it("guarda PROJECT_CREATED emitido antes de auth resolver e reemite quando o usuário chega", async () => {
      mocks.authLoading = true;
      mocks.user = null;
      const { rerender } = renderRuntime();
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await userEvent.click(screen.getByText("Criar projeto"));
      });
      expect(projectCreatedCalls()).toBe(0);

      mocks.authLoading = false;
      mocks.user = { id: "u1" };
      rerender(
        <JourneyRuntimeProvider>
          <main data-testid="page-main">
            <Fixture />
          </main>
        </JourneyRuntimeProvider>,
      );

      await waitFor(() => expect(projectCreatedCalls()).toBe(1));
    });

    it("não reemite o gatilho guardado numa segunda passagem", async () => {      mocks.authLoading = true;
      mocks.user = null;
      const { rerender } = renderRuntime();
      await act(async () => {
        await userEvent.click(screen.getByText("Criar projeto"));
      });

      mocks.authLoading = false;
      mocks.user = { id: "u1" };
      const tree = (
        <JourneyRuntimeProvider>
          <main data-testid="page-main">
            <Fixture />
          </main>
        </JourneyRuntimeProvider>
      );
      rerender(tree);
      await waitFor(() => expect(projectCreatedCalls()).toBe(1));

      rerender(tree);
      await act(async () => {
        await Promise.resolve();
      });
      expect(projectCreatedCalls()).toBe(1);
    });
  });

  // Cadastro com vários objetivos cria um projeto por tipo, e cada tipo tem a
  // sua jornada de onboarding. A fila precisa carregar o projeto de CADA
  // jornada: antes ela guardava só a jornada e a segunda herdava o projectId
  // da primeira, abrindo no projeto errado.
  describe("uma jornada por projeto criado", () => {
    function journeyFor(type: string, id: string) {
      return {
        journeyId: `j-${type}`,
        key: `onboarding:${type}`,
        name: `Onboarding ${type}`,
        triggerId: `t-${type}`,
        repeatPolicy: "ONCE_PER_PROJECT",
        dismissPolicy: "DISMISS_UNTIL_LOGIN",
        crossProject: false,
        steps: [
          {
            stepKey: "feedback",
            order: 0,
            experience: "SUMMARY",
            label: `Passo de ${id}`,
            subtitle: "Resumo",
            skippable: true,
          },
        ],
      };
    }

    beforeEach(() => {
      mocks.apiGet.mockImplementation((path: string) => {
        const params = new URL(`http://localhost${path}`).searchParams;
        if (params.get("triggerType") !== "PROJECT_CREATED")
          return Promise.resolve([]);
        const projectId = params.get("projectId") ?? "";
        const type = params.get("projectType") ?? "";
        return Promise.resolve([journeyFor(type, projectId)]);
      });
    });

    it("enfileira uma jornada por projeto e cada uma abre no seu próprio projeto", async () => {
      renderRuntime();
      await act(async () => {
        await userEvent.click(screen.getByText("Criar dois projetos"));
      });

      // Uma consulta de elegibilidade por projeto, não uma só.
      const queried = mocks.apiGet.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.includes("triggerType=PROJECT_CREATED"));
      expect(queried).toHaveLength(2);
      expect(queried.some((u) => u.includes("projectId=p-reforma"))).toBe(true);
      expect(queried.some((u) => u.includes("projectId=p-casa"))).toBe(true);

      await waitFor(() =>
        expect(screen.getByTestId("active")).toHaveTextContent(
          "Onboarding REFORMA:0",
        ),
      );
      expect(screen.getByTestId("active-project")).toHaveTextContent(
        "p-reforma",
      );

      // Concluída a primeira, a segunda assume — com o SEU projeto.
      await act(async () => {
        await userEvent.click(
          within(screen.getByTestId("active")).getByRole("button", {
            name: "Continuar",
          }),
        );
      });

      await waitFor(() =>
        expect(screen.getByTestId("active")).toHaveTextContent(
          "Onboarding CASA:0",
        ),
      );
      expect(screen.getByTestId("active-project")).toHaveTextContent("p-casa");
    });

    it("encerra a fila depois da última jornada", async () => {
      renderRuntime();
      await act(async () => {
        await userEvent.click(screen.getByText("Criar dois projetos"));
      });
      await waitFor(() => expect(screen.getByTestId("active")).toBeTruthy());

      for (let i = 0; i < 2; i += 1) {
        await act(async () => {
          await userEvent.click(
            within(screen.getByTestId("active")).getByRole("button", {
              name: "Continuar",
            }),
          );
        });
      }

      await waitFor(() =>
        expect(screen.queryByTestId("active")).not.toBeInTheDocument(),
      );
    });
  });

  // O FAB de "Nova despesa" é `fixed bottom` em z-30 e o painel em z-70: sem a
  // altura MEDIDA do painel, ele tapava o único botão que a própria jornada
  // manda apertar. Constante não serve — o painel cresce com o texto do passo.
  it("publica a altura do painel em --journey-panel-h e limpa ao fechar", async () => {
    mocks.apiGet.mockImplementation((path: string) => {
      const params = new URL(`http://localhost${path}`).searchParams;
      if (params.get("triggerType") !== "PROJECT_CREATED")
        return Promise.resolve([]);
      return Promise.resolve([
        {
          journeyId: "j1",
          key: "tour:altura",
          name: "Altura",
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
      ]);
    });

    expect(
      document.body.style.getPropertyValue("--journey-panel-h"),
    ).toBe("");

    const { unmount } = renderRuntime();
    await act(async () => {
      await userEvent.click(screen.getByText("Criar projeto"));
    });

    await waitFor(() =>
      expect(
        document.body.style.getPropertyValue("--journey-panel-h"),
      ).not.toBe(""),
    );

    unmount();
    expect(document.body.style.getPropertyValue("--journey-panel-h")).toBe("");
  });

  // Regressão: o painel da etapa FULL imprimia sempre a frase genérica e
  // descartava o `subtitle` real do passo — que existe e está preenchido nos 17
  // passos do catálogo. O branch de fallback logo abaixo já usava `step.subtitle`.
  describe("painel da etapa FULL usa o subtitle real do passo", () => {
    const GENERIC =
      "Você está na tela real da funcionalidade. Use o painel para continuar a jornada.";

    function setupFullStep(subtitle: string | null) {
      mocks.apiGet.mockImplementation((path: string) => {
        const context = Object.fromEntries(
          new URL(`http://localhost${path}`).searchParams,
        ) as { triggerType?: string };
        return Promise.resolve(
          context.triggerType === "PROJECT_CREATED"
            ? [
                {
                  journeyId: "j1",
                  key: "tour:full-subtitle",
                  name: "Onboarding",
                  triggerId: "t1",
                  repeatPolicy: "ALWAYS",
                  dismissPolicy: "DISMISS_UNTIL_LOGIN",
                  crossProject: false,
                  steps: [
                    {
                      stepKey: "bill",
                      order: 0,
                      experience: "FULL",
                      label: "Conta recorrente",
                      subtitle,
                      skippable: true,
                      slug: "bills",
                    },
                  ],
                },
              ]
            : [],
        );
      });
    }

    async function openPanel() {
      renderRuntime();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Criar projeto" }));
      return screen.findByRole("dialog");
    }

    it("renders the step subtitle instead of the generic sentence", async () => {
      setupFullStep(
        "Cadastre uma conta que se repete todo mês (água, luz, condomínio…).",
      );
      const panel = await openPanel();

      expect(
        within(panel).getByText(
          "Cadastre uma conta que se repete todo mês (água, luz, condomínio…).",
        ),
      ).toBeInTheDocument();
      expect(within(panel).queryByText(GENERIC)).not.toBeInTheDocument();
    });

    it("falls back to the generic sentence when subtitle is null", async () => {
      setupFullStep(null);
      const panel = await openPanel();

      expect(within(panel).getByText(GENERIC)).toBeInTheDocument();
    });

    // `??` não cobre string vazia: "" passaria e renderizaria um parágrafo em
    // branco no lugar do texto de apoio.
    it.each([
      ["empty string", ""],
      ["blank string", "   "],
    ])(
      "falls back to the generic sentence when subtitle is an %s",
      async (_label, subtitle) => {
        setupFullStep(subtitle);
        const panel = await openPanel();

        expect(within(panel).getByText(GENERIC)).toBeInTheDocument();
      },
    );
  });

  // Regressão: `activeProjectType` era buscado num efeito separado, encadeado
  // DEPOIS da resposta de elegibilidade — um segundo round-trip sequencial.
  // `emit()` agora busca `getProjectType` em paralelo com `getEligibleJourneys`
  // quando o projectId já é conhecido (SCREEN_VISIT/PROJECT_CREATED).
  it("fetches the project type in parallel with eligibility, not after it resolves", async () => {
    let resolveEligible!: (value: unknown[]) => void;
    const eligiblePromise = new Promise<unknown[]>((resolve) => {
      resolveEligible = resolve;
    });
    mocks.apiGet.mockImplementation((path: string) => {
      if (path.startsWith("/journeys/eligible")) return eligiblePromise;
      if (path === "/projects/current")
        return Promise.resolve({ type: "PESSOAL" });
      return Promise.resolve([]);
    });

    renderRuntime();
    await waitFor(() =>
      expect(mocks.apiGet).toHaveBeenCalledWith("/projects/current"),
    );
    // O tipo do projeto já foi disparado ANTES da elegibilidade responder —
    // não esperou o `setActive` de um efeito encadeado.
    resolveEligible([]);
    await act(async () => {
      await Promise.resolve();
    });
  });
});
