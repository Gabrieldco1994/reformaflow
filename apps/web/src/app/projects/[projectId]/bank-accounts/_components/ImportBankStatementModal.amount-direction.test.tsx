import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { formatCurrency } from "@/lib/utils";
import ImportBankStatementModal, {
  type BankImportDecision,
} from "./ImportBankStatementModal";
import type {
  BankAccountRow,
  BankCommitResult,
  BankPreviewResult,
} from "../_types";

// Observe numeric summary inputs without pinning CSS, icons or translated copy.
// Both the formatter and the modal/row implementations still execute for real.
vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>();
  return { ...actual, formatCurrency: vi.fn(actual.formatCurrency) };
});

const fetchMock = vi.fn<typeof fetch>();
const ACCOUNT: BankAccountRow = {
  id: "qa-bank",
  institution: "ITAU",
  nickname: "QA bank",
  last4: "1881",
  agency: null,
  accountNumber: null,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-08T15:00:00.000Z"));
  fetchMock.mockReset();
  vi.mocked(formatCurrency).mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function loadPreview(credit: boolean, linked = false, multiple = false) {
  const preview: BankPreviewResult = {
    source: "OFX",
    periodLabel: "2026-09",
    total: 1,
    duplicated: 0,
    totalAmountCents: credit ? 0 : 50000,
    totalDebits: credit ? 0 : 1,
    totalCredits: credit ? 1 : 0,
    preview: [
      {
        externalId: "qa-movement",
        date: "2026-09-01",
        merchant: "QA ordinary movement",
        amountCents: credit ? -50000 : 50000,
        isCredit: credit,
        category: null,
        duplicate: false,
        willImport: true,
        isCardPayment: false,
        crossProjectMatches: linked
          ? Array.from({ length: multiple ? 2 : 1 }, (_, index) => ({
              ...(credit
                ? {
                    kind: "receipt" as const,
                    receiptId: `qa-planned-receipt${index || ""}`,
                  }
                : {
                    kind: "expense" as const,
                    expenseId: `qa-planned-expense${index || ""}`,
                  }),
              projectId: "qa-target",
              projectName: "QA target",
              projectType: "REFORMA",
              titulo: credit ? "QA planned receipt" : "QA planned expense",
              valorCents: 50000,
              data: "2026-09-01",
              deltaCents: 0,
            }))
          : [],
      },
    ],
  };
  const onClose = vi.fn();
  const onCommitted = vi.fn();
  const { container } = render(
    <ImportBankStatementModal
      projectId="qa-pessoal"
      account={ACCOUNT}
      onClose={onClose}
      onCommitted={onCommitted}
    />,
  );
  const file = new File(["synthetic OFX upload"], "qa-extrato.ofx", {
    type: "text/plain",
    lastModified: 1788880000000,
  });
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  fetchMock.mockResolvedValueOnce(Response.json(preview));
  fireEvent.click(screen.getByRole("button", { name: "Conferir arquivos" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Revisar QA ordinary movement" }),
  );
  await screen.findByDisplayValue("500,00");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(
    new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("mode"),
  ).toBe("preview");
  return { file, onClose, onCommitted };
}

function commitPayload(callIndex: number, file: File): BankImportDecision[] {
  const [url, options] = fetchMock.mock.calls[callIndex];
  const parsed = new URL(String(url));
  expect(parsed.pathname).toBe(
    "/projects/qa-pessoal/bank-accounts/qa-bank/import-statement",
  );
  expect(parsed.searchParams.get("mode")).toBe("commit");
  expect(options?.method).toBe("POST");
  expect(options?.credentials).toBe("include");
  expect(options?.body).toBeInstanceOf(FormData);
  const body = options!.body as FormData;
  expect([...body.keys()].sort()).toEqual(["decisions", "files"]);
  expect(body.getAll("files")).toEqual([file]);
  return JSON.parse(String(body.get("decisions"))) as BankImportDecision[];
}

function toSummary() {
  fireEvent.click(screen.getByRole("button", { name: "Aplicar à revisão" }));
  fireEvent.click(screen.getByRole("button", { name: "Ver resumo" }));
}

describe("ImportBankStatementModal — magnitude versus bank direction", () => {
  it.each([
    { direction: "credit", credit: true, summaryReais: [[0], [600]] },
    { direction: "debit", credit: false, summaryReais: [[600], [0]] },
  ])(
    "$direction 500 → 600: preserves preview direction and sends positive 60000",
    async ({ credit, summaryReais }) => {
      const { file, onClose, onCommitted } = await loadPreview(credit);
      vi.mocked(formatCurrency).mockClear();
      fireEvent.change(screen.getByDisplayValue("500,00"), {
        target: { value: "600,00" },
      });
      toSummary();
      // Assert the ordered outgoing/incoming pair on Summary, not editor formatting.
      expect(vi.mocked(formatCurrency).mock.calls.slice(-2)).toEqual(
        summaryReais,
      );
      const result: BankCommitResult = {
        importId: "qa-import",
        source: "OFX",
        periodLabel: "2026-09",
        inserted: credit ? 0 : 1,
        receiptsInserted: credit ? 1 : 0,
        duplicated: 0,
        skipped: 0,
        cardPayments: 0,
        aiReclassified: 0,
        recurrencesCreated: 0,
      };
      fetchMock.mockResolvedValueOnce(Response.json(result));
      fireEvent.click(
        screen.getByRole("button", { name: /confirmar importação/i }),
      );
      const finish = await screen.findByRole("button", { name: "Concluir" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(commitPayload(1, file)).toEqual([
        {
          externalId: "qa-movement",
          action: "create",
          overrides: { valorCents: 60000 },
        },
      ]);
      fireEvent.click(finish);
      expect(onCommitted).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it("a 400 for edited linked credit exposes the server error and preserves the link on retry", async () => {
    const { file, onClose, onCommitted } = await loadPreview(true, true);
    fireEvent.change(screen.getByDisplayValue("500,00"), {
      target: { value: "600,00" },
    });
    toSummary();
    // Transport fixture, not an assertion about the backend's chosen wording.
    // api.upload executes for real and converts the 400 body to Error.message.
    const message = "QA: remova o vínculo antes de alterar o valor.";
    fetchMock.mockImplementation(async () =>
      Response.json({ message }, { status: 400 }),
    );
    const expected: BankImportDecision[] = [
      {
        externalId: "qa-movement",
        action: "link",
        linkToReceiptId: "qa-planned-receipt",
        overrides: { valorCents: 60000 },
      },
    ];
    for (const callIndex of [1, 2]) {
      fireEvent.click(
        screen.getByRole("button", { name: /confirmar importação/i }),
      );
      // Wait for the actual server-supplied diagnostic, not success copy.
      await screen.findByText(message);
      expect(fetchMock).toHaveBeenCalledTimes(callIndex + 1);
      expect(commitPayload(callIndex, file)).toEqual(expected);
      expect(onCommitted).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    }
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it.each([
    { credit: true, multiple: false, edited: true },
    { credit: true, multiple: true, edited: true },
    { credit: false, multiple: false, edited: true },
    { credit: false, multiple: true, edited: true },
    { credit: true, multiple: false, edited: false },
    { credit: true, multiple: true, edited: false },
    { credit: false, multiple: false, edited: false },
    { credit: false, multiple: true, edited: false },
  ])(
    "unlink preserves edits and commits create (credit=$credit, multiple=$multiple, edited=$edited)",
    async ({ credit, multiple, edited }) => {
      const { file, onClose, onCommitted } = await loadPreview(
        credit,
        true,
        multiple,
      );
      // One exact match is auto-linked; multiple matches require a manual choice.
      if (multiple) {
        fireEvent.click(
          screen.getAllByRole("button", { name: /vincular como/i })[0],
        );
      }
      const overrides = {
        valorCents: 60000,
        titulo: "QA edited movement",
        category: credit ? "SALARIO" : "TRANSPORTE",
      };
      if (edited) {
        fireEvent.change(screen.getByDisplayValue("500,00"), {
          target: { value: "600,00" },
        });
        fireEvent.change(screen.getByDisplayValue("QA ordinary movement"), {
          target: { value: overrides.titulo },
        });
        fireEvent.change(screen.getByDisplayValue("Outros"), {
          target: { value: overrides.category },
        });
      }
      if (credit && edited) {
        toSummary();
        const message = "QA: remova o vínculo antes de alterar o valor.";
        fetchMock.mockResolvedValueOnce(
          Response.json({ message }, { status: 400 }),
        );
        fireEvent.click(
          screen.getByRole("button", { name: /confirmar importação/i }),
        );
        await screen.findByText(message);
        expect(commitPayload(1, file)).toEqual([
          {
            externalId: "qa-movement",
            action: "link",
            linkToReceiptId: "qa-planned-receipt",
            overrides,
          },
        ]);
        expect(onCommitted).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
        fireEvent.click(
          screen.getByRole("button", { name: "Revisar QA edited movement" }),
        );
      }

      fireEvent.click(
        screen.getByRole("button", { name: "Desvincular e manter edições" }),
      );
      // Read the real controlled input, then the real multipart commit; no copied state.
      expect(
        screen.getByDisplayValue(edited ? "600,00" : "500,00"),
      ).toBeDefined();
      toSummary();
      const callIndex = fetchMock.mock.calls.length;
      const result: BankCommitResult = {
        importId: "qa-import",
        source: "OFX",
        periodLabel: "2026-09",
        inserted: credit ? 0 : 1,
        receiptsInserted: credit ? 1 : 0,
        duplicated: 0,
        skipped: 0,
        cardPayments: 0,
        aiReclassified: 0,
        recurrencesCreated: 0,
      };
      fetchMock.mockResolvedValueOnce(Response.json(result));
      fireEvent.click(
        screen.getByRole("button", { name: /confirmar importação/i }),
      );
      const finish = await screen.findByRole("button", { name: "Concluir" });
      expect(fetchMock).toHaveBeenCalledTimes(callIndex + 1);
      expect(commitPayload(callIndex, file)).toEqual([
        {
          externalId: "qa-movement",
          action: "create",
          ...(edited ? { overrides } : {}),
        },
      ]);
      fireEvent.click(finish);
      expect(onCommitted).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it.each([
    { credit: true, multiple: false },
    { credit: true, multiple: true },
    { credit: false, multiple: false },
    { credit: false, multiple: true },
  ])(
    "Restaurar still resets edits to the auto-detection snapshot (#572, credit=$credit, multiple=$multiple)",
    async ({ credit, multiple }) => {
      const { file } = await loadPreview(credit, true, multiple);
      if (multiple) {
        fireEvent.click(
          screen.getAllByRole("button", { name: /vincular como/i })[0],
        );
      }
      fireEvent.change(screen.getByDisplayValue("500,00"), {
        target: { value: "600,00" },
      });
      fireEvent.change(screen.getByDisplayValue("QA ordinary movement"), {
        target: { value: "QA edited movement" },
      });
      fireEvent.change(screen.getByDisplayValue("Outros"), {
        target: { value: credit ? "SALARIO" : "TRANSPORTE" },
      });
      fireEvent.click(screen.getByTitle("Excluir desta importação"));
      fireEvent.click(
        screen.getByTitle("Restaurar dados originais e sugestões"),
      );
      toSummary();
      const message = "QA: inspect restored payload";
      fetchMock.mockResolvedValueOnce(
        Response.json({ message }, { status: 400 }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: /confirmar importação/i }),
      );
      await screen.findByText(message);
      expect(commitPayload(1, file)).toEqual(
        multiple
          ? []
          : [
              {
                externalId: "qa-movement",
                action: "link",
                ...(credit
                  ? { linkToReceiptId: "qa-planned-receipt" }
                  : { linkToExpenseId: "qa-planned-expense" }),
              },
            ],
      );
    },
  );
});
