import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import ImportStatementModal from "./ImportStatementModal";
import type { CardRow } from "../_types";

/**
 * #714 — `preview.futureInstallments` é FATO INFORMADO pelo arquivo, sem a
 * identidade da compra-mãe. A UI não pode somá-lo como "desta importação" nem
 * prometer que entra como PLANEJADO: a geração real vem da linha confirmada
 * (backend). `api.upload` é stub de contrato de UI, não prova o backend real.
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
    fingerprint: "a".repeat(64),
    candidates: [],
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
const FUTURE = [
  {
    ...base,
    externalId: "f1",
    date: "2026-08-03",
    merchant: "TV SAMSUNG",
    amountCents: 12345678,
    installmentCurrent: 2,
    installmentTotal: 10,
    willImport: false,
    review: null,
  },
  {
    ...base,
    externalId: "f2",
    date: "2026-09-03",
    merchant: "TV SAMSUNG",
    amountCents: 12345678,
    installmentCurrent: 3,
    installmentTotal: 10,
    willImport: false,
    review: null,
  },
];

function previewOf(lines: unknown[]) {
  return {
    source: "CSV_NUBANK",
    periodLabel: "2026-07",
    total: lines.length,
    duplicated: 0,
    totalAmountCents: 0,
    preview: lines,
    futureInstallments: FUTURE,
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

const HEADING = /Parcelas futuras informadas na fatura/i;

function expectFileFactsOnly() {
  const section = screen.getByRole("group", { name: HEADING });
  expect(section).toHaveTextContent(/não (é|são) o cronograma/i);
  expect(section).toHaveTextContent(/nem o total desta tentativa/i);
  expect(section).toHaveTextContent(
    /apenas as compras confirmadas serão processadas/i,
  );
  // promessa removida e nenhum total somado de todo o arquivo
  expect(section).not.toHaveTextContent(/planejado/i);
  expect(section).not.toHaveTextContent(/entrar(ã|a)o/i);
  expect(section).not.toHaveTextContent(/R\$\s*2\.469\.135,56/);
  return section;
}

beforeEach(() => apiUploadMock.mockReset());

describe("FutureInstallmentsSection — fato do arquivo, não promessa (#714)", () => {
  it("revisão com REVIEW/BLOCKED pendentes: só copy de fonte documental, sem PLANEJADO nem soma", async () => {
    await toPreview([OK, REV, BLK]);
    expectFileFactsOnly();
    fireEvent.click(within(screen.getByRole("group", { name: HEADING })).getByRole("button"));
    const list = screen.getByRole("group", { name: HEADING });
    expect(list).toHaveTextContent("(2/10)");
    expect(list).toHaveTextContent("(3/10)");
  });

  it("etapa de resumo mantém o mesmo aviso (sem prometer PLANEJADO)", async () => {
    await toPreview([OK, REV, BLK]);
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    expectFileFactsOnly();
  });

  it("segunda tentativa (só pendências) mantém o aviso e a lista não vira seleção nem resultado criado", async () => {
    await toPreview([OK, REV]);
    fireEvent.click(screen.getByRole("button", { name: /ver resumo/i }));
    apiUploadMock.mockResolvedValueOnce({
      source: "CSV_NUBANK",
      periodLabel: "2026-07",
      inserted: 1,
      duplicated: 0,
      settled: 0,
      importId: "imp-1",
      reviewRequired: [REV.review],
      skippedItems: [],
      notSelected: 0,
      lineResults: [
        { externalId: "ok", outcome: "CREATED" },
        { externalId: "rev", outcome: "REVIEW_REQUIRED" },
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: /confirmar importação/i }),
    );
    // resultado: a lista do arquivo não aparece como "criada"
    fireEvent.click(await screen.findByRole("button", { name: /revisar pendências/i }));
    await screen.findByRole("group", { name: HEADING });
    expectFileFactsOnly();

    const form = apiUploadMock.mock.calls.at(-1)![1] as FormData;
    expect(JSON.parse(String(form.get("selectedExternalIds")))).toEqual(["ok"]);
    expect(String(form.get("selectedExternalIds"))).not.toMatch(/f1|f2/);
  });
});
