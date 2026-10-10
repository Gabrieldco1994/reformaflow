import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ImportStatementModal from "./ImportStatementModal";
import type { CardRow } from "../_types";

/**
 * #714 (P01 preview policy v2) — linha da prévia com `ignored:'INVOICE_PAYMENT'`
 * é pagamento da própria fatura: o servidor nunca a cria. A UI só lê o sinal do
 * wire (sem regex local), tira a linha de seleção/contagens/pendências e não
 * fabrica sucesso quando nenhum commit ocorre. `api.upload` é stub de contrato
 * de UI, não prova o backend real.
 */

const apiUploadMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { upload: (...args: unknown[]) => apiUploadMock(...args) },
}));

const CARD: CardRow = {
  id: "card-a",
  institution: "NUBANK",
  brand: "MASTERCARD",
  nickname: "Roxinho",
  last4: "4242",
  limitTotalCents: null,
  limitAvailableCents: null,
  closingDay: 10,
  dueDay: 17,
};

const F1 = "a".repeat(64);
const base = {
  category: null,
  installmentCurrent: null,
  installmentTotal: null,
  duplicate: false,
  review: null,
  ignored: null,
};
const PURCHASE = {
  ...base,
  externalId: "buy",
  date: "2026-07-01",
  merchant: "PADARIA",
  amountCents: 7000,
  willImport: true,
};
const PAY_IN = {
  ...base,
  externalId: "pay-in",
  date: "2026-07-05",
  merchant: "PAGAMENTO EFETUADO",
  amountCents: -500000,
  willImport: false,
  ignored: "INVOICE_PAYMENT",
  // um vínculo único de delta 0 seria auto-link se a linha fosse compra
  crossProjectMatches: [
    {
      expenseId: "planned-1",
      projectId: "p2",
      projectName: "Reforma",
      titulo: "Fatura",
      valorCents: -500000,
      deltaCents: 0,
      dataVencimento: "2026-07-05",
    },
  ],
};
const PAY_OUT = {
  ...base,
  externalId: "pay-out",
  date: "2026-07-05",
  merchant: "PAGAMENTO EFETUADO",
  amountCents: 500000,
  willImport: false,
  ignored: "INVOICE_PAYMENT",
};
const TIER_B = {
  existingId: "exp-1",
  existingOrigin: "bank:1111",
  existingDate: "2026-07-05",
  existingAmountCents: 500000,
  reason: "same_natural_key_different_source",
};
const REVIEW_LINE = {
  ...base,
  externalId: "rev",
  date: "2026-07-03",
  merchant: "TV SAMSUNG",
  amountCents: 150000,
  installmentCurrent: 1,
  installmentTotal: 10,
  willImport: false,
  review: {
    externalId: "rev",
    reason: "REVIEW_REQUIRED",
    fingerprint: F1,
    candidates: [
      {
        expenseId: "exp-old",
        titulo: "TV SAMSUNG",
        installmentCount: 10,
        seriesAmountCents: 100000,
        dataCompra: "2026-05-10",
      },
    ],
  },
};

function previewOf(lines: unknown[], over: Record<string, unknown> = {}) {
  return {
    source: "CSV_NUBANK",
    periodLabel: "2026-07",
    total: lines.length,
    duplicated: 0,
    totalAmountCents: 123456789,
    preview: lines,
    ...over,
  };
}

function commitOf(over: Record<string, unknown> = {}) {
  return {
    source: "CSV_NUBANK",
    periodLabel: "2026-07",
    inserted: 0,
    duplicated: 0,
    settled: 0,
    importId: "imp-1",
    reviewRequired: [],
    skippedItems: [],
    notSelected: 0,
    lineResults: [],
    ...over,
  };
}

async function toPreview(lines: unknown[], over: Record<string, unknown> = {}) {
  render(
    <ImportStatementModal
      projectId="p1"
      card={CARD}
      onClose={vi.fn()}
      onCommitted={vi.fn()}
    />,
  );
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["x"], "fatura.csv", { type: "text/csv" })] },
  });
  apiUploadMock.mockResolvedValueOnce(previewOf(lines, over));
  fireEvent.click(screen.getByRole("button", { name: "Conferir arquivos" }));
  await screen.findByText(/Após confirmar:/i);
}

async function commit(response: unknown) {
  fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
  apiUploadMock.mockResolvedValueOnce(response);
  fireEvent.click(screen.getByRole("button", { name: /confirmar importação/i }));
  await screen.findByRole("button", { name: /^concluir/i });
}

function lastForm() {
  const fd = apiUploadMock.mock.calls.at(-1)![1] as FormData;
  const json = (k: string) => {
    const raw = fd.get(k);
    return raw ? (JSON.parse(String(raw)) as unknown) : undefined;
  };
  return {
    decisions: (json("decisions") ?? []) as Array<Record<string, unknown>>,
    selected: json("selectedExternalIds") as string[] | undefined,
  };
}

const NO_BUYS = /não há compras a importar nesta revisão/i;
const PAYMENT_LABEL = /pagamento de fatura — não é compra, não será importado/i;

beforeEach(() => apiUploadMock.mockReset());

describe("ImportStatementModal — pagamento de fatura ignorado (#714 P01 v2)", () => {
  it("F1a misto: cabeçalho separa fatos do arquivo, selecionadas, pagamentos e existentes; total do servidor é 'do arquivo'", async () => {
    await toPreview([PURCHASE, PAY_IN, PAY_OUT]);
    const head = screen.getByText(/transações no arquivo/i).closest("div")!;
    expect(head).toHaveTextContent("3 transações no arquivo");
    expect(head).toHaveTextContent("1 selecionada(s)");
    expect(head).toHaveTextContent("2 pagamento(s) de fatura ignorado(s)");
    expect(head).toHaveTextContent("0 já existentes");
    expect(head).toHaveTextContent(/total do arquivo/i);
    expect(head).toHaveTextContent(/1\.234\.567,89/);
  });

  it("F1b misto: sem auto-link nem soma do pagamento; só a compra vai na seleção e nas decisões", async () => {
    // valores que NÃO se anulam: somar qualquer pagamento mudaria os R$ 70,00
    await toPreview([PURCHASE, PAY_IN, { ...PAY_OUT, amountCents: 250000 }]);
    const after = screen.getByText(/Após confirmar:/i);
    expect(after).toHaveTextContent("1 novas");
    expect(after).toHaveTextContent("0 vinculadas");
    expect(after).toHaveTextContent(/R\$\s*70,00/);
    await commit(
      commitOf({
        inserted: 1,
        notSelected: 2,
        lineResults: [
          { externalId: "buy", outcome: "CREATED" },
          { externalId: "pay-in", outcome: "NOT_SELECTED" },
          { externalId: "pay-out", outcome: "NOT_SELECTED" },
        ],
      }),
    );
    const { selected, decisions } = lastForm();
    expect(selected).toEqual(["buy"]);
    expect(decisions.map((d) => d.externalId)).not.toContain("pay-in");
    expect(decisions.map((d) => d.externalId)).not.toContain("pay-out");
  });

  it("F1c misto: o editor da linha ignorada é só leitura da razão, sem controle de ação", async () => {
    await toPreview([PURCHASE, PAY_IN, PAY_OUT]);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Revisar PAGAMENTO EFETUADO" })[0],
    );
    expect(screen.getByText(PAYMENT_LABEL)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByLabelText("Categoria da origem")).toBeNull();
    expect(screen.queryByLabelText("Valor da origem")).toBeNull();
    expect(screen.queryByRole("button", { name: /excluir desta importação/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /vincul|associar/i })).toBeNull();
  });

  it("F2 só pagamentos: nada a importar, botão desabilitado, zero commit/recibo/sucesso", async () => {
    await toPreview([PAY_IN, PAY_OUT]);
    expect(screen.getByText(NO_BUYS)).toBeInTheDocument();
    const next = screen.getByRole("button", { name: /ver resumo/i });
    expect(next).toBeDisabled();
    fireEvent.click(next);
    expect(apiUploadMock).toHaveBeenCalledTimes(1); // só a prévia
    expect(screen.queryByText(/importação concluída|importação parcial/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /confirmar importação/i })).toBeNull();
  });

  it("F2b compras só duplicadas + pagamento: mesma mensagem, sem afirmar 'só tem pagamentos'", async () => {
    const DUP = { ...PURCHASE, externalId: "dup", duplicate: true, willImport: false };
    await toPreview([DUP, PAY_OUT], { duplicated: 1 });
    expect(screen.getByText(NO_BUYS)).toBeInTheDocument();
    expect(screen.queryByText(/só tem pagamentos/i)).toBeNull();
    expect(screen.getByRole("button", { name: /ver resumo/i })).toBeDisabled();
  });

  it("F2c REVIEW pendente + pagamento NÃO é tratado como tudo ignorado", async () => {
    await toPreview([REVIEW_LINE, PAY_OUT]);
    expect(screen.queryByText(NO_BUYS)).toBeNull();
    expect(screen.getByText(/Após confirmar:/i)).toHaveTextContent("1 aguardando decisão");
  });

  it("F2d compra Tier B pendente + pagamento NÃO é tratado como tudo ignorado", async () => {
    const TB = { ...PURCHASE, externalId: "tb", merchant: "MERCADO", willImport: false, possibleDuplicate: TIER_B };
    await toPreview([TB, PAY_OUT]);
    expect(screen.queryByText(NO_BUYS)).toBeNull();
    expect(screen.getByText(/Após confirmar:/i)).toHaveTextContent("1 possível(is) duplicata(s)");
  });

  it("F3 resultado com NOT_SELECTED de pagamento e da compra em review não escolhida: só a compra é pendência; a 2ª tentativa não inclui o pagamento", async () => {
    await toPreview([PURCHASE, REVIEW_LINE, PAY_OUT]);
    // o review não foi consentido, logo não foi selecionado: o commit real devolve NOT_SELECTED
    await commit(
      commitOf({
        inserted: 1,
        notSelected: 2,
        reviewRequired: [],
        lineResults: [
          { externalId: "buy", outcome: "CREATED" },
          { externalId: "rev", outcome: "NOT_SELECTED" },
          { externalId: "pay-out", outcome: "NOT_SELECTED" },
        ],
      }),
    );
    expect(screen.getByText(/1 pendência para decidir/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /revisar pendências \(1\)/i }));
    expect(screen.queryByRole("button", { name: "Revisar PAGAMENTO EFETUADO" })).toBeNull();
    // o review da prévia segue disponível para consentimento
    fireEvent.click(screen.getByRole("button", { name: "Revisar TV SAMSUNG" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /é outra compra/i }));
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    await commit(
      commitOf({
        importId: "imp-2",
        inserted: 1,
        lineResults: [{ externalId: "rev", outcome: "CREATED" }],
      }),
    );
    expect(lastForm().selected).toEqual(["rev"]);
    expect(lastForm().decisions.map((d) => d.externalId)).toEqual(["rev"]);
  });

  it("F3b só a compra é criada e o pagamento NOT_SELECTED não gera 'Revisar pendências'", async () => {
    await toPreview([PURCHASE, PAY_OUT]);
    await commit(
      commitOf({
        inserted: 1,
        notSelected: 1,
        lineResults: [
          { externalId: "buy", outcome: "CREATED" },
          { externalId: "pay-out", outcome: "NOT_SELECTED" },
        ],
      }),
    );
    expect(screen.queryByRole("button", { name: /revisar pendências/i })).toBeNull();
    expect(screen.queryByText(/pendências? para decidir/i)).toBeNull();
    expect(screen.getByText("Importação concluída")).toBeInTheDocument();
  });

  it("F4a pagamento já existente (duplicate:true, ignored:null): 'já importada', sem rótulo de pagamento", async () => {
    const DUP_PAY = {
      ...PAY_OUT,
      externalId: "dup-pay",
      duplicate: true,
      ignored: null,
    };
    await toPreview([PURCHASE, DUP_PAY], { duplicated: 1 });
    expect(screen.getByText(/Após confirmar:/i).closest("div")!.parentElement).not.toHaveTextContent(
      /pagamento\(s\) de fatura ignorado/i,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revisar PAGAMENTO EFETUADO" }));
    expect(screen.getByText(/já importada anteriormente/i)).toBeInTheDocument();
    expect(screen.queryByText(PAYMENT_LABEL)).toBeNull();
  });

  it("F4b pagamento + metadata Tier B: só o rótulo de pagamento; sem 'Importar mesmo assim', fora das contagens e do payload", async () => {
    const PAY_TB = { ...PAY_OUT, externalId: "pay-tb", possibleDuplicate: TIER_B };
    await toPreview([PURCHASE, PAY_TB]);
    const after = screen.getByText(/Após confirmar:/i);
    expect(after).toHaveTextContent("1 novas");
    expect(after).not.toHaveTextContent(/possível\(is\) duplicata/i);
    expect(after).toHaveTextContent(/R\$\s*70,00/); // sem os 5.000,00 do pagamento
    fireEvent.click(screen.getByRole("button", { name: "Revisar PAGAMENTO EFETUADO" }));
    expect(screen.getByText(PAYMENT_LABEL)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /importar mesmo assim/i })).toBeNull();
    expect(screen.queryByText(/importar mesmo assim/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /voltar à revisão/i }));
    await commit(
      commitOf({
        inserted: 1,
        notSelected: 1,
        lineResults: [
          { externalId: "buy", outcome: "CREATED" },
          { externalId: "pay-tb", outcome: "NOT_SELECTED" },
        ],
      }),
    );
    expect(lastForm().selected).toEqual(["buy"]);
    expect(lastForm().decisions.map((d) => d.externalId)).not.toContain("pay-tb");
  });

  it("F4c controle: compra normal + Tier B mantém o fluxo Tier B", async () => {
    const TB = { ...PURCHASE, externalId: "tb", merchant: "MERCADO", willImport: false, possibleDuplicate: TIER_B };
    await toPreview([PURCHASE, TB]);
    expect(screen.getByText(/Após confirmar:/i)).toHaveTextContent("1 possível(is) duplicata(s)");
    fireEvent.click(screen.getByRole("button", { name: "Revisar MERCADO" }));
    const box = screen.getByRole("checkbox", { name: /importar mesmo assim/i });
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    expect(screen.getByText(/Após confirmar:/i)).toHaveTextContent("2 novas");
    });

  it("F5a rodapé do editor de pagamento: sem Aplicar/Salvar/Confirmar; 'Voltar à revisão' só retorna e não muda contagens nem payload", async () => {
    await toPreview([PURCHASE, PAY_IN, { ...PAY_OUT, amountCents: 250000 }]);
    const after = () => screen.getByText(/Após confirmar:/i).textContent;
    const before = after();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Revisar PAGAMENTO EFETUADO" })[0],
    );
    expect(screen.getByText(PAYMENT_LABEL)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /aplicar à revisão/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /cancelar edição/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /salvar|confirmar/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /voltar à revisão/i }));
    expect(screen.queryByText(PAYMENT_LABEL)).toBeNull();
    expect(after()).toBe(before);
    await commit(
      commitOf({
        inserted: 1,
        notSelected: 2,
        lineResults: [
          { externalId: "buy", outcome: "CREATED" },
          { externalId: "pay-in", outcome: "NOT_SELECTED" },
          { externalId: "pay-out", outcome: "NOT_SELECTED" },
        ],
      }),
    );
    const { selected, decisions } = lastForm();
    expect(selected).toEqual(["buy"]);
    expect(decisions.map((d) => d.externalId)).not.toContain("pay-in");
  });

  it("F5b controle: compra normal mantém 'Cancelar edição' e 'Aplicar à revisão'", async () => {
    await toPreview([PURCHASE, PAY_IN]);
    fireEvent.click(screen.getByRole("button", { name: "Revisar PADARIA" }));
    expect(screen.getByRole("button", { name: /cancelar edição/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /aplicar à revisão/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /voltar à revisão/i })).toBeNull();
  });

  it("F5c inventário completo do editor de pagamento: só 'Fechar' (global) e 'Voltar à revisão'; nenhum campo nem reset/limpar/aplicar", async () => {
    await toPreview([PURCHASE, PAY_IN]);
    fireEvent.click(screen.getByRole("button", { name: "Revisar PAGAMENTO EFETUADO" }));
    const dialog = screen.getByRole("dialog");
    const controls = [
      ...dialog.querySelectorAll(
        "button, input, select, textarea, a[href], [role='button'], [role='checkbox'], [role='switch'], [role='textbox'], [role='combobox'], [contenteditable='true']",
      ),
    ].map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim());
    expect(controls).toEqual(["Fechar", "Voltar à revisão"]);
    expect(screen.queryByRole("button", { name: /restaurar/i })).toBeNull();
  });

  it("F5d controle: compra normal mantém edição e 'Restaurar dados originais e sugestões'", async () => {
    await toPreview([PURCHASE, PAY_IN]);
    fireEvent.click(screen.getByRole("button", { name: "Revisar PADARIA" }));
    const desc = screen.getByLabelText("Descrição") as HTMLInputElement;
    fireEvent.change(desc, { target: { value: "OUTRO NOME" } });
    expect((screen.getByLabelText("Descrição") as HTMLInputElement).value).toBe("OUTRO NOME");
    fireEvent.click(
      screen.getByRole("button", { name: /restaurar dados originais e sugestões/i }),
    );
    expect(screen.getByLabelText("Descrição")).toHaveValue("PADARIA");
  });

  it("F5e lista: pagamento com match único delta 0 não mostra a finalidade do vínculo (nenhum auto-link herdado)", async () => {
    await toPreview([PURCHASE, PAY_IN]);
    expect(screen.queryByText(/Finalidade: Reforma/)).toBeNull();
  });

});
