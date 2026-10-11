import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportSessionQuestionV1 } from "@reformaflow/domain";
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
    expect(result.current.projects).toEqual([
      {
        id: "project-reforma",
        name: "Reforma elegível",
        rooms: [{ id: "room-active", name: "Cozinha" }],
      },
    ]);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.get).not.toHaveBeenCalledWith("/projects/project-owner");
    expect(mocks.get).not.toHaveBeenCalledWith("/projects/project-pessoal");
    expect(mocks.get).not.toHaveBeenCalledWith("/projects/project-deleted");
    expect(mocks.get).not.toHaveBeenCalledWith("/projects/project-denied");
  });
});
