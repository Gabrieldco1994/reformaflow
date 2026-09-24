import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuitarParcelaModal } from "./QuitarParcelaModal";
import { MovimentacoesSection } from "./MovimentacoesSection";
import type { AccountViewResponse, AccountViewSaida } from "../_types";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

const baseProps = {
  projectId: "personal",
  foreignExpenseId: "target",
  parcelaIndex: 1,
  valorSugerido: 80_000,
  descricao: "Parcela elegível",
  dataSugerida: "2026-09-10",
  onClose: vi.fn(),
  onDone: vi.fn(),
};

function mount(
  canExecuteAction?: boolean,
  installmentSettlement?: AccountViewSaida["installmentSettlement"],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <QuitarParcelaModal
        {...baseProps}
        canExecuteAction={canExecuteAction}
        installmentSettlement={installmentSettlement}
      />
    </QueryClientProvider>,
  );
}

describe("QuitarParcelaModal #706", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.get.mockImplementation(async (url: string) => {
      if (url === "/tenant/bank-accounts")
        return [{ id: "bank", institution: "Banco sintético", last4: "5678" }];
      if (url === "/tenant/credit-cards") return [];
      throw new Error(`Unexpected GET ${url}`);
    });
    apiMock.post.mockResolvedValue({ id: "mirror" });
    apiMock.delete.mockResolvedValue({});
  });

  it.each([false, undefined])(
    "rejects a partial summary with capability=%s before any POST, even on direct form submit",
    async (capability) => {
      const { container } = mount(capability, {
        contractedCents: 80_000,
        paidCents: 40_000,
        remainingCents: 40_000,
        settlementStatus: "PARTIAL",
      });
      await screen.findByRole("option", { name: /Banco sintético/ });
      fireEvent.change(screen.getAllByRole("combobox")[0], {
        target: { value: "bank:bank" },
      });
      fireEvent.submit(container.querySelector("form")!);
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "Erro ao quitar parcela: Quitação integral indisponível para esta parcela.",
        ),
      );
      expect(apiMock.post).not.toHaveBeenCalled();
      expect(apiMock.delete).not.toHaveBeenCalled();
      expect(baseProps.onDone).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, true])(
    "keeps eligible legacy/capability=%s payments working",
    async (capability) => {
      const { container } = mount(capability);
      await screen.findByRole("option", { name: /Banco sintético/ });
      fireEvent.change(screen.getAllByRole("combobox")[0], {
        target: { value: "bank:bank" },
      });
      fireEvent.submit(container.querySelector("form")!);
      await waitFor(() => expect(baseProps.onDone).toHaveBeenCalledOnce());
      expect(apiMock.post).toHaveBeenNthCalledWith(
        1,
        "/projects/personal/expenses",
        expect.objectContaining({
          valor: 800,
          bankAccountId: "bank",
          status: "PAGO",
        }),
      );
      expect(apiMock.post).toHaveBeenNthCalledWith(
        2,
        "/projects/personal/expenses/mirror/conciliar-parcela",
        { targetExpenseId: "target", parcelaIndex: 1, realValor: 80_000 },
      );
      expect(apiMock.delete).not.toHaveBeenCalled();
    },
  );

  it("rechecks the latest Conta row when its server capability changes while the modal is open", async () => {
    const row: AccountViewSaida = {
      id: "target#1",
      kind: "saida",
      descricao: "Parcela irmã",
      data: "2026-09-10",
      valor: 80_000,
      forma: "pix",
      realizado: false,
      status: "PLANEJADO",
      isInvoice: false,
      editavel: true,
      cardLast4: null,
      bankLast4: null,
      dueMonth: null,
      tipoDespesa: "MATERIAL",
      foreignExpenseId: "target",
      parcelaIndex: 1,
      projetoOrigem: { id: "obra", name: "Obra", type: "REFORMA" },
    };
    const data: AccountViewResponse = {
      mesSelecionado: "2026-09",
      caixaHoje: 0,
      entrouMes: 0,
      saiuMes: 0,
      faltaPagarMes: 80_000,
      recebimentosPrevistosMes: 0,
      sobraPrevista: -80_000,
      devoCartaoTotal: 0,
      cartoes: [],
      contas: [],
      saidas: [row],
      entradas: [],
      comprasCartao: [],
      ticketMedio: {
        valor: 0,
        nCompras: 0,
        totalCompras: 0,
        serie6m: [],
        media6m: 0,
        deltaVsMediaPct: null,
      },
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = (currentData: AccountViewResponse) => (
      <QueryClientProvider client={client}>
        <MovimentacoesSection
          data={currentData}
          projectId="personal"
          originFilter={null}
          onClearOrigin={vi.fn()}
          onPayInvoice={vi.fn()}
          onAdjustInvoice={vi.fn()}
          onSettleWithResidual={vi.fn()}
          onUndoPayment={vi.fn()}
          summaryQuickFilter={null}
          onClearSummaryQuickFilter={vi.fn()}
        />
      </QueryClientProvider>
    );
    const rendered = render(view(data));
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    await screen.findByRole("option", { name: /Banco sintético/ });
    fireEvent.change(
      screen
        .getAllByRole("combobox")
        .find((select) => select.textContent?.includes("Banco sintético"))!,
      { target: { value: "bank:bank" } },
    );
    rendered.rerender(
      view({ ...data, saidas: [{ ...row, canExecuteAction: false }] }),
    );
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
    fireEvent.submit(rendered.container.querySelector("form")!);
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Erro ao quitar parcela: Quitação integral indisponível para esta parcela.",
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(apiMock.delete).not.toHaveBeenCalled();
  });
});
