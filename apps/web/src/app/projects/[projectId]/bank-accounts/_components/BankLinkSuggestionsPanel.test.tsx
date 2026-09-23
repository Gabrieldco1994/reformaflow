import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { Expense, ParcelaFundingResult } from "@/types";
import BankLinkSuggestionsPanel from "./BankLinkSuggestionsPanel";
import { DespesaModal } from "../../conta/_components/DespesaModal";
import { ExpensesView } from "../../expenses/ExpensesView";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({ projectId: "pessoal", projectType: "PESSOAL" }),
}));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { name: "Teste" }, hasModule: () => true }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/pessoal/expenses",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("period=ALL&view=general"),
}));

const source: Expense = {
  id: "source",
  projectId: "pessoal",
  tipoDespesa: "OUTROS",
  titulo: "Débito existente",
  formaPagamento: "PIX",
  status: "PAGO",
  valor: 80_000,
  quantidade: 1,
  valorTotal: 80_000,
  bankLast4: "1234",
  dataPagamento: "2026-09-10",
  sourceAvailableCents: 40_000,
};
const target: Expense = {
  id: "target",
  projectId: "obra",
  project: { id: "obra", name: "Obra", type: "REFORMA" },
  tipoDespesa: "OUTROS",
  titulo: "Contrato",
  formaPagamento: "PARCELADO",
  status: "PLANEJADO",
  valor: 80_000,
  quantidade: 1,
  valorTotal: 80_000,
  quantidadeParcela: 1,
  installmentSettlements: [
    {
      parcelaIndex: 0,
      dueDate: "2026-10-10T00:00:00.000Z",
      contractedCents: 80_000,
      paidCents: 0,
      remainingCents: 80_000,
      settlementStatus: "UNPAID",
      contributions: [],
    },
  ],
};
const result: ParcelaFundingResult = {
  ok: true,
  settlementId: "funding-a",
  state: "ACTIVE",
  replayed: false,
  sourceId: "source",
  targetId: "target",
  parcelaIndex: 0,
  amountCents: 40_000,
  contractedCents: 80_000,
  paidCents: 40_000,
  remainingCents: 40_000,
  sourceAvailableCents: 0,
  settlementStatus: "PARTIAL",
};
let currentSource: Expense;
let currentTarget: Expense;
let otherTarget: Expense;
let omitPaidTarget: boolean;
let serverResult: ParcelaFundingResult | undefined;
const contribution = {
  settlementId: "funding-a",
  sourceId: "source",
  amountCents: 40_000,
  paymentDate: "2026-09-10T00:00:00.000Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
  currentSource = { ...source };
  currentTarget = { ...target };
  otherTarget = { ...target, id: "target-b", titulo: "Contrato B" };
  omitPaidTarget = false;
  serverResult = undefined;
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.endsWith("/suggest-links"))
      return [
        {
          expense: {
            ...source,
            data: source.dataPagamento,
            valor: source.valorTotal,
          },
          suggestions: [
            {
              expenseId: "target",
              projectId: "obra",
              projectName: "Obra",
              projectType: "REFORMA",
              titulo: "Contrato",
              valor: 80_000,
              data: "2026-10-10",
              installmentCurrent: 1,
              installmentTotal: 1,
            },
          ],
        },
      ];
    if (path === "/projects/pessoal/expenses/source")
      return serverResult
        ? {
            ...currentSource,
            sourceAvailableCents: serverResult.sourceAvailableCents,
          }
        : currentSource;
    if (path.includes("/expenses?pageSize="))
      return {
        items: [currentSource],
        total: 1,
        page: 1,
        pageSize: 2000,
        totalPages: 1,
      };
    if (path === "/projects/pessoal")
      return { id: "pessoal", name: "Pessoal", type: "PESSOAL", rooms: [] };
    if (path.includes("/expenses/cross-project"))
      return [
        ...(omitPaidTarget && serverResult?.settlementStatus === "PAID"
          ? []
          : [
              serverResult
                ? {
                    ...currentTarget,
                    installmentSettlements: [
                      {
                        ...currentTarget.installmentSettlements![0],
                        paidCents: serverResult.paidCents,
                        remainingCents: serverResult.remainingCents,
                        settlementStatus: serverResult.settlementStatus,
                      },
                    ],
                  }
                : currentTarget,
            ]),
        otherTarget,
      ];
    if (path.endsWith("/rateio")) return { rateado: false };
    return [];
  });
  vi.mocked(api.post).mockImplementation(async () => {
    serverResult = result;
    return result;
  });
  vi.mocked(api.delete).mockImplementation(async () => {
    serverResult = {
      ...result,
      state: "REVERSED",
      paidCents: 0,
      remainingCents: 80_000,
      sourceAvailableCents: 40_000,
      settlementStatus: "UNPAID",
    };
    return serverResult;
  });
});
afterEach(() => vi.useRealTimers());

async function open(surface: "bank" | "editor" | "view", selectTarget = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const { unmount } = render(
    <QueryClientProvider client={client}>
      {surface === "bank" ? (
        <BankLinkSuggestionsPanel
          projectId="pessoal"
          account={{
            id: "account",
            institution: "Banco",
            nickname: "Conta",
            last4: "1234",
            agency: null,
            accountNumber: null,
          }}
          onClose={vi.fn()}
        />
      ) : surface === "editor" ? (
        <DespesaModal
          open
          projectId="pessoal"
          editExpenseId="source"
          onClose={vi.fn()}
        />
      ) : (
        <ExpensesView lockedEixo="competencia" />
      )}
    </QueryClientProvider>,
  );
  if (surface === "bank")
    fireEvent.click(await screen.findByRole("button", { name: "Vincular" }));
  if (surface === "view") {
    const row = (await screen.findByText("Débito existente")).closest(
      "div.group",
    )!;
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", {
        name: "Editar completo",
      }),
    );
  }
  const select = await screen.findByLabelText("Parcela a pagar");
  if (selectTarget) {
    await waitFor(() =>
      expect(select.querySelector('option[value="target#0"]')).not.toBeNull(),
    );
    fireEvent.change(select, { target: { value: "target#0" } });
  }
  return { client, invalidate, unmount };
}

describe.each(["bank", "editor", "view"] as const)(
  "existing debit funding — %s",
  (surface) => {
    it("confirms min(available, remaining), never creates an Expense, and undoes only this contribution", async () => {
      const { invalidate } = await open(surface);
      expect(screen.getByLabelText("Valor a aplicar (R$)")).toHaveValue(400);
      fireEvent.click(
        screen.getByRole("button", { name: "Confirmar pagamento parcial" }),
      );
      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
      expect(api.post).toHaveBeenCalledWith(
        "/projects/pessoal/expenses/source/conciliar-parcela",
        {
          mode: "ADDITIVE",
          targetExpenseId: "target",
          parcelaIndex: 0,
          amountCents: 40_000,
          requestId: expect.any(String),
        },
      );

      expect(api.patch).not.toHaveBeenCalled();
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Parcialmente pago",
      );
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["expenses", "obra"],
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["account-view", "pessoal"],
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Desfazer esta contribuição" }),
      );
      await waitFor(() =>
        expect(api.delete).toHaveBeenCalledWith(
          "/projects/pessoal/expenses/source/conciliar-parcela/funding-a",
        ),
      );
      expect(api.post).toHaveBeenCalledTimes(1);
    });

    it("restores only this source's contribution after remount, even on a paid target with zero source budget", async () => {
      const { unmount } = await open(surface);
      fireEvent.click(
        screen.getByRole("button", { name: "Confirmar pagamento parcial" }),
      );
      await screen.findByRole("status");
      const otherContribution = {
        ...contribution,
        settlementId: "funding-other",
        sourceId: "other-source",
      };
      currentTarget = {
        ...target,
        status: "PAGO",
        installmentSettlements: [
          {
            ...target.installmentSettlements![0],
            contributions: [contribution, otherContribution],
          },
        ],
      };
      serverResult = {
        ...result,
        paidCents: 80_000,
        remainingCents: 0,
        settlementStatus: "PAID",
      };
      unmount();
      await open(surface, false);
      const undo = await screen.findByRole("button", {
        name: "Desfazer esta contribuição",
      });
      expect(
        screen.getAllByRole("button", { name: "Desfazer esta contribuição" }),
      ).toHaveLength(1);
      expect(
        screen.getByRole("button", { name: "Confirmar pagamento parcial" }),
      ).toBeDisabled();
      vi.mocked(api.delete).mockImplementationOnce(async () => {
        currentTarget = {
          ...currentTarget,
          installmentSettlements: [
            {
              ...currentTarget.installmentSettlements![0],
              contributions: [otherContribution],
            },
          ],
        };
        serverResult = {
          ...result,
          state: "REVERSED",
          sourceAvailableCents: 40_000,
        };
        return serverResult;
      });
      fireEvent.click(undo);
      await waitFor(() =>
        expect(vi.mocked(api.delete).mock.calls).toEqual([
          ["/projects/pessoal/expenses/source/conciliar-parcela/funding-a"],
        ]),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Desfazer esta contribuição" }),
        ).toBeNull(),
      );
      expect(api.post).toHaveBeenCalledTimes(1);
      expect(api.patch).not.toHaveBeenCalled();
    });

    it("offers the untouched UNPAID sibling alongside an installment with history", async () => {
      currentTarget = {
        ...target,
        valor: 160_000,
        valorTotal: 160_000,
        quantidadeParcela: 2,
        installmentSettlements: [
          {
            ...target.installmentSettlements![0],
            paidCents: 40_000,
            remainingCents: 40_000,
            settlementStatus: "PARTIAL",
            contributions: [{ ...contribution, sourceId: "other-source" }],
          },
          {
            ...target.installmentSettlements![0],
            parcelaIndex: 1,
            dueDate: "2026-11-10T00:00:00.000Z",
          },
        ],
      };
      vi.mocked(api.post).mockResolvedValueOnce({ ...result, parcelaIndex: 1 });
      await open(surface);
      fireEvent.change(screen.getByLabelText("Parcela a pagar"), {
        target: { value: "target#1" },
      });
      expect(screen.getByLabelText("Valor a aplicar (R$)")).toHaveValue(400);
      expect(
        screen.queryByRole("button", { name: "Desfazer esta contribuição" }),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Confirmar pagamento parcial" }),
      );
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith(
          "/projects/pessoal/expenses/source/conciliar-parcela",
          {
            mode: "ADDITIVE",
            targetExpenseId: "target",
            parcelaIndex: 1,
            amountCents: 40_000,
            requestId: expect.any(String),
          },
        ),
      );
      expect(api.post).toHaveBeenCalledTimes(1);
      expect(api.patch).not.toHaveBeenCalled();
    });

    it("deduplicates a recent confirmation against history and hides it when the server redacts contributions", async () => {
      currentTarget = {
        ...target,
        installmentSettlements: [
          {
            ...target.installmentSettlements![0],
            contributions: [contribution],
          },
        ],
      };
      const { client } = await open(surface);
      fireEvent.click(
        screen.getByRole("button", { name: "Confirmar pagamento parcial" }),
      );
      await screen.findByRole("status");
      expect(
        screen.getAllByRole("button", { name: "Desfazer esta contribuição" }),
      ).toHaveLength(1);
      currentTarget = {
        ...target,
        installmentSettlements: [
          {
            ...target.installmentSettlements![0],
            contributions: undefined,
          },
        ],
      };
      await act(async () => {
        await client.invalidateQueries({
          queryKey: ["cross-project-expenses"],
        });
      });
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Desfazer esta contribuição" }),
        ).toBeNull(),
      );
      expect(api.delete).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      "replays a lost response after refresh, including a removed paid target: %s",
      async (removed) => {
        omitPaidTarget = removed;
        if (removed) {
          currentTarget = {
            ...target,
            installmentSettlements: [
              {
                ...target.installmentSettlements![0],
                paidCents: 40_000,
                remainingCents: 40_000,
                settlementStatus: "PARTIAL",
                contributions: [
                  {
                    ...contribution,
                    sourceId: "other-source",
                    settlementId: "funding-other",
                  },
                ],
              },
            ],
          };
        }
        const applied: ParcelaFundingResult = removed
          ? {
              ...result,
              paidCents: 80_000,
              remainingCents: 0,
              settlementStatus: "PAID",
            }
          : result;
        vi.mocked(api.post)
          .mockImplementationOnce(async () => {
            serverResult = applied;
            throw new Error("Resposta perdida");
          })
          .mockResolvedValueOnce({ ...applied, replayed: true });
        const { client } = await open(surface);
        fireEvent.click(
          screen.getByRole("button", { name: "Confirmar pagamento parcial" }),
        );
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "Resposta perdida",
        );
        const original = vi.mocked(api.post).mock.calls[0];
        await act(async () => {
          await client.invalidateQueries({ queryKey: ["expense"] });
          await client.invalidateQueries({
            queryKey: ["cross-project-expenses"],
          });
        });
        if (removed) {
          await waitFor(() =>
            expect(
              screen
                .getByLabelText("Parcela a pagar")
                .querySelector('option[value="target#0"]'),
            ).toBeNull(),
          );
        } else {
          await waitFor(() =>
            expect(
              screen.getByLabelText("Valor a aplicar (R$)"),
            ).toHaveAttribute("max", "0"),
          );
        }
        expect(screen.getByLabelText("Valor a aplicar (R$)")).toHaveValue(400);
        const retry = screen.getByRole("button", {
          name: "Confirmar pagamento parcial",
        });
        expect(retry).toBeEnabled();
        fireEvent.click(retry);
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
        expect(vi.mocked(api.post).mock.calls[1]).toEqual(original);
        expect(await screen.findByRole("status")).toHaveTextContent(
          removed ? "Pago" : "Parcialmente pago",
        );
      },
    );

    it("keeps requestId on network retry, but changes it when the amount changes", async () => {
      vi.mocked(api.post).mockRejectedValue(new Error("Falha de rede"));
      await open(surface);
      const confirm = screen.getByRole("button", {
        name: "Confirmar pagamento parcial",
      });
      fireEvent.click(confirm);
      await screen.findByText("Falha de rede");
      fireEvent.click(confirm);
      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
      expect(vi.mocked(api.post).mock.calls[0][1]).toEqual(
        vi.mocked(api.post).mock.calls[1][1],
      );
      await screen.findByText("Falha de rede");
      fireEvent.change(screen.getByLabelText("Valor a aplicar (R$)"), {
        target: { value: "300" },
      });
      fireEvent.click(confirm);
      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(3));
      expect(vi.mocked(api.post).mock.calls[2][1]).toMatchObject({
        amountCents: 30_000,
      });
      expect(vi.mocked(api.post).mock.calls[2][1]).not.toEqual(
        vi.mocked(api.post).mock.calls[0][1],
      );
    });

    it("does not infer missing source availability from its original value", async () => {
      currentSource = { ...source, sourceAvailableCents: undefined };
      await open(surface);
      expect(
        screen.getByRole("button", { name: "Confirmar pagamento parcial" }),
      ).toBeDisabled();
      expect(api.post).not.toHaveBeenCalled();
    });

    it("caps the default at the remaining amount, rejecting overpayment", async () => {
      currentTarget = {
        ...target,
        installmentSettlements: [
          {
            ...target.installmentSettlements![0],
            paidCents: 50_000,
            remainingCents: 30_000,
            settlementStatus: "PARTIAL",
          },
        ],
      };
      await open(surface);
      expect(screen.getByLabelText("Valor a aplicar (R$)")).toHaveValue(300);
      fireEvent.change(screen.getByLabelText("Valor a aplicar (R$)"), {
        target: { value: "300.01" },
      });
      expect(
        screen.getByRole("button", { name: "Confirmar pagamento parcial" }),
      ).toBeDisabled();
      expect(api.post).not.toHaveBeenCalled();
    });

    it("waits for the server, never showing a partial allocation as fully paid", async () => {
      let finish!: (value: typeof result) => void;
      vi.mocked(api.post).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await open(surface);
      fireEvent.click(
        screen.getByRole("button", { name: "Confirmar pagamento parcial" }),
      );
      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
      expect(screen.queryByText("Parcialmente pago")).toBeNull();
      finish(result);
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Parcialmente pago",
      );
    });

    it("starts a new command when the target changes, even at the same amount", async () => {
      vi.mocked(api.post).mockRejectedValue(new Error("Falha de rede"));
      await open(surface);
      fireEvent.click(
        screen.getByRole("button", { name: "Confirmar pagamento parcial" }),
      );
      await screen.findByText("Falha de rede");
      fireEvent.change(screen.getByLabelText("Parcela a pagar"), {
        target: { value: "target-b#0" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Confirmar pagamento parcial" }),
      );
      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
      const first = vi.mocked(api.post).mock.calls[0][1];
      const second = vi.mocked(api.post).mock.calls[1][1];
      expect(second).toMatchObject({
        targetExpenseId: "target-b",
        amountCents: 40_000,
      });
      expect(second).not.toMatchObject({
        requestId: (first as { requestId: string }).requestId,
      });
    });

    it("unknown target balance stays unavailable rather than deriving valorTotal", async () => {
      currentTarget = { ...target, installmentSettlements: undefined };
      await open(surface, false);
      await waitFor(() =>
        expect(
          screen
            .getByLabelText("Parcela a pagar")
            .querySelector('option[value="target-b#0"]'),
        ).not.toBeNull(),
      );
      expect(
        screen.getByRole("button", { name: "Confirmar pagamento parcial" }),
      ).toBeDisabled();
      expect(api.post).not.toHaveBeenCalled();
    });
  },
);

it("enumerates every target and installment, distinguishing equal amounts before undo", async () => {
  currentTarget = {
    ...target,
    installmentSettlements: [
      { ...target.installmentSettlements![0], contributions: [contribution] },
      {
        ...target.installmentSettlements![0],
        parcelaIndex: 1,
        contributions: [{ ...contribution, settlementId: "funding-second" }],
      },
    ],
  };
  otherTarget = {
    ...otherTarget,
    installmentSettlements: [
      {
        ...target.installmentSettlements![0],
        contributions: [{ ...contribution, settlementId: "funding-b" }],
      },
    ],
  };
  await open("editor", false);
  const second = await screen.findByRole("group", {
    name: "Obra · Contrato · parcela 2",
  });
  expect(
    screen.getByRole("group", { name: "Obra · Contrato B · parcela 1" }),
  ).toBeInTheDocument();
  expect(
    screen.getAllByRole("button", { name: "Desfazer esta contribuição" }),
  ).toHaveLength(3);
  vi.mocked(api.delete).mockResolvedValueOnce({
    ...result,
    settlementId: "funding-second",
    parcelaIndex: 1,
    state: "REVERSED",
  });
  fireEvent.click(
    within(second).getByRole("button", { name: "Desfazer esta contribuição" }),
  );
  await waitFor(() =>
    expect(vi.mocked(api.delete).mock.calls).toEqual([
      ["/projects/pessoal/expenses/source/conciliar-parcela/funding-second"],
    ]),
  );
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: "Desfazer esta contribuição" }),
    ).toHaveLength(2),
  );
  expect(api.post).not.toHaveBeenCalled();
});

it.each(["redacted", "missing-source", "missing-settlement"] as const)(
  "does not offer persisted undo with %s history",
  async (state) => {
    const get = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (!path.includes("/expenses/cross-project")) return get(path);
      return [
        {
          ...target,
          installmentSettlements: [
            {
              ...target.installmentSettlements![0],
              contributions:
                state === "redacted"
                  ? undefined
                  : [
                      {
                        ...contribution,
                        sourceId:
                          state === "missing-source"
                            ? undefined
                            : contribution.sourceId,
                        settlementId:
                          state === "missing-settlement"
                            ? undefined
                            : contribution.settlementId,
                      },
                    ],
            },
          ],
        },
      ];
    });
    await open("editor");
    expect(
      screen.queryByRole("button", { name: "Desfazer esta contribuição" }),
    ).toBeNull();
    expect(api.delete).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  },
);

it.each(["editor", "view"] as const)(
  "preserves unsaved metadata while refreshing funding balances in %s",
  async (surface) => {
    await open(surface);
    const title = document.querySelector<HTMLInputElement>(
      'input[name="titulo"]',
    )!;
    fireEvent.change(title, { target: { value: "Título ainda não salvo" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar pagamento parcial" }),
    );
    await screen.findByRole("status");
    await waitFor(() =>
      expect(screen.getByLabelText("Valor a aplicar (R$)")).toHaveValue(null),
    );
    expect(title).toHaveValue("Título ainda não salvo");
    expect(api.patch).not.toHaveBeenCalled();
  },
);
