import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MaintenanceFixture {
  id: string;
  tipo: string;
  dataRealizada: string;
  dataProxima?: string;
  quilometragem?: number;
  custo?: number;
  fornecedor?: string;
}

interface MaintenanceHistoryViewProps {
  logs: MaintenanceFixture[];
  projectType: "CASA" | "CARRO";
  onEdit: (log: MaintenanceFixture) => void;
  onDelete: (id: string) => void;
}

async function loadView() {
  const module = await vi.importActual<{
    MaintenanceHistoryView: ComponentType<MaintenanceHistoryViewProps>;
  }>("./MaintenanceHistoryView");
  return module.MaintenanceHistoryView;
}

const log: MaintenanceFixture = {
  id: "maintenance-sentinel",
  tipo: "TROCA_OLEO",
  dataRealizada: "2026-06-01T12:00:00.000Z",
  dataProxima: "2026-08-01T12:00:00.000Z",
  quilometragem: 123_456,
  custo: 78_901,
  fornecedor: "Oficina Sentinela",
};

describe("MaintenanceHistoryView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00-03:00"));
  });

  afterEach(() => vi.useRealTimers());

  it("shows every CARRO field and both actions", async () => {
    const MaintenanceHistoryView = await loadView();
    const onEdit = vi.fn();
    const onDelete = vi.fn();

    render(
      <MaintenanceHistoryView
        logs={[log]}
        projectType="CARRO"
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    const card = screen.getByRole("article", { name: "Troca de Óleo" });
    expect(card).toHaveTextContent("01/06/2026");
    expect(card).toHaveTextContent("01/08/2026");
    expect(card).toHaveTextContent("123.456 km");
    expect(card).toHaveTextContent("R$ 789,01");
    expect(card).toHaveTextContent("Oficina Sentinela");

    fireEvent.click(within(card).getByRole("button", { name: /Ações/ }));
    fireEvent.click(within(card).getByRole("menuitem", { name: "Editar" }));

    fireEvent.click(within(card).getByRole("button", { name: /Ações/ }));
    fireEvent.click(within(card).getByRole("menuitem", { name: "Excluir" }));

    expect(onEdit).toHaveBeenCalledWith(log);
    expect(onDelete).toHaveBeenCalledWith("maintenance-sentinel");
  });

  it("never exposes quilometragem for CASA, even if the API row contains it", async () => {
    const MaintenanceHistoryView = await loadView();
    render(
      <MaintenanceHistoryView
        logs={[{ ...log, tipo: "PINTURA" }]}
        projectType="CASA"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const card = screen.getByRole("article", { name: "Pintura" });
    expect(card).not.toHaveTextContent(/km/i);
    expect(card).not.toHaveTextContent("123.456");
  });
});
