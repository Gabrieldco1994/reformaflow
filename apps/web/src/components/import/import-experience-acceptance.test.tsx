import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ImportBankStatementModal from "@/app/projects/[projectId]/bank-accounts/_components/ImportBankStatementModal";
import ImportHistoryModal from "@/app/projects/[projectId]/_components/ImportHistoryModal";
import type { BankAccountRow } from "@/app/projects/[projectId]/bank-accounts/_types";

/**
 * #689 / B691 — production components + production api.ts, only fetch stubbed.
 * This is NOT a live browser/API journey or a layout/accessibility assertion.
 * Selectors locate actions; expectations pin transport data and side effects.
 * No duplicate state machine, invented production component, or financial POST
 * hidden behind a mocked child. New controls are intentionally RED on the base.
 */
const BASE = "/projects/qa689-pessoal/bank-accounts/qa689-bank";
const ACCOUNT: BankAccountRow = {
  id: "qa689-bank",
  institution: "NUBANK",
  nickname: "Conta QA",
  last4: "0689",
  agency: null,
  accountNumber: null,
};
const PREVIEW = {
  source: "OFX",
  periodLabel: "2026-09",
  total: 1,
  duplicated: 0,
  totalAmountCents: 12345,
  totalDebits: 1,
  totalCredits: 0,
  inlineTargetProjects: [
    { id: "qa689-empty-reforma", name: "Reforma vazia QA", type: "REFORMA" },
  ],
  preview: [
    {
      externalId: "qa689-debit",
      date: "2026-09-10",
      merchant: "MATERIAL QA COZINHA",
      amountCents: 12345,
      category: null,
      suggestedCategory: "OUTROS",
      duplicate: false,
      willImport: true,
      isCredit: false,
      isCardPayment: false,
      crossProjectMatches: [],
      inlineTargetEligible: true,
    },
  ],
};
const RESULT = {
  importId: "qa689-import",
  source: "OFX",
  periodLabel: "2026-09",
  inserted: 1,
  duplicated: 0,
  total: 1,
  totalAmountCents: 12345,
  receiptsInserted: 0,
  cardPayments: 0,
  aiReclassified: 0,
  recurrencesCreated: 0,
  skipped: 0,
  inlineExpenses: [
    {
      sourceExpenseId: "qa689-source-expense",
      targetExpenseId: "qa689-target-expense",
      targetProjectId: "qa689-empty-reforma",
      amountCents: 12345,
    },
  ],
};
const fetchMock = vi.fn<typeof fetch>();
let queryClient: QueryClient;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-11T15:00:00.000Z"));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function calls(mode?: string) {
  return fetchMock.mock.calls.filter(([url]) => {
    const parsed = new URL(String(url));
    return !mode || parsed.searchParams.get("mode") === mode;
  });
}

function financialWrites() {
  return fetchMock.mock.calls.filter(
    ([url, options]) =>
      ["POST", "PUT", "PATCH", "DELETE"].includes(options?.method ?? "GET") &&
      new URL(String(url)).searchParams.get("mode") !== "preview",
  );
}

async function loadReview() {
  const onClose = vi.fn();
  const onCommitted = vi.fn();
  // GET support is data only, for legitimate project/room field queries.
  // Every unexpected financial call remains recorded and fails the assertions.
  fetchMock.mockImplementation(async (url, options) => {
    const parsed = new URL(String(url));
    if (parsed.searchParams.get("mode") === "preview")
      return Response.json(structuredClone(PREVIEW));
    if (options?.method === "GET" || !options?.method) {
      if (parsed.pathname === "/projects")
        return Response.json(PREVIEW.inlineTargetProjects);
      if (parsed.pathname === "/projects/qa689-empty-reforma") {
        return Response.json({ ...PREVIEW.inlineTargetProjects[0], rooms: [] });
      }
      return Response.json([]);
    }
    return Response.json(RESULT);
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ImportBankStatementModal
        projectId="qa689-pessoal"
        account={ACCOUNT}
        onClose={onClose}
        onCommitted={onCommitted}
      />
    </QueryClientProvider>,
  );
  const file = new File(
    ["OFXHEADER:100\nDATA:OFXSGML\n<OFX></OFX>"],
    "qa689.ofx",
    { type: "application/x-ofx", lastModified: 1789138800000 },
  );
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  fireEvent.click(
    screen.getByRole("button", { name: /conferir arquivos|pré-visualizar/i }),
  );
  await waitFor(() => expect(calls("preview")).toHaveLength(1));
  return { file, onClose, onCommitted };
}

async function openDraft() {
  fireEvent.click(
    await screen.findByRole("button", { name: /revisar|editar/i }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: /criar.*(?:despesa|destino)|nova despesa/i,
    }),
  );
}

async function fillDraft() {
  fireEvent.change(await screen.findByLabelText(/projeto.*destino/i), {
    target: { value: "qa689-empty-reforma" },
  });
  const category = await screen.findByLabelText<HTMLSelectElement>(
    /tipo.*despesa|categoria.*destino/i,
  );
  expect(category.value).toBe("");
  fireEvent.change(category, {
    target: { value: "MATERIAL_CONSTRUCAO" },
  });
  fireEvent.change(screen.getByLabelText(/título/i), {
    target: { value: "Material da cozinha" },
  });
  fireEvent.change(screen.getByLabelText(/fornecedor/i), {
    target: { value: "Loja QA" },
  });
}

function assertCommit(file: File, expectedDecisions: unknown[]) {
  expect(calls("preview")).toHaveLength(1);
  expect(calls("commit")).toHaveLength(1);
  expect(financialWrites()).toHaveLength(1);
  const [url, options] = calls("commit")[0];
  expect(new URL(String(url)).pathname).toBe(`${BASE}/import-statement`);
  expect(options).toMatchObject({ method: "POST", credentials: "include" });
  expect(options?.body).toBeInstanceOf(FormData);
  const body = options!.body as FormData;
  expect([...body.keys()].sort()).toEqual(["decisions", "files"]);
  expect(body.getAll("files")).toEqual([file]);
  // Exact draft shape: never amount, quantity, paid state, generated expense
  // identity, bank/card origin or provenance supplied by the browser.
  expect(JSON.parse(String(body.get("decisions")))).toEqual(expectedDecisions);
}

describe("#689 B691 — review is local until one global confirmation", () => {
  it("apply draft → summary → back preserves the file/draft; confirm sends only one newTarget", async () => {
    const { file, onCommitted, onClose } = await loadReview();
    await openDraft();
    await fillDraft();
    fireEvent.click(screen.getByRole("button", { name: /aplicar.*revisão/i }));
    expect(financialWrites()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /resumo/i }));
    expect(financialWrites()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /voltar/i }));
    expect(calls("preview")).toHaveLength(1);
    expect(financialWrites()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /resumo/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /confirmar importação/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /concluir/i }));
    assertCommit(file, [
      {
        externalId: "qa689-debit",
        action: "create",
        newTarget: {
          targetProjectId: "qa689-empty-reforma",
          tipoDespesa: "MATERIAL_CONSTRUCAO",
          titulo: "Material da cozinha",
          fornecedor: "Loja QA",
        },
      },
    ]);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("canceling a populated line draft persists nothing and ordinary confirmation sends no target", async () => {
    const { file } = await loadReview();
    await openDraft();
    await fillDraft();
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(financialWrites()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /resumo/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /confirmar importação/i }),
    );
    await screen.findByRole("button", { name: /concluir/i });
    assertCommit(file, []);
  });

  it("does not infer the destination from the only available project or a category default", async () => {
    await loadReview();
    await openDraft();
    expect(
      (await screen.findByLabelText<HTMLSelectElement>(/projeto.*destino/i))
        .value,
    ).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /aplicar.*revisão/i }));
    expect(financialWrites()).toEqual([]);
    // A valid editor remains usable: explicitly choosing both fields is what
    // makes the eventual serialized newTarget valid, not a guessed default.
    await fillDraft();
    fireEvent.click(screen.getByRole("button", { name: /aplicar.*revisão/i }));
    expect(financialWrites()).toEqual([]);
    expect(calls("preview")).toHaveLength(1);
  });

  it("a committed result carrying a follow-up warning is completed once, never retried as rollback", async () => {
    const { file, onCommitted } = await loadReview();
    fireEvent.click(await screen.findByRole("button", { name: /resumo/i }));
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...RESULT,
        inlineExpenses: [],
        postCommitWarnings: [
          { code: "FOLLOW_UP_FAILED", message: "Follow-up unavailable" },
        ],
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /confirmar importação/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /concluir/i }));
    assertCommit(file, []);
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "history opens details first and obeys server canUndo=%s",
    async (canUndo) => {
      const onUndone = vi.fn();
      fetchMock.mockResolvedValueOnce(
        Response.json([
          {
            id: RESULT.importId,
            periodLabel: "2026-09",
            fileName: "qa689.ofx",
            source: "OFX",
            inserted: 1,
            duplicated: 0,
            totalAmountCents: 12345,
            createdAt: "2026-09-11T15:00:00.000Z",
            deletedAt: null,
          },
        ]),
      );
      render(
        <ImportHistoryModal
          basePath={BASE}
          title="Importações"
          onClose={vi.fn()}
          onUndone={onUndone}
        />,
      );
      fetchMock.mockResolvedValueOnce(
        Response.json({
          importId: RESULT.importId,
          periodLabel: "2026-09",
          fileName: "qa689.ofx",
          createdAt: "2026-09-11T15:00:00.000Z",
          alreadyUndone: false,
          totalAmountCents: 12345,
          impact: {
            expenses: 1,
            receipts: 0,
            cashFlowEntries: 2,
            crossProjectLinks: 1,
          },
          inlineExpenses: RESULT.inlineExpenses,
          canUndo,
          blockReason: canUndo ? null : "INLINE_IMPORT_DRIFT",
        }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: /ver detalhes/i }),
      );
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname),
        ).toEqual([`${BASE}/imports`, `${BASE}/imports/${RESULT.importId}`]),
      );
      expect(financialWrites()).toEqual([]);
      if (canUndo) {
        fetchMock.mockResolvedValueOnce(
          Response.json({ ok: true, alreadyUndone: false }),
        );
        fetchMock.mockResolvedValueOnce(Response.json([]));
      }
      fireEvent.click(
        await screen.findByRole("button", { name: /desfazer importação/i }),
      );
      if (canUndo) {
        await waitFor(() => expect(onUndone).toHaveBeenCalledTimes(1));
        expect(financialWrites()).toHaveLength(1);
        expect(new URL(String(financialWrites()[0][0])).pathname).toBe(
          `${BASE}/imports/${RESULT.importId}`,
        );
        expect(financialWrites()[0][1]?.method).toBe("DELETE");
      } else {
        expect(financialWrites()).toEqual([]);
        expect(onUndone).not.toHaveBeenCalled();
      }
    },
  );
});
