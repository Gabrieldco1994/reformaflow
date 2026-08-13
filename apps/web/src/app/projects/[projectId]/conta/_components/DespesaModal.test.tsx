import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Expense } from "@/types";
import { DespesaModal } from "./DespesaModal";

const apiGet = vi.fn();
const apiPatch = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    get: (path: string) => apiGet(path),
    patch: (path: string, data: unknown) => apiPatch(path, data),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../expenses/_components/ExpenseFormModal", () => ({
  ExpenseFormModal: ({
    onSubmit,
    formVinculos,
    setFormVinculos,
  }: {
    onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
    formVinculos: {
      creditCardId: string;
      bankAccountId: string;
      linkedExpenseId: string;
      creditCardTouched?: boolean;
      bankAccountTouched?: boolean;
    };
    setFormVinculos: (value: typeof formVinculos) => void;
  }) => (
    <form aria-label="editar despesa" onSubmit={onSubmit}>
      <input name="tipoDespesa" defaultValue="OUTROS" />
      <input name="valor" defaultValue="100,00" />
      <input name="quantidade" defaultValue="1" />
      <input name="formaPagamento" defaultValue="A_VISTA" />
      <button
        type="button"
        onClick={() =>
          setFormVinculos({
            ...formVinculos,
            creditCardId: "",
            creditCardTouched: true,
          })
        }
      >
        Selecionar Nenhum cartão
      </button>
      <button
        type="button"
        onClick={() =>
          setFormVinculos({
            ...formVinculos,
            bankAccountId: "",
            bankAccountTouched: true,
          })
        }
      >
        Selecionar Nenhuma conta
      </button>
      <button type="submit">Salvar</button>
    </form>
  ),
}));

const editing: Expense = {
  id: "rateio-source",
  tipoDespesa: "OUTROS",
  valor: 10_000,
  quantidade: 1,
  valorTotal: 10_000,
  formaPagamento: "A_VISTA",
  dataPagamento: "2026-08-10",
  status: "PAGO",
  cardLast4: "1234",
  linkedExpenseId: "first-rateio-target",
};

function renderModal() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <DespesaModal
        open
        onClose={vi.fn()}
        projectId="pessoal-1"
        editExpenseId={editing.id}
      />
    </QueryClientProvider>,
  );
}

describe("DespesaModal — preserva a origem de pagamento ao editar", () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPatch.mockReset();
    apiGet.mockResolvedValue(editing);
    apiPatch.mockResolvedValue(undefined);
  });

  it("salva somente metadados sem alterar vínculos intocados", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(await screen.findByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledOnce());
    const payload = apiPatch.mock.calls[0][1];
    expect(payload.creditCardId).toBeUndefined();
    expect(payload.bankAccountId).toBeUndefined();
    expect(payload.linkedExpenseId).toBe("first-rateio-target");
  });

  it("envia null quando o usuário seleciona Nenhum explicitamente", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(
      await screen.findByRole("button", { name: "Selecionar Nenhum cartão" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Selecionar Nenhuma conta" }),
    );
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledOnce());
    const payload = apiPatch.mock.calls[0][1];
    expect(payload.creditCardId).toBeNull();
    expect(payload.bankAccountId).toBeNull();
    expect(payload.linkedExpenseId).toBe("first-rateio-target");
  });
});
