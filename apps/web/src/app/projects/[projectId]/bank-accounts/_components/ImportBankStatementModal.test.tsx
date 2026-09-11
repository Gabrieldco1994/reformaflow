import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ImportBankStatementModal from "./ImportBankStatementModal";
import type { BankAccountRow, BankPreviewTx } from "../_types";

const apiUploadMock = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    upload: (...args: unknown[]) => apiUploadMock(...args),
  },
}));

const ACCOUNT: BankAccountRow = {
  id: "acc-a",
  institution: "ITAU",
  nickname: "Conta A",
  last4: "1111",
  agency: null,
  accountNumber: null,
};

const PREVIEW = {
  source: "OFX",
  periodLabel: "2026-07",
  preview: [
    {
      externalId: "t1",
      date: "2026-07-01",
      merchant: "Padaria",
      amountCents: -1000,
      category: null,
      duplicate: false,
    },
  ],
  total: 1,
  duplicated: 0,
  totalAmountCents: 1000,
  totalDebits: 1,
  totalCredits: 0,
};

const COMMIT = {
  importId: "imp-1",
  source: "OFX",
  periodLabel: "2026-07",
  inserted: 1,
  duplicated: 0,
  receiptsInserted: 0,
  cardPayments: 0,
  aiReclassified: 0,
  recurrencesCreated: 0,
  skipped: 0,
};

async function loadTargetPreview(
  row: Partial<BankPreviewTx> = {},
  supportsTargets = true,
  edit = true,
) {
  render(
    <ImportBankStatementModal
      projectId="p1"
      account={ACCOUNT}
      onClose={vi.fn()}
      onCommitted={vi.fn()}
    />,
  );
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: { files: [new File(["x"], "extrato.ofx")] },
  });
  apiUploadMock.mockResolvedValueOnce({
    ...PREVIEW,
    ...(supportsTargets
      ? {
          inlineTargetProjects: [
            { id: "empty-project", name: "Reforma nova", type: "REFORMA" },
          ],
        }
      : {}),
    preview: [
      {
        ...PREVIEW.preview[0],
        amountCents: 1234567,
        inlineTargetEligible: supportsTargets,
        ...row,
      },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "Conferir arquivos" }));
  const review = await screen.findByRole("button", {
    name: /revisar padaria/i,
  });
  if (edit) fireEvent.click(review);
}

function prepareTarget() {
  fireEvent.click(
    screen.getByRole("button", { name: /criar em outro projeto/i }),
  );
  expect(screen.getByLabelText("Projeto destino")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Projeto destino"), {
    target: { value: "empty-project" },
  });
  expect(screen.getByLabelText("Categoria no destino")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Categoria no destino"), {
    target: { value: "MATERIAL_CONSTRUCAO" },
  });
}

async function importUntilCommitted() {
  const onClose = vi.fn();
  const onCommitted = vi.fn();
  render(
    <ImportBankStatementModal
      projectId="p1"
      account={ACCOUNT}
      onClose={onClose}
      onCommitted={onCommitted}
    />,
  );

  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const file = new File(["dummy"], "extrato.ofx", { type: "text/plain" });
  fireEvent.change(input, { target: { files: [file] } });

  apiUploadMock.mockResolvedValueOnce(PREVIEW);
  fireEvent.click(screen.getByRole("button", { name: "Conferir arquivos" }));
  await screen.findByText(/transações/i);

  apiUploadMock.mockResolvedValueOnce(COMMIT);
  fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
  fireEvent.click(
    screen.getByRole("button", { name: /confirmar importação/i }),
  );
  await screen.findByText("Importação concluída");

  return { onClose, onCommitted };
}

describe("ImportBankStatementModal — fechamento pós-importação", () => {
  beforeEach(() => {
    apiUploadMock.mockReset();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-11T15:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([true, false])(
    "payment warning is visible before editing, included in pending but still importable (outside=%s)",
    async (outside) => {
      await loadTargetPreview(
        {
          isCardPayment: true,
          suggestedCategory: "PAGAMENTO_FATURA_CARTAO",
          suggestedCardLast4: outside ? "4242" : null,
          cardCandidates: [
            {
              cardLast4: "4242",
              nickname: "Roxo",
              dueMonth: "2026-01",
              invoiceTotalCents: 1234567,
              deltaCents: 0,
              windowState: "OUTSIDE_SETTLEMENT_WINDOW",
            },
          ],
        },
        false,
        false,
      );
      const warning = outside
        ? /fora do prazo de liquidação automática/i
        : /sem cartão/i;
      expect(screen.getByText(warning)).toBeInTheDocument();
      if (outside)
        expect(screen.getByText(warning)).toHaveTextContent("Roxo ••4242");
      expect(
        screen.queryByText("Pronto para importar"),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/Após confirmar:/)).toHaveTextContent("1 novas");
      expect(screen.getByText(/Após confirmar:/)).toHaveTextContent(
        /saídas: R\$\s*12\.345,67/,
      );
      fireEvent.click(screen.getByRole("button", { name: "Pendências (1)" }));
      expect(
        screen.getByRole("button", { name: "Revisar Padaria" }),
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "Não importados (0)" }),
      );
      expect(
        screen.queryByRole("button", { name: "Revisar Padaria" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Ver resumo" }));
      expect(screen.getByText(warning)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Confirmar importação" }),
      ).toBeEnabled();
      apiUploadMock.mockResolvedValueOnce(COMMIT);
      fireEvent.click(
        screen.getByRole("button", { name: "Confirmar importação" }),
      );
      await screen.findByRole("button", { name: "Concluir" });
      expect(apiUploadMock).toHaveBeenCalledTimes(2);
      const body = apiUploadMock.mock.calls[1][1] as FormData;
      expect(JSON.parse(String(body.get("decisions")))).toEqual(
        outside ? [{ externalId: "t1", overrides: { cardLast4: "4242" } }] : [],
      );
    },
  );

  it("payment warning follows the effective identity after local edits without reprocessing", async () => {
    await loadTargetPreview(
      {
        isCardPayment: true,
        suggestedCategory: "PAGAMENTO_FATURA_CARTAO",
        suggestedCardLast4: "4242",
        cardCandidates: [
          {
            cardLast4: "4242",
            nickname: "Antigo",
            dueMonth: "2026-01",
            invoiceTotalCents: 1234567,
            deltaCents: 0,
            windowState: "OUTSIDE_SETTLEMENT_WINDOW",
          },
          {
            cardLast4: "5555",
            nickname: "Atual",
            dueMonth: "2026-07",
            invoiceTotalCents: 1234567,
            deltaCents: 0,
            windowState: "WITHIN_SETTLEMENT_WINDOW",
          },
        ],
      },
      false,
    );
    fireEvent.change(screen.getByLabelText("Cartão da fatura"), {
      target: { value: "5555" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar à revisão" }));
    expect(
      screen.queryByText(/fora do prazo de liquidação automática/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Pendências (0)" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revisar Padaria" }));
    fireEvent.change(screen.getByLabelText("Cartão da fatura"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar à revisão" }));
    expect(screen.getByText(/sem cartão/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Pendências (1)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Não importados (0)" }),
    ).toBeInTheDocument();
    expect(apiUploadMock).toHaveBeenCalledTimes(1);
  });

  it('mostra ações distintas "Fechar" (X) e "Concluir" após importar', async () => {
    await importUntilCommitted();

    const fechar = screen.getByRole("button", { name: "Fechar" });
    const concluir = screen.getByRole("button", { name: "Concluir" });
    expect(fechar).not.toBe(concluir);
    expect(screen.queryAllByRole("button", { name: "Fechar" })).toHaveLength(1);
  });

  it("mantém o resultado até Concluir, sem notificar o launcher antes", async () => {
    const { onClose, onCommitted } = await importUntilCommitted();

    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onCommitted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Concluir" }));
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("aplica destino autorizado só à revisão e envia newTarget apenas na confirmação (#690/#691)", async () => {
    await loadTargetPreview();
    prepareTarget();
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    expect(apiUploadMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    expect(apiUploadMock).toHaveBeenCalledTimes(1);
    apiUploadMock.mockResolvedValueOnce(COMMIT);
    fireEvent.click(
      screen.getByRole("button", { name: /confirmar importação/i }),
    );
    await waitFor(() => expect(apiUploadMock).toHaveBeenCalledTimes(2));
    const data = apiUploadMock.mock.calls[1][1] as FormData;
    expect(JSON.parse(String(data.get("decisions")))).toEqual([
      {
        externalId: "t1",
        action: "create",
        newTarget: {
          targetProjectId: "empty-project",
          tipoDespesa: "MATERIAL_CONSTRUCAO",
        },
      },
    ]);
  });

  it.each([
    { duplicate: true },
    { amountCents: -1234567 },
    { isCardPayment: true },
    { inlineTargetEligible: false },
    { suggestedCategory: "INVESTIMENTOS" },
    { suggestedCategory: "MOVIMENTACAO_INTERNA" },
  ])("não oferece destino para linha inelegível: %j", async (row) => {
    await loadTargetPreview(row);
    expect(
      screen.queryByRole("button", { name: /criar em outro projeto/i }),
    ).not.toBeInTheDocument();
    expect(apiUploadMock).toHaveBeenCalledTimes(1);
  });

  it("backend antigo não habilita destinos nem busca projetos por conta própria", async () => {
    await loadTargetPreview({}, false);
    expect(
      screen.queryByRole("button", { name: /criar em outro projeto/i }),
    ).not.toBeInTheDocument();
    expect(apiUploadMock).toHaveBeenCalledTimes(1);
  });

  it("possível duplicata importada por opt-in continua sem novo destino", async () => {
    await loadTargetPreview({
      possibleDuplicate: {
        externalId: "t1",
        existingId: "existing",
        existingOrigin: "bank:9999",
        existingDate: "2026-07-01",
        existingAmountCents: 1234567,
        reason: "same_natural_key_different_source",
      },
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /importar mesmo assim/i }),
    );
    expect(
      screen.queryByRole("button", { name: /criar em outro projeto/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    apiUploadMock.mockResolvedValueOnce(COMMIT);
    fireEvent.click(
      screen.getByRole("button", { name: /confirmar importação/i }),
    );
    await waitFor(() => expect(apiUploadMock).toHaveBeenCalledTimes(2));
    expect(
      JSON.parse(
        String((apiUploadMock.mock.calls[1][1] as FormData).get("decisions")),
      ),
    ).toEqual([{ externalId: "t1", action: "import" }]);
  });

  it("valor alterado exige nova conferência do destino; vínculo existente continua exclusivo", async () => {
    await loadTargetPreview({
      crossProjectMatches: [
        {
          kind: "expense",
          expenseId: "existing",
          projectId: "p2",
          projectName: "Outra reforma",
          projectType: "REFORMA",
          titulo: "Material",
          valorCents: 1234567,
          data: "2026-07-01",
          deltaCents: 0,
        },
      ],
    });
    prepareTarget();
    fireEvent.change(screen.getByLabelText("Valor da origem"), {
      target: { value: "200,00" },
    });
    expect(
      screen.getByRole("button", { name: /aplicar à revisão/i }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /conferi o destino/i }));
    expect(
      screen.getByRole("button", { name: /aplicar à revisão/i }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: /vincular como pago/i }),
    );
    expect(screen.queryByLabelText("Projeto destino")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    apiUploadMock.mockResolvedValueOnce(COMMIT);
    fireEvent.click(
      screen.getByRole("button", { name: /confirmar importação/i }),
    );
    await waitFor(() => expect(apiUploadMock).toHaveBeenCalledTimes(2));
    expect(
      JSON.parse(
        String((apiUploadMock.mock.calls[1][1] as FormData).get("decisions")),
      ),
    ).toEqual([
      {
        externalId: "t1",
        action: "link",
        linkToExpenseId: "existing",
        overrides: { valorCents: 20000 },
      },
    ]);
  });

  it("cancelar edição preserva rascunho aplicado, filtros e não reprocessa", async () => {
    await loadTargetPreview();
    prepareTarget();
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    fireEvent.click(screen.getByRole("button", { name: /revisar padaria/i }));
    fireEvent.change(screen.getByLabelText("Descrição"), {
      target: { value: "Não aplicar" },
    });
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByLabelText("Descrição")).toHaveValue("Não aplicar");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("button", { name: /revisar padaria/i }),
    ).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /pendências/i }));
    fireEvent.click(screen.getByRole("button", { name: /todos/i }));
    fireEvent.click(screen.getByRole("button", { name: /revisar padaria/i }));
    expect(screen.getByLabelText("Projeto destino")).toHaveValue(
      "empty-project",
    );
    expect(apiUploadMock).toHaveBeenCalledTimes(1);
  });

  it("bloqueia envio duplo e não permite retry automático de resultado desconhecido", async () => {
    await loadTargetPreview();
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    apiUploadMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const confirm = screen.getByRole("button", {
      name: /confirmar importação/i,
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByText(/a importação pode ter sido concluída/i);
    expect(apiUploadMock).toHaveBeenCalledTimes(2);
    expect(confirm).toBeDisabled();
  });
});
