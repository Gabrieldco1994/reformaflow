import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceitaModal, type ReceitaEditing } from "./ReceitaModal";

const apiMocks = vi.hoisted(() => ({
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const PROJECT_ID = "project-receipt";
const INITIAL_BALANCE_CENTS = 425_000;
const RECEIPT_CENTS = 680_000;
const UPDATED_BALANCE_CENTS = INITIAL_BALANCE_CENTS + RECEIPT_CENTS;

const CURRENT_QUERY_KEYS = [
  ["expenses", PROJECT_ID, "all"],
  ["dashboard", PROJECT_ID],
  ["cash-flow", PROJECT_ID, "2026-08"],
  ["cross-project-expenses", PROJECT_ID],
  ["rateio-detalhe", "expense-1"],
  ["account-view", PROJECT_ID, "2026-08"],
  ["account-view-yearly", PROJECT_ID, "2026"],
  ["card-invoices-yearly", PROJECT_ID, "2026"],
  ["monthly-overview", PROJECT_ID, "2026-08"],
  ["pendencias-financeiras", PROJECT_ID],
  ["pendencias", PROJECT_ID],
  ["receipts", PROJECT_ID, "2026-08"],
] as const;

const DRE_QUERY_KEY = ["dre-overview", PROJECT_ID, "2026"] as const;

const CTA_EDITING: ReceitaEditing = {
  id: "receipt-1",
  valor: 10000,
  data: "2026-08-23T00:00:00.000Z",
  tipo: "SALARIO",
  status: "EM_CAIXA",
};

function renderModal(editing?: ReceitaEditing) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const onClose = vi.fn();

  for (const queryKey of CURRENT_QUERY_KEYS) {
    queryClient.setQueryData(queryKey, { cached: true });
  }
  queryClient.setQueryData(DRE_QUERY_KEY, {
    anual: {
      saldoAcumuladoSerie: [
        { mes: "2026-08", saldoProjetado: INITIAL_BALANCE_CENTS },
      ],
    },
  });
  const fetchDre = vi.fn().mockResolvedValue({
    anual: {
      saldoAcumuladoSerie: [
        { mes: "2026-08", saldoProjetado: UPDATED_BALANCE_CENTS },
      ],
    },
  });
  const observer = new QueryObserver(queryClient, {
    queryKey: DRE_QUERY_KEY,
    queryFn: fetchDre,
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => undefined);

  render(
    <QueryClientProvider client={queryClient}>
      <ReceitaModal
        open
        onClose={onClose}
        projectId={PROJECT_ID}
        editing={editing}
        defaultData="2026-08-23"
      />
    </QueryClientProvider>,
  );

  return { queryClient, fetchDre, onClose, unsubscribe };
}

async function expectFinancialQueriesInvalidated(queryClient: QueryClient) {
  await waitFor(() => {
    for (const queryKey of CURRENT_QUERY_KEYS) {
      expect(
        queryClient.getQueryState(queryKey)?.isInvalidated,
        queryKey.join("/"),
      ).toBe(true);
    }
  });
}

async function expectDreRefetched(
  queryClient: QueryClient,
  fetchDre: ReturnType<typeof vi.fn>,
) {
  await waitFor(() => expect(fetchDre).toHaveBeenCalledOnce());
  expect(queryClient.getQueryData(DRE_QUERY_KEY)).toMatchObject({
    anual: {
      saldoAcumuladoSerie: [
        { mes: "2026-08", saldoProjetado: UPDATED_BALANCE_CENTS },
      ],
    },
  });
}

describe("ReceitaModal", () => {
  it.each([
    { mode: "criação", editingReceipt: undefined, submitLabel: "Criar" },
    { mode: "edição", editingReceipt: CTA_EDITING, submitLabel: "Salvar" },
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

describe("ReceitaModal — invalidação das visões financeiras", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalida o DRE e preserva as invalidações atuais após criar um recebimento", async () => {
    apiMocks.post.mockResolvedValueOnce({ id: "receipt-created" });
    const { queryClient, fetchDre, onClose, unsubscribe } = renderModal();
    expect(fetchDre).not.toHaveBeenCalled();

    fireEvent.change(document.querySelector('input[name="valor"]')!, {
      target: { value: "6.800,00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Criar" }));

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/receipts`,
        expect.objectContaining({ valor: 6800, status: "EM_CAIXA" }),
      ),
    );
    await expectFinancialQueriesInvalidated(queryClient);
    await expectDreRefetched(queryClient, fetchDre);
    expect(onClose).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("invalida o DRE e preserva as invalidações atuais após atualizar um recebimento", async () => {
    apiMocks.patch.mockResolvedValueOnce({ id: "receipt-edited" });
    const editing: ReceitaEditing = {
      id: "receipt-1",
      valor: 680_000,
      data: "2026-08-20T00:00:00.000Z",
      tipo: "SALARIO",
      status: "EM_CAIXA",
      descricao: "Salário",
    };
    const { queryClient, fetchDre, onClose, unsubscribe } =
      renderModal(editing);
    expect(fetchDre).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(apiMocks.patch).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/receipts/${editing.id}`,
        expect.objectContaining({ valor: 6800, status: "EM_CAIXA" }),
      ),
    );
    await expectFinancialQueriesInvalidated(queryClient);
    await expectDreRefetched(queryClient, fetchDre);
    expect(onClose).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
