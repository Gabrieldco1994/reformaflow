import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ImportStatementModal from "./ImportStatementModal";
import type { CardRow } from "../_types";

/**
 * #714 — revisão explícita de compra parcelada "mesmo N, preço por parcela
 * diferente". Contrato de rede (tipos de `card-import-review.ts`, commits
 * e08d7b5a/257a57ff/b4595443 do backend): a prévia traz `review` por linha, o
 * commit recebe `decisions[].reviewFingerprint` + `selectedExternalIds` em TODA
 * tentativa e devolve `lineResults`/`reviewRequired`. Aqui o `api.upload` é um
 * stub de contrato de UI — não prova o backend real.
 */

const apiUploadMock = vi.fn();
// Mantém o ApiResponseError real de lib/api.ts (o catch do modal usa instanceof).
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { upload: (...args: unknown[]) => apiUploadMock(...args) },
}));
import { ApiResponseError } from "@/lib/api";

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
const F2 = "b".repeat(64);
const CANDIDATE = {
  expenseId: "exp-old",
  titulo: "TV SAMSUNG",
  installmentCount: 10,
  seriesAmountCents: 100000,
  dataCompra: "2026-05-10",
};

const base = {
  category: null,
  installmentCurrent: null,
  installmentTotal: null,
  duplicate: false,
};
const OK = {
  ...base,
  externalId: "ok",
  date: "2026-07-01",
  merchant: "PADARIA",
  amountCents: 7000,
  willImport: true,
  review: null,
};
const REV = {
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
    candidates: [CANDIDATE],
  },
};
const BLK = {
  ...base,
  externalId: "blk",
  date: "2026-07-04",
  merchant: "GELADEIRA",
  amountCents: 90000,
  willImport: false,
  review: {
    externalId: "blk",
    reason: "BLOCKED_IDENTITY",
    fingerprint: null,
    candidates: [],
  },
};

function previewOf(lines: unknown[]) {
  return {
    source: "CSV_NUBANK",
    periodLabel: "2026-07",
    total: lines.length,
    duplicated: 0,
    totalAmountCents: 0,
    preview: lines,
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

async function toPreview(lines: unknown[]) {
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
  apiUploadMock.mockResolvedValueOnce(previewOf(lines));
  fireEvent.click(screen.getByRole("button", { name: "Conferir arquivos" }));
  await screen.findByText(/transações/i);
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

async function consent(title: string) {
  fireEvent.click(screen.getByRole("button", { name: `Revisar ${title}` }));
  await userEvent.click(
    screen.getByRole("checkbox", { name: /é outra compra/i }),
  );
  fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
}

beforeEach(() => apiUploadMock.mockReset());

describe("ImportStatementModal — REVIEW de compra parcelada (#714)", () => {
  it("linha em review vira 'aguardando decisão', não é contada como nova e a bloqueada não oferece override", async () => {
    await toPreview([OK, REV, BLK]);
    const resumo = screen.getByText(/Após confirmar:/i);
    expect(resumo).toHaveTextContent("1 novas");
    expect(resumo).toHaveTextContent("1 aguardando decisão");
    expect(resumo).toHaveTextContent("1 bloqueada(s)");

    fireEvent.click(screen.getByRole("button", { name: "Revisar TV SAMSUNG" }));
    // candidato visto pelo usuário, com o valor por parcela da compra existente
    expect(screen.getByText(/R\$\s*1\.000,00/)).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /é outra compra/i }),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /cancelar edição/i }));
  });

  it("BLOCKED_IDENTITY não tem checkbox 'É outra compra' no editor", async () => {
    await toPreview([OK, BLK]);
    fireEvent.click(screen.getByRole("button", { name: "Revisar GELADEIRA" }));
    expect(screen.queryByRole("checkbox", { name: /é outra compra/i })).toBeNull();
    expect(screen.getByText("⛔ Bloqueada")).toBeInTheDocument();
  });

  it("1ª tentativa envia SEMPRE selectedExternalIds só com o confirmado; pendente sem escolha fica de fora", async () => {
    await toPreview([OK, REV, BLK]);
    await commit(commitOf({ inserted: 1, lineResults: [] }));
    const { selected, decisions } = lastForm();
    expect(selected).toEqual(["ok"]);
    expect(JSON.stringify(decisions)).not.toContain("reviewFingerprint");
  });

  it("'É outra compra' envia action:'import' + o fingerprint que o usuário viu e inclui a linha na seleção", async () => {
    await toPreview([OK, REV]);
    await consent("TV SAMSUNG");
    await commit(commitOf({ inserted: 2 }));
    const { selected, decisions } = lastForm();
    expect(selected).toEqual(["ok", "rev"]);
    expect(decisions).toContainEqual(
      expect.objectContaining({
        externalId: "rev",
        action: "import",
        reviewFingerprint: F1,
      }),
    );
  });

  it("editar título ou valor invalida o consentimento; categoria não", async () => {
    await toPreview([OK, REV]);
    await consent("TV SAMSUNG");
    fireEvent.click(screen.getByRole("button", { name: "Revisar TV SAMSUNG" }));
    fireEvent.change(screen.getByLabelText("Categoria da origem"), {
      target: { value: "LAZER" },
    });
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    expect(screen.getByText(/Após confirmar:/i)).toHaveTextContent("2 novas");

    fireEvent.click(screen.getByRole("button", { name: "Revisar TV SAMSUNG" }));
    fireEvent.change(screen.getByLabelText("Valor da origem"), {
      target: { value: "1.000,00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    expect(screen.getByText(/Após confirmar:/i)).toHaveTextContent("1 novas");
    expect(screen.getByText(/Após confirmar:/i)).toHaveTextContent(
      "1 aguardando decisão",
    );
    await commit(commitOf({ inserted: 1 }));
    expect(lastForm().selected).toEqual(["ok"]);
    expect(JSON.stringify(lastForm().decisions)).not.toContain("reviewFingerprint");
  });

  it("excluir a linha depois de consentir: skip explícito fecha o estado e não leva fingerprint", async () => {
    await toPreview([OK, REV]);
    await consent("TV SAMSUNG");
    fireEvent.click(screen.getByRole("button", { name: "Revisar TV SAMSUNG" }));
    fireEvent.click(
      screen.getByRole("button", { name: /excluir desta importação/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    await commit(commitOf({ inserted: 1 }));
    const { selected, decisions } = lastForm();
    expect(selected).toEqual(["ok", "rev"]);
    const d = decisions.find((x) => x.externalId === "rev")!;
    expect(d.action).toBe("skip");
    expect(d).not.toHaveProperty("reviewFingerprint");
  });

  it("auto-link de match único não vincula linha em review e não oferece 'Vincular como pago'", async () => {
    const withMatch = {
      ...REV,
      crossProjectMatches: [
        {
          expenseId: "x1",
          projectId: "p2",
          projectName: "Casa",
          titulo: "TV",
          valorCents: 150000,
          data: "2026-07-03",
          deltaCents: 0,
        },
      ],
    };
    await toPreview([OK, withMatch]);
    fireEvent.click(screen.getByRole("button", { name: "Revisar TV SAMSUNG" }));
    expect(screen.queryByRole("button", { name: /vincular como pago/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /cancelar edição/i }));
    await commit(commitOf({ inserted: 1 }));
    expect(JSON.stringify(lastForm().decisions)).not.toContain('"link"');
  });

  it("sem nada confirmável (só pendências): não há como confirmar nem upload de commit", async () => {
    await toPreview([REV, BLK]);
    expect(screen.getByRole("button", { name: /ver resumo/i })).toBeDisabled();
    expect(apiUploadMock).toHaveBeenCalledTimes(1);
  });

  it("resultado parcial: separa criado de pendente/bloqueado, sem 'aplicado' para bloqueio e sem erro/incerteza", async () => {
    await toPreview([OK, REV, BLK]);
    await consent("TV SAMSUNG");
    await commit(
      commitOf({
        inserted: 1,
        reviewRequired: [
          {
            externalId: "rev",
            reason: "REVIEW_STALE",
            fingerprint: F2,
            candidates: [{ ...CANDIDATE, seriesAmountCents: 120000 }],
          },
        ],
        skippedItems: [{ externalId: "blk", reason: "BLOCKED_IDENTITY" }],
        notSelected: 0,
        lineResults: [
          { externalId: "ok", outcome: "CREATED" },
          { externalId: "rev", outcome: "REVIEW_REQUIRED" },
          { externalId: "blk", outcome: "NOT_SELECTED" },
        ],
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/1 pendência para decidir ou tentar de novo/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /revisar pendências \(1\)/i }),
    ).toBeEnabled();
    expect(apiUploadMock).toHaveBeenCalledTimes(2);
  });

  it("NOT_SELECTED pendente localmente continua contando como pendência (não finalizada)", async () => {
    await toPreview([OK, REV]);
    await commit(
      commitOf({
        inserted: 1,
        notSelected: 1,
        lineResults: [
          { externalId: "ok", outcome: "CREATED" },
          { externalId: "rev", outcome: "NOT_SELECTED" },
        ],
      }),
    );
    expect(
      screen.getByRole("button", { name: /revisar pendências \(1\)/i }),
    ).toBeInTheDocument();
  });

  async function toSecondRound() {
    await toPreview([OK, REV]);
    // decisão explícita em OK (categoria) que NÃO pode voltar na 2ª rodada
    fireEvent.click(screen.getByRole("button", { name: "Revisar PADARIA" }));
    fireEvent.change(screen.getByLabelText("Categoria da origem"), {
      target: { value: "LAZER" },
    });
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    await commit(
      commitOf({
        inserted: 1,
        reviewRequired: [
          {
            externalId: "rev",
            reason: "REVIEW_REQUIRED",
            fingerprint: F2,
            candidates: [{ ...CANDIDATE, seriesAmountCents: 120000 }],
          },
        ],
        lineResults: [
          { externalId: "ok", outcome: "CREATED" },
          { externalId: "rev", outcome: "REVIEW_REQUIRED" },
        ],
      }),
    );
  }

  it("'Revisar pendências' é ação explícita: não reenvia, filtra pendências, trava a concluída e mantém o efeito visível", async () => {
    await toSecondRound();
    const button = screen.getByRole("button", { name: /revisar pendências/i });
    fireEvent.click(button);
    fireEvent.click(button); // duplo clique não duplica histórico
    expect(apiUploadMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText(/tentativa 1/i)).toHaveLength(1);
    expect(screen.getByRole("button", { name: /pendências/i, pressed: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revisar PADARIA" })).toBeNull();
    expect(screen.getByText(/PADARIA/)).toBeInTheDocument();
  });

  it("2ª tentativa: fingerprint novo exige novo consentimento; seleção = só o pendente confirmado; decisões antigas não voltam", async () => {
    await toSecondRound();
    fireEvent.click(screen.getByRole("button", { name: /revisar pendências/i }));
    fireEvent.click(screen.getByRole("button", { name: "Revisar TV SAMSUNG" }));
    const cb = screen.getByRole("checkbox", { name: /é outra compra/i });
    expect(cb).not.toBeChecked();
    expect(screen.getByText(/R\$\s*1\.200,00/)).toBeInTheDocument();
    await userEvent.click(cb);
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));

    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    apiUploadMock.mockResolvedValueOnce(
      commitOf({
        importId: "imp-2",
        inserted: 1,
        notSelected: 1,
        lineResults: [
          { externalId: "ok", outcome: "NOT_SELECTED" },
          { externalId: "rev", outcome: "CREATED" },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /confirmar importação/i }));
    await screen.findByRole("button", { name: /^concluir/i });

    const { selected, decisions } = lastForm();
    expect(selected).toEqual(["rev"]);
    expect(decisions.map((d) => d.externalId)).toEqual(["rev"]);
    expect(decisions[0]).toMatchObject({ action: "import", reviewFingerprint: F2 });
    // NOT_SELECTED da rodada 2 não apaga o CREATED da rodada 1; resumo por tentativa
    expect(screen.getByText(/tentativa 1/i)).toBeInTheDocument();
    expect(screen.getByText(/tentativa 2/i)).toBeInTheDocument();
    expect(screen.getByText(/PADARIA/)).toBeInTheDocument();
  });

  it("SELECTED_ROWS_CHANGED (409): pede nova prévia manual, preserva o resultado anterior e não reenvia sozinho", async () => {
    await toSecondRound();
    fireEvent.click(screen.getByRole("button", { name: /revisar pendências/i }));
    await consent("TV SAMSUNG");
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    // Mesmo formato de lib/api.ts: mensagem "HTTP 409" e o JSON da resposta como body.
    const err = new ApiResponseError("HTTP 409", 409, {
      code: "SELECTED_ROWS_CHANGED",
      missingCount: 1,
      missingExternalIds: ["rev"],
    });
    apiUploadMock.mockRejectedValueOnce(err);
    fireEvent.click(screen.getByRole("button", { name: /confirmar importação/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/nova prévia/i);
    expect(apiUploadMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/tentativa 1/i)).toBeInTheDocument();
  });

  it("REUSED (settled>0) nunca vira 'marcada como paga': resumo e histórico dizem reaproveitada, sem pagamento", async () => {
    await toPreview([OK]);
    await commit(
      commitOf({
        inserted: 0,
        settled: 1,
        lineResults: [{ externalId: "ok", outcome: "REUSED" }],
      }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent ?? "").not.toMatch(/pagas/i);
    expect(dialog.textContent ?? "").not.toMatch(/marcad[ao]s?/i);
    // resumo do resultado (CommittedView), o histórico da tentativa e a linha
    expect(
      screen.getByText(/reaproveitada\(s\), sem pagamento/i).closest("p"),
    ).toHaveTextContent("1 reaproveitada(s), sem pagamento");
    expect(screen.getByText(/1 reaproveitada\(s\) sem pagamento/i)).toBeInTheDocument();
    expect(screen.getByText("Reaproveitada, sem pagamento")).toBeInTheDocument();
  });

  it("ERROR de linha é retentável e não é chamado de 'aplicado'", async () => {
    await toPreview([OK, REV]);
    await consent("TV SAMSUNG");
    await commit(
      commitOf({
        inserted: 1,
        skippedItems: [],
        lineResults: [
          { externalId: "ok", outcome: "CREATED" },
          { externalId: "rev", outcome: "ERROR" },
        ],
      }),
    );
    expect(screen.getByRole("button", { name: /revisar pendências \(1\)/i })).toBeTruthy();
    expect(screen.queryByText(/aplicad/i)).toBeNull();
    // ERROR não é só transitório: orienta revisar os dados, sem obrigar edição.
    expect(
      screen.getAllByText("Com erro · revise os dados ou tente novamente").length,
    ).toBeGreaterThan(0);
  });

  it("SKIPPED terminal (ex.: pagamento efetuado) não é pendência nem é reenviado; ERROR real segue retentável", async () => {
    await toPreview([OK, REV, BLK]);
    await consent("TV SAMSUNG");
    await commit(
      commitOf({
        inserted: 1,
        skippedItems: [{ externalId: "rev", reason: "payment" }],
        lineResults: [
          { externalId: "ok", outcome: "CREATED" },
          { externalId: "rev", outcome: "SKIPPED" },
          { externalId: "blk", outcome: "BLOCKED" },
        ],
      }),
    );
    // Só SKIPPED/BLOCKED sobrando: nada para tentar de novo.
    expect(screen.queryByRole("button", { name: /revisar pendências/i })).toBeNull();
    expect(screen.queryByText(/pendências? para decidir/i)).toBeNull();
    // SKIPPED também cobre política (pagamento efetuado): não atribui ao usuário.
    expect(screen.getAllByText("Não importada").length).toBeGreaterThan(0);
    expect(screen.queryByText(/por você/i)).toBeNull();
  });

  it("SKIPPED junto de um ERROR: só o ERROR volta; o skip não entra na seleção seguinte", async () => {
    const OK2 = { ...OK, externalId: "ok2", merchant: "MERCADO" };
    await toPreview([OK, REV, OK2]);
    await consent("TV SAMSUNG");
    await commit(
      commitOf({
        inserted: 1,
        skippedItems: [{ externalId: "rev", reason: "payment" }],
        lineResults: [
          { externalId: "ok", outcome: "CREATED" },
          { externalId: "rev", outcome: "SKIPPED" },
          { externalId: "ok2", outcome: "ERROR" },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /revisar pendências \(1\)/i }));
    expect(screen.queryByRole("button", { name: "Revisar TV SAMSUNG" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    apiUploadMock.mockResolvedValueOnce(
      commitOf({ importId: "imp-2", inserted: 1, lineResults: [{ externalId: "ok2", outcome: "CREATED" }] }),
    );
    fireEvent.click(screen.getByRole("button", { name: /confirmar importação/i }));
    await screen.findByRole("button", { name: /^concluir/i });
    expect(lastForm().selected).toEqual(["ok2"]);
  });

  it("Tier B devolvido como POSSIBLE_DUPLICATE entra na mesma volta às pendências", async () => {
    const tierB = {
      ...base,
      externalId: "tb",
      date: "2026-07-02",
      merchant: "MERCADO",
      amountCents: 5000,
      willImport: false,
      review: null,
      possibleDuplicate: {
        externalId: "tb",
        existingId: "exp-1",
        existingOrigin: "bank:1111",
        existingDate: "2026-07-02",
        existingAmountCents: 5000,
        reason: "same_natural_key_different_source",
      },
    };
    await toPreview([OK, tierB]);
    await commit(
      commitOf({
        inserted: 1,
        lineResults: [
          { externalId: "ok", outcome: "CREATED" },
          { externalId: "tb", outcome: "POSSIBLE_DUPLICATE" },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /revisar pendências \(1\)/i }));
    fireEvent.click(screen.getByRole("button", { name: "Revisar MERCADO" }));
    const row = screen.getByText("⚠ Possível duplicata").closest("fieldset")!;
    await userEvent.click(
      within(row).getByRole("checkbox", { name: /importar mesmo assim/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    apiUploadMock.mockResolvedValueOnce(commitOf({ importId: "imp-2", inserted: 1 }));
    fireEvent.click(screen.getByRole("button", { name: /confirmar importação/i }));
    await screen.findByRole("button", { name: /^concluir/i });
    const { selected, decisions } = lastForm();
    expect(selected).toEqual(["tb"]);
    expect(decisions).toEqual([
      expect.objectContaining({ externalId: "tb", action: "import" }),
    ]);
  });
  it("consentiu F1 mas o servidor devolve F2: o consentimento antigo cai e a linha não vai na tentativa seguinte sem novo aceite", async () => {
    await toPreview([OK, REV]);
    await consent("TV SAMSUNG");
    await commit(
      commitOf({
        inserted: 1,
        reviewRequired: [
          {
            externalId: "rev",
            reason: "REVIEW_STALE",
            fingerprint: F2,
            candidates: [{ ...CANDIDATE, seriesAmountCents: 120000 }],
          },
        ],
        lineResults: [
          { externalId: "ok", outcome: "CREATED" },
          { externalId: "rev", outcome: "REVIEW_REQUIRED" },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /revisar pendências/i }));
    expect(screen.getByText(/Após confirmar:/i)).toHaveTextContent("1 aguardando decisão");
    expect(screen.getByRole("button", { name: /ver resumo/i })).toBeDisabled();
  });

  it("ERROR retentável: a linha volta na seleção da tentativa seguinte sem pedir outro consentimento e mantém a edição", async () => {
    await toPreview([OK, { ...OK, externalId: "ok2", merchant: "MERCADO" }]);
    fireEvent.click(screen.getByRole("button", { name: "Revisar MERCADO" }));
    fireEvent.change(screen.getByLabelText("Categoria da origem"), {
      target: { value: "LAZER" },
    });
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    await commit(
      commitOf({
        inserted: 1,
        lineResults: [
          { externalId: "ok", outcome: "CREATED" },
          { externalId: "ok2", outcome: "ERROR" },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /revisar pendências \(1\)/i }));
    expect(screen.getByText("Com erro · revise os dados ou tente novamente")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    apiUploadMock.mockResolvedValueOnce(commitOf({ importId: "imp-2", inserted: 1 }));
    fireEvent.click(screen.getByRole("button", { name: /confirmar importação/i }));
    await screen.findByRole("button", { name: /^concluir/i });
    const { selected, decisions } = lastForm();
    expect(selected).toEqual(["ok2"]);
    expect(decisions).toEqual([
      expect.objectContaining({
        externalId: "ok2",
        overrides: expect.objectContaining({ category: "LAZER" }),
      }),
    ]);
  });

  it("ERROR por valor inválido: corrigir o valor e tentar de novo envia o valor corrigido, só a pedido do usuário", async () => {
    await toPreview([OK, { ...OK, externalId: "bad", merchant: "MERCADO", amountCents: 0 }]);
    await commit(
      commitOf({
        inserted: 1,
        lineResults: [
          { externalId: "ok", outcome: "CREATED" },
          { externalId: "bad", outcome: "ERROR" },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /revisar pendências \(1\)/i }));
    // reabrir a revisão não reenvia nada sozinho
    expect(apiUploadMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Revisar MERCADO" }));
    fireEvent.change(screen.getByLabelText("Valor da origem"), {
      target: { value: "25,00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /aplicar à revisão/i }));
    expect(apiUploadMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    apiUploadMock.mockResolvedValueOnce(
      commitOf({
        importId: "imp-2",
        inserted: 1,
        lineResults: [{ externalId: "bad", outcome: "CREATED" }],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /confirmar importação/i }));
    await screen.findByRole("button", { name: /^concluir/i });
    const { selected, decisions } = lastForm();
    expect(selected).toEqual(["bad"]);
    expect(decisions).toEqual([
      expect.objectContaining({
        externalId: "bad",
        overrides: expect.objectContaining({ valorCents: 2500 }),
      }),
    ]);
    expect(screen.queryByRole("button", { name: /revisar pendências/i })).toBeNull();
  });

  it("nova ambiguidade criada no commit (linha sem review na prévia) aparece como pendência com candidatos, sem skip mudo", async () => {
    await toPreview([OK, { ...OK, externalId: "late", merchant: "TV LG" }]);
    await commit(
      commitOf({
        inserted: 1,
        reviewRequired: [
          {
            externalId: "late",
            reason: "REVIEW_REQUIRED",
            fingerprint: F2,
            candidates: [CANDIDATE],
          },
        ],
        lineResults: [
          { externalId: "ok", outcome: "CREATED" },
          { externalId: "late", outcome: "REVIEW_REQUIRED" },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /revisar pendências \(1\)/i }));
    fireEvent.click(screen.getByRole("button", { name: "Revisar TV LG" }));
    expect(screen.getByText(/R\$\s*1\.000,00/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /é outra compra/i })).not.toBeChecked();
  });

  it("lineResults malformado é resultado desconhecido: bloqueia novo envio e não oferece pendências", async () => {
    await toPreview([OK]);
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    apiUploadMock.mockResolvedValueOnce(
      commitOf({ inserted: 1, lineResults: [{ externalId: "ok", outcome: "APLICADO" }] }),
    );
    fireEvent.click(screen.getByRole("button", { name: /confirmar importação/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/não foi possível confirmar/i);
    expect(screen.getByRole("button", { name: /confirmar importação/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /revisar pendências/i })).toBeNull();
  });

  it("linked só como atributo de CREATED/REUSED; skip e bloqueio não viram 'aplicado'", async () => {
    await toPreview([OK, { ...OK, externalId: "ok2", merchant: "MERCADO" }, BLK]);
    await commit(
      commitOf({
        inserted: 1,
        settled: 1,
        linked: 2,
        lineResults: [
          { externalId: "ok", outcome: "CREATED", linked: true },
          { externalId: "ok2", outcome: "REUSED", linked: true },
          { externalId: "blk", outcome: "BLOCKED" },
        ],
      }),
    );
    expect(screen.getByText(/Criada · vinculada/)).toBeInTheDocument();
    expect(screen.getByText(/Reaproveitada, sem pagamento · vinculada/)).toBeInTheDocument();
    expect(screen.getAllByText(/Bloqueada · não importada/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/aplicad/i)).toBeNull();
  });

  it("'Gerar nova prévia' após 409 volta ao arquivo, mantém o histórico e não envia nada sozinho", async () => {
    await toPreview([OK]);
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    apiUploadMock.mockRejectedValueOnce(
      new ApiResponseError("HTTP 409", 409, {
        code: "SELECTED_ROWS_CHANGED",
        missingCount: 1,
        missingExternalIds: ["ok"],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /confirmar importação/i }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /gerar nova prévia/i }));
    expect(screen.getByRole("button", { name: "Conferir arquivos" })).toBeInTheDocument();
    expect(apiUploadMock).toHaveBeenCalledTimes(2);
  });

  it("um 409 que NÃO é SELECTED_ROWS_CHANGED continua sendo erro comum, sem 'nova prévia'", async () => {
    await toPreview([OK]);
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    apiUploadMock.mockRejectedValueOnce(new ApiResponseError("Conflito qualquer", 409, { message: "Conflito qualquer" }));
    fireEvent.click(screen.getByRole("button", { name: /confirmar importação/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Conflito qualquer");
    expect(screen.queryByRole("button", { name: /gerar nova prévia/i })).toBeNull();
  });
});
