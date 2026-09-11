import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ImportWithoutAccountModal from "./ImportWithoutAccountModal";

/**
 * #659 — revisão de possíveis duplicatas (Tier B) na importação para a Carteira
 * (sem conta). O preview de `receipts/import?origin=none` já traz
 * `possibleDuplicate` + `willImport:false`; o commit só cria a linha com
 * `decisions[].action:'import'`.
 */

vi.mock("@/lib/api", () => ({ api: { upload: vi.fn() } }));
import { api } from "@/lib/api";
const upload = () => api.upload as ReturnType<typeof vi.fn>;

const DUP_INFO = {
  externalId: "e2",
  existingId: "exp-7",
  existingOrigin: "bank:1111",
  existingDate: "2026-09-02",
  existingAmountCents: 4000,
  reason: "same_natural_key_different_source",
};

const PREVIEW = {
  total: 2,
  totalAmountCents: 6000,
  duplicated: 0,
  rows: [
    {
      externalId: "e1",
      date: "2026-09-01",
      description: "Mercado",
      amountCents: 2000,
      type: "DESPESA",
      status: "PAGO",
      willImport: true,
    },
    {
      externalId: "e2",
      date: "2026-09-02",
      description: "Farmácia",
      amountCents: 4000,
      type: "DESPESA",
      status: "PAGO",
      willImport: false,
      possibleDuplicate: DUP_INFO,
    },
  ],
};

function file() {
  return new File(["a,b\n1,2"], "extrato.csv", { type: "text/csv" });
}

async function toPreview() {
  render(
    <ImportWithoutAccountModal
      projectId="p1"
      onClose={vi.fn()}
      onCommitted={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Arquivos"), {
    target: { files: [file()] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Conferir arquivos" }));
  await screen.findByText(/Conferência:/);
}

function decisionsFromLastUpload() {
  const fd = upload().mock.calls.at(-1)![1] as FormData;
  const raw = fd.get("decisions");
  return raw ? (JSON.parse(String(raw)) as Array<Record<string, unknown>>) : [];
}

beforeEach(() => {
  upload().mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("ImportWithoutAccountModal — Tier B possível duplicata (#659)", () => {
  it("mostra o aviso + contagem no resumo; commit padrão não força a linha", async () => {
    upload()
      .mockResolvedValueOnce(PREVIEW)
      .mockResolvedValueOnce({ inserted: 1, failed: 0 });
    await toPreview();

    expect(screen.getByText(/Conferência:/)).toHaveTextContent(
      "1 possível(is) duplicata(s)",
    );
    fireEvent.click(screen.getByRole("button", { name: "Revisar Farmácia" }));
    expect(screen.getByText("⚠ Possível duplicata")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar à revisão" }));
    fireEvent.click(screen.getByRole("button", { name: "Ver resumo" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar importação" }),
    );
    await waitFor(() =>
      expect(screen.getByText("Importação concluída!")).toBeInTheDocument(),
    );
    expect(
      decisionsFromLastUpload().find(
        (d) => d.externalId === "e2" && d.action === "import",
      ),
    ).toBeUndefined();
  });

  it('opt-in explícito → commit manda action:"import" para a linha', async () => {
    upload()
      .mockResolvedValueOnce(PREVIEW)
      .mockResolvedValueOnce({ inserted: 2, failed: 0 });
    await toPreview();
    fireEvent.click(screen.getByRole("button", { name: "Revisar Farmácia" }));
    await userEvent.click(
      screen.getByRole("checkbox", { name: /importar mesmo assim/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Aplicar à revisão" }));
    fireEvent.click(screen.getByRole("button", { name: "Ver resumo" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar importação" }),
    );
    await waitFor(() =>
      expect(screen.getByText("Importação concluída!")).toBeInTheDocument(),
    );

    expect(decisionsFromLastUpload()).toContainEqual(
      expect.objectContaining({ externalId: "e2", action: "import" }),
    );
  });

  it("trocar o tipo de documento limpa o opt-in", async () => {
    upload().mockResolvedValue(PREVIEW);
    await toPreview();
    fireEvent.click(screen.getByRole("button", { name: "Revisar Farmácia" }));
    await userEvent.click(
      screen.getByRole("checkbox", { name: /importar mesmo assim/i }),
    );
    expect(
      screen.getByRole("checkbox", { name: /importar mesmo assim/i }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar à revisão" }));
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    fireEvent.click(screen.getByRole("button", { name: "Fatura de cartão" }));
    // prévia descartada — refaz e o opt-in volta desmarcado
    fireEvent.click(screen.getByRole("button", { name: "Conferir arquivos" }));
    await screen.findByText(/Conferência:/);
    fireEvent.click(screen.getByRole("button", { name: "Revisar Farmácia" }));
    expect(
      screen.getByRole("checkbox", { name: /importar mesmo assim/i }),
    ).not.toBeChecked();
  });
});
