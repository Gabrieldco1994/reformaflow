import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReceitaModal, type ReceitaEditing } from "./ReceitaModal";

const editing: ReceitaEditing = {
  id: "receipt-1",
  valor: 10000,
  data: "2026-08-23T00:00:00.000Z",
  tipo: "SALARIO",
  status: "EM_CAIXA",
};

function renderModal(editingReceipt?: ReceitaEditing) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <ReceitaModal
        open
        onClose={vi.fn()}
        projectId="pessoal-1"
        editing={editingReceipt}
      />
    </QueryClientProvider>,
  );
}

describe("ReceitaModal", () => {
  it.each([
    { mode: "criação", editingReceipt: undefined, submitLabel: "Criar" },
    { mode: "edição", editingReceipt: editing, submitLabel: "Salvar" },
  ])(
    "mantém os CTAs de $mode com altura mínima de 44px",
    ({ editingReceipt, submitLabel }) => {
      renderModal(editingReceipt);

      expect(screen.getByRole("button", { name: "Cancelar" })).toHaveClass(
        "min-h-11",
      );
      expect(screen.getByRole("button", { name: submitLabel })).toHaveClass(
        "min-h-11",
      );
    },
  );
});
