import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PlantsPage from "./page";

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();
vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({ projectId: "project-1" }),
}));
vi.mock("@/lib/api", () => ({
  api: {
    get: (...args: unknown[]) => apiGetMock(...args),
    patch: (...args: unknown[]) => apiPatchMock(...args),
    delete: vi.fn(),
  },
}));

const plant = {
  id: "plant-1",
  nome: "Jiboia",
  localizacao: "Sala",
  observacoes: "Perto da janela",
  fotoUrl: null,
  especiePopular: "Jiboia",
  especieCientifica: "Epipremnum aureum",
  ultimaSaude: "SAUDAVEL",
  ultimoRiscoPet: "TOXICA",
  ultimoDiagnosticoEm: "2026-07-01T12:00:00Z",
};
function mockRequests(diagnosis: object | null) {
  apiGetMock.mockImplementation((url: string) => {
    if (url.endsWith("/plants")) return Promise.resolve([plant]);
    if (url.endsWith("/reminders")) return Promise.resolve([]);
    if (url.endsWith("/insights"))
      return Promise.resolve({ diagnosis, cuidadoAgendado: {} });
    return Promise.resolve([]);
  });
}

describe("PlantsPage plant profile form", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPatchMock.mockResolvedValue({});
  });
  it("combines labeled editable data and read-only AI diagnosis, preserving the PATCH contract", async () => {
    mockRequests({
      cuidados: {
        rega: "Uma vez por semana",
        luz: "Luz indireta",
        poda: "Mensal",
        adubacao: "Trimestral",
        solo: "Drenável",
      },
      saude: { status: "SAUDAVEL" },
      pet: { risco: "TOXICA" },
      problemasPossiveis: [],
    });
    render(<PlantsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    expect(
      screen.getByRole("heading", { name: "Dados da planta" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Diagnóstico e cuidados" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Nome")).toHaveValue("Jiboia");
    expect(screen.getByLabelText("Localização")).toHaveValue("Sala");
    expect(screen.getByLabelText("Observações")).toHaveValue("Perto da janela");
    expect(await screen.findByText("Uma vez por semana")).toBeInTheDocument();
    expect(
      screen.queryByDisplayValue("Uma vez por semana"),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Nome"), {
      target: { value: "Jiboia da sala" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(apiPatchMock).toHaveBeenCalledWith(
        "/projects/project-1/plants/plant-1",
        {
          nome: "Jiboia da sala",
          localizacao: "Sala",
          observacoes: "Perto da janela",
        },
      ),
    );
  });
  it("guides the user when the plant has no diagnosis", async () => {
    mockRequests(null);
    render(<PlantsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    expect(
      await screen.findByText(/adicione uma foto e faça um diagnóstico/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvar" })).toBeEnabled();
  });
});
