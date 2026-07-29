import { render, screen, waitFor, within } from "@testing-library/react";
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
        data-journey-action="expense.new"
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
      <Fixture />
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
                    stepKey: "a",
                    order: 0,
                    experience: "SUMMARY",
                    label: "A",
                    subtitle: "Resumo",
                    skippable: true,
                  },
                  {
                    stepKey: "b",
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
              stepKey: "a",
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
                    stepKey: "a",
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
                      stepKey: "a",
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
});
