import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { Expense, ExpenseFormData } from "@/types";
import { DespesaModal } from "../conta/_components/DespesaModal";
import { ExpensesView } from "./ExpensesView";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), patch: vi.fn() },
}));
vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({ projectId: "pessoal-1", projectType: "PESSOAL" }),
}));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { name: "Teste" }, hasModule: () => true }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/pessoal-1/expenses",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("period=ALL&view=general"),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Imported remainder: the ledger has 2/3 and 3/3, not a new purchase of 1/2 + 2/2.
// The expense DTO carries the remaining count/value, not the ledger labels/IDs.
const imported: Expense = {
  id: "imported-remainder",
  importId: "synthetic-import",
  tipoDespesa: "OUTROS",
  titulo: "Compra importada",
  valor: 20_000,
  quantidade: 1,
  valorTotal: 20_000,
  formaPagamento: "PARCELADO",
  quantidadeParcela: 2,
  dataPagamento: "2026-09-10T00:00:00.000Z",
  dataInicioParcela: "2026-09-10T00:00:00.000Z",
  dataCompra: "2026-08-05T00:00:00.000Z",
  status: "PLANEJADO",
  cardLast4: "1234",
  recorrente: false,
  recorrenciaFim: null,
};

type Surface = "ExpensesView" | "DespesaModal";

async function openEditor(surface: Surface, expense = imported) {
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path === `/projects/pessoal-1/expenses/${expense.id}`) return expense;
    if (path.includes("/expenses?pageSize="))
      return {
        items: [expense],
        total: 1,
        page: 1,
        pageSize: 2000,
        totalPages: 1,
      };
    if (path === "/projects/pessoal-1")
      return { id: "pessoal-1", name: "Pessoal", type: "PESSOAL", rooms: [] };
    if (path.endsWith("/rateio")) return { rateado: false, allocations: [] };
    return [];
  });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={client}>
      {surface === "ExpensesView" ? (
        <ExpensesView lockedEixo="competencia" />
      ) : (
        <DespesaModal
          open
          onClose={vi.fn()}
          projectId="pessoal-1"
          editExpenseId={expense.id}
        />
      )}
    </QueryClientProvider>,
  );
  if (surface === "ExpensesView") {
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Editar completo" }))[0],
    );
  }
  const save = await screen.findByRole("button", { name: "Salvar" });
  return save.closest("form")!;
}

function change(form: HTMLFormElement, name: string, value: string) {
  fireEvent.change(form.querySelector(`[name="${name}"]`)!, {
    target: { value },
  });
}

async function submit(form: HTMLFormElement) {
  fireEvent.submit(form);
  await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.patch).mock.calls[0][0]).toBe(
    "/projects/pessoal-1/expenses/imported-remainder",
  );
  // Same JSON boundary as api.patch: undefined fields are omitted on the wire.
  return JSON.parse(
    JSON.stringify(vi.mocked(api.patch).mock.calls[0][1]),
  ) as ExpenseFormData;
}

function expectUntouchedFinancials(body: ExpenseFormData, expense: Expense) {
  expect(body).toMatchObject({
    valor: expense.valor / 100,
    quantidade: expense.quantidade,
    formaPagamento: expense.formaPagamento,
    quantidadeParcela: expense.quantidadeParcela,
    dataInicioParcela: expense.dataInicioParcela?.slice(0, 10),
    dataCompra: expense.dataCompra?.slice(0, 10),
    status: expense.status,
    recorrente: false,
    recorrenciaFim: null,
  });
  if ("dataPagamento" in body) {
    expect(body.dataPagamento?.slice(0, 10)).toBe(
      expense.dataPagamento?.slice(0, 10),
    );
  }
  expect(body).not.toHaveProperty("creditCardId");
  expect(body).not.toHaveProperty("bankAccountId");
  expect(body).not.toHaveProperty("paidParcelas");
  expect(body).not.toHaveProperty("installmentDateOverrides");
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(api.patch).mockResolvedValue(undefined);
});

describe.each<Surface>(["ExpensesView", "DespesaModal"])(
  "%s — PATCH real (#697)",
  (surface) => {
    it.each(["titulo", "tipoDespesa"])(
      "preserva finanças ao editar só %s",
      async (field) => {
        const form = await openEditor(surface);
        const value = field === "titulo" ? "Novo título" : "ALIMENTACAO";
        change(form, field, value);
        const body = await submit(form);
        expect(body[field as "titulo" | "tipoDespesa"]).toBe(value);
        expectUntouchedFinancials(body, imported);
      },
    );

    it.each(["ISO", "date-only"])(
      "salvar sem alterações preserva restante e datas %s",
      async (format) => {
        const expense = {
          ...imported,
          status: "PAGO" as const,
          ...(format === "date-only"
            ? {
                dataPagamento: imported.dataPagamento!.slice(0, 10),
                dataInicioParcela: imported.dataInicioParcela!.slice(0, 10),
                dataCompra: imported.dataCompra!.slice(0, 10),
              }
            : {}),
        };
        expectUntouchedFinancials(
          await submit(await openEditor(surface, expense)),
          expense,
        );
      },
    );

    it.each([
      ["valor", "250,00", 250],
      ["quantidade", "2", 2],
      ["quantidadeParcela", "4", 4],
      ["quantidadeParcela", "", null],
      ["dataInicioParcela", "2026-10-11", "2026-10-11"],
      ["dataInicioParcela", "", null],
      ["dataCompra", "2026-08-06", "2026-08-06"],
      ["dataCompra", "", null],
    ])(
      "envia edição explícita de %s para %s",
      async (field, value, expected) => {
        const form = await openEditor(surface);
        change(form, field, String(value));
        expect(await submit(form)).toHaveProperty(field, expected);
      },
    );

    it.each(["2026-10-12", ""])(
      "ao trocar para PIX envia data de pagamento '%s'",
      async (date) => {
        const form = await openEditor(surface);
        change(form, "formaPagamento", "PIX");
        change(form, "dataPagamento", date);
        expect(await submit(form)).toMatchObject({
          formaPagamento: "PIX",
          dataPagamento: date || null,
          quantidadeParcela: null,
          dataInicioParcela: null,
        });
      },
    );

    it.each([
      ["A_VISTA", "PARCELADO"],
      ["PARCELADO", "QUINZENAL"],
    ])(
      "trocar %s para %s limpa a antiga data de pagamento",
      async (from, to) => {
        const form = await openEditor(surface, {
          ...imported,
          formaPagamento: from,
        });
        change(form, "formaPagamento", to);
        expect(await submit(form)).toMatchObject({
          formaPagamento: to,
          dataPagamento: null,
        });
      },
    );
  },
);

it.each<Expense["status"]>(["PLANEJADO", "PAGO"])(
  "ExpensesView envia alteração explícita de status %s",
  async (status) => {
    await openEditor("ExpensesView", {
      ...imported,
      formaPagamento: "A_VISTA",
      quantidadeParcela: undefined,
      dataInicioParcela: undefined,
      status,
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(
      screen.getAllByTitle("Clique para alternar entre Planejado e Pago")[0],
    );
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith(
      "/projects/pessoal-1/expenses/imported-remainder",
      { status: status === "PAGO" ? "PLANEJADO" : "PAGO" },
    );
  },
);
