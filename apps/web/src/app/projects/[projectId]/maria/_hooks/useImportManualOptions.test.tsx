import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectType, type ImportSessionQuestionV1 } from "@reformaflow/domain";
import { ProjectProvider } from "@/contexts/project-context";
import { ImportFocusedQuestion } from "../_components/ImportFocusedQuestion";
import { useImportManualOptions } from "./useImportManualOptions";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  hasProjectType: vi.fn(),
  hasProjectAccess: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: { get: mocks.get } }));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    hasProjectType: mocks.hasProjectType,
    hasProjectAccess: mocks.hasProjectAccess,
  }),
}));

const question: ImportSessionQuestionV1 = {
  id: "question-targets",
  field: "targets",
  lineIds: ["line-1"],
  text: "Qual o destino?",
};

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useImportManualOptions("user-1", "session-1", "project-owner", question),
    { wrapper },
  );
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.hasProjectType.mockReset();
  mocks.hasProjectAccess.mockReset();
  mocks.hasProjectType.mockReturnValue(true);
  mocks.hasProjectAccess.mockReturnValue(true);
});
afterEach(cleanup);

describe("manual import target options", () => {
  it("loads rooms only for accessible active REFORMA destinations other than the owner", async () => {
    mocks.hasProjectAccess.mockImplementation(
      (id: string) => id !== "project-denied",
    );
    mocks.get.mockImplementation(async (path: string) => {
      if (path === "/projects")
        return [
          {
            id: "project-owner",
            name: "Projeto proprietário",
            type: "REFORMA",
            deletedAt: null,
          },
          {
            id: "project-reforma",
            name: "Reforma elegível",
            type: "REFORMA",
            deletedAt: null,
          },
          {
            id: "project-pessoal",
            name: "Pessoal",
            type: "PESSOAL",
            deletedAt: null,
          },
          {
            id: "project-deleted",
            name: "Reforma excluída",
            type: "REFORMA",
            deletedAt: "2026-10-10T00:00:00.000Z",
          },
          {
            id: "project-denied",
            name: "Reforma sem acesso",
            type: "REFORMA",
            deletedAt: null,
          },
        ];
      if (path === "/projects/project-reforma")
        return {
          id: "project-reforma",
          name: "Reforma elegível",
          type: "REFORMA",
          deletedAt: null,
          rooms: [
            { id: "room-active", name: "Cozinha", deletedAt: null },
            {
              id: "room-deleted",
              name: "Quarto excluído",
              deletedAt: "2026-10-10T00:00:00.000Z",
            },
          ],
        };
      throw new Error(`Unexpected request: ${path}`);
    });

    const { result } = setup();
    await waitFor(() => expect(result.current.pending).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.ownerProjectId).toBe("project-owner");
    expect(result.current.projects).toEqual([
      {
        id: "project-reforma",
        name: "Reforma elegível",
        projectType: ProjectType.REFORMA,
        active: true,
        deletedAt: null,
        eligible: true,
        rooms: [{ id: "room-active", name: "Cozinha" }],
      },
    ]);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.get).not.toHaveBeenCalledWith("/projects/project-owner");
    expect(mocks.get).not.toHaveBeenCalledWith("/projects/project-pessoal");
    expect(mocks.get).not.toHaveBeenCalledWith("/projects/project-deleted");
    expect(mocks.get).not.toHaveBeenCalledWith("/projects/project-denied");
  });

  it("renders the eligible project and its own rooms through the real hook contract", async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === "/projects")
        return [
          {
            id: "project-owner",
            name: "Projeto proprietário",
            type: "PESSOAL",
            deletedAt: null,
          },
          {
            id: "project-reforma",
            name: "Reforma elegível",
            type: "REFORMA",
            deletedAt: null,
          },
        ];
      if (path === "/projects/project-reforma")
        return {
          id: "project-reforma",
          name: "Reforma elegível",
          type: "REFORMA",
          deletedAt: null,
          rooms: [
            { id: "room-active", name: "Cozinha", deletedAt: null },
            { id: "room-deleted", name: "Quarto", deletedAt: "2026-10-10" },
          ],
        };
      throw new Error(`Unexpected request: ${path}`);
    });
    const onAnswer = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    function HookToComponent() {
      const options = useImportManualOptions(
        "user-1",
        "session-1",
        "project-owner",
        question,
      );
      return (
        <ProjectProvider
          value={{
            projectId: "project-owner",
            projectName: "Projeto proprietário",
            projectType: ProjectType.PESSOAL,
          }}
        >
          <ImportFocusedQuestion
            question={question}
            lines={[
              {
                id: "line-1",
                titulo: "Compra documental",
                amountCents: 20_696,
              },
            ]}
            inputLabel="Destino"
            inputHint="Confira"
            ownerProjectId={options.ownerProjectId ?? undefined}
            targetProjects={options.projects}
            optionsPending={options.pending}
            optionsError={options.error}
            onAnswer={onAnswer}
          />
        </ProjectProvider>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <HookToComponent />
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole("radio", {
        name: "Enviar o valor integral para outro projeto",
      }),
    );
    const project = screen.getByLabelText("Projeto de destino");
    await waitFor(() =>
      expect(project).toHaveDisplayValue("Escolha o projeto"),
    );
    expect(
      screen.getByRole("option", { name: "Reforma elegível" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Projeto proprietário" }),
    ).not.toBeInTheDocument();

    fireEvent.change(project, { target: { value: "project-reforma" } });
    const room = screen.getByLabelText("Cômodo (opcional)");
    expect(screen.getByRole("option", { name: "Cozinha" })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Quarto" }),
    ).not.toBeInTheDocument();
    fireEvent.change(room, { target: { value: "room-active" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Conferir informação" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar informação" }));

    expect(onAnswer).toHaveBeenCalledWith({
      id: "question-targets",
      text: "target",
      draftAnswer: {
        field: "targets",
        value: [
          {
            projectId: "project-reforma",
            roomId: "room-active",
            amountCents: 20_696,
          },
        ],
      },
    });
  });
});
