import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExpenseType,
  ImportSessionAmountMeaning,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { useImportConversation } from "./useImportConversation";
import { importRoot } from "../_lib/import-session-keys";

const mocks = vi.hoisted(() => ({
  userId: "user-1",
  getFullImportSession: vi.fn(),
  prepareImportSession: vi.fn(),
  getImportResult: vi.fn(),
  answerImportFocusedDraftQuestion: vi.fn(),
  answerImportDocumentaryQuestion: vi.fn(),
  editImportSession: vi.fn(),
  agentSend: vi.fn(),
}));

vi.mock("../_lib/import-session-api", () => ({
  getFullImportSession: mocks.getFullImportSession,
  prepareImportSession: mocks.prepareImportSession,
  getImportResult: mocks.getImportResult,
  answerImportFocusedDraftQuestion: mocks.answerImportFocusedDraftQuestion,
  answerImportDocumentaryQuestion: mocks.answerImportDocumentaryQuestion,
  editImportSession: mocks.editImportSession,
}));
vi.mock("./useImportSessions", () => ({
  useImportUserId: () => mocks.userId,
}));
vi.mock("@/components/agent/useFinancialAgent", () => ({
  useFinancialAgent: () => ({ send: mocks.agentSend }),
}));

const base: ImportSessionViewV1 = {
  version: 1,
  id: "session-1",
  ownerProjectId: "project-1",
  cardId: "card-1",
  state: "DRAFT",
  revision: 4,
  expiresAt: "2026-10-16T21:00:00.000Z",
  attachments: [],
  lines: [
    {
      id: "line-search",
      observationIds: ["observation-search"],
      titulo: "Compra antes da busca",
      fornecedor: null,
      tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
      categoriaMaoDeObra: null,
      amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE,
      amountCents: 12_345,
      installmentCount: 1,
      dataCompra: "2026-10-10",
      firstDueDate: null,
      targets: null,
      decision: { kind: "UNRESOLVED" },
    },
  ],
  selectedLineIds: ["line-search"],
  questions: [],
  declaredFacts: [],
  reviewBlockers: [],
  searchComplete: true,
  proposal: null,
  confirmation: null,
  receipt: null,
  actions: ["PREPARE", "CANCEL"],
};
const unresolvedLine: ImportSessionViewV1["lines"][number] = {
  id: "line-1",
  observationIds: ["observation-1"],
  titulo: "Compra documental",
  fornecedor: "Loja Exemplo",
  tipoDespesa: ExpenseType.OUTROS,
  categoriaMaoDeObra: null,
  amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE,
  amountCents: 20_696,
  installmentCount: 1,
  dataCompra: "2026-09-01",
  firstDueDate: "2026-10-10",
  targets: [],
  decision: { kind: "CREATE", acceptNaturalDuplicate: false },
};
const needsDecision = (): ImportSessionViewV1 => ({
  ...base,
  state: "NEEDS_INPUT",
  revision: 5,
  lines: [unresolvedLine],
  selectedLineIds: [unresolvedLine.id],
  questions: [
    {
      id: "question-decision",
      field: "decision",
      lineIds: [unresolvedLine.id],
      text: "Escolha a compra existente ou autorize uma nova.",
    },
  ],
  searchComplete: true,
  actions: ["RESOLVE", "CANCEL"],
});

function setup(view = base) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData([...importRoot(mocks.userId), "workflow", view.id], view);
  mocks.getFullImportSession.mockResolvedValue(view);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useImportConversation(view.id, false, "VOICE"), {
    wrapper,
  });
}

beforeEach(() => {
  Object.values(mocks).forEach((value) => {
    if (vi.isMockFunction(value)) value.mockReset();
  });
});
afterEach(cleanup);

describe("active import deterministic controls", () => {
  const needsInput = (): ImportSessionViewV1 => ({
    ...base,
    state: "NEEDS_INPUT",
    revision: 5,
    lines: [
      {
        id: "line-search",
        observationIds: ["observation-search"],
        titulo: "Compra encontrada na busca",
        fornecedor: "Loja encontrada",
        tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
        categoriaMaoDeObra: null,
        amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE,
        amountCents: 12_345,
        installmentCount: 1,
        dataCompra: "2026-10-10",
        firstDueDate: null,
        targets: null,
        decision: { kind: "UNRESOLVED" },
      },
    ],
    selectedLineIds: ["line-search"],
    questions: [
      {
        id: "question-search",
        field: "decision",
        lineIds: ["line-search"],
        text: "Criar esta compra ou manter a existente?",
      },
    ],
    searchComplete: true,
    proposal: null,
    confirmation: null,
    receipt: null,
    actions: ["RESOLVE", "PREPARE", "CANCEL"],
  });

  it("opens review through prepare and reads the receipt through result, never agent chat", async () => {
    const ready: ImportSessionViewV1 = {
      ...base,
      state: "READY",
      revision: 5,
      proposal: {} as ImportSessionViewV1["proposal"],
      actions: ["CONFIRM", "CANCEL"],
    };
    mocks.prepareImportSession.mockResolvedValue(ready);
    mocks.getImportResult.mockResolvedValue({
      state: "READY",
      receipt: null,
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));

    await act(async () => {
      await result.current.openReview();
    });
    expect(mocks.prepareImportSession).toHaveBeenCalledWith(
      "session-1",
      {
        expectedRevision: 4,
      },
      expect.any(AbortSignal),
    );
    expect(result.current.review).toBe(true);

    await act(async () => {
      await result.current.readResult();
    });
    expect(mocks.getImportResult).toHaveBeenCalledWith(
      "session-1",
      expect.any(AbortSignal),
    );
  });

  it("after a lost prepare response performs an authorized read and never retries the mutation", async () => {
    const ready: ImportSessionViewV1 = {
      ...base,
      state: "READY",
      revision: 5,
      proposal: {} as ImportSessionViewV1["proposal"],
      actions: ["CONFIRM", "CANCEL"],
    };
    mocks.prepareImportSession.mockRejectedValue(new TypeError("network"));
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));
    mocks.getFullImportSession.mockResolvedValue(ready);

    let recovered: ImportSessionViewV1 | null = null;
    await act(async () => {
      recovered = await result.current.openReview();
    });

    expect(mocks.prepareImportSession).toHaveBeenCalledOnce();
    expect(mocks.getFullImportSession).toHaveBeenCalled();
    expect(recovered).toEqual(
      expect.objectContaining({ state: "READY", revision: 5 }),
    );
    expect(result.current.review).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mocks.agentSend).not.toHaveBeenCalled();
  });

  it("caches a valid NEEDS_INPUT prepare result and returns to its search-derived manual question", async () => {
    mocks.prepareImportSession.mockResolvedValue(needsInput());
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));

    await act(async () => {
      await result.current.openReview();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.review).toBe(false);
    expect(result.current.view?.state).toBe("NEEDS_INPUT");
    expect(result.current.view?.lines[0].fornecedor).toBe("Loja encontrada");
    expect(result.current.question?.id).toBe("question-search");
    expect(result.current.view?.confirmation).toBeNull();
    expect(result.current.view?.receipt).toBeNull();
  });

  it("recovers the same valid NEEDS_INPUT outcome after a lost prepare response without retrying", async () => {
    mocks.prepareImportSession.mockRejectedValue(new TypeError("network"));
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));
    mocks.getFullImportSession.mockResolvedValue(needsInput());

    await act(async () => {
      await result.current.openReview();
    });

    expect(mocks.prepareImportSession).toHaveBeenCalledOnce();
    expect(result.current.error).toBeNull();
    expect(result.current.review).toBe(false);
    expect(result.current.view?.state).toBe("NEEDS_INPUT");
    expect(result.current.question?.id).toBe("question-search");
  });

  it.each(["confirmation", "receipt"] as const)(
    "rejects a NEEDS_INPUT response that exposes %s",
    async (field) => {
      const invalid = {
        ...needsInput(),
        [field]:
          field === "confirmation"
            ? {
                confirmedRevision: 5,
                proposalHash: "a".repeat(64),
                confirmedAt: "2026-10-11T12:00:00.000Z",
              }
            : ({} as ImportSessionViewV1["receipt"]),
      } as ImportSessionViewV1;
      mocks.prepareImportSession.mockResolvedValue(invalid);
      mocks.getFullImportSession.mockResolvedValue(invalid);
      const { result } = setup();
      await waitFor(() => expect(result.current.busy).toBe(false));

      await act(async () => {
        await result.current.openReview();
      });

      expect(result.current.error).not.toBeNull();
      expect(result.current.review).toBe(false);
      expect(result.current.view?.revision).toBe(4);
    },
  );

  it.each(["direct response", "lost response recovery"] as const)(
    "accepts legitimate NEEDS_INPUT with an added decision question from %s",
    async (path) => {
      const initial: ImportSessionViewV1 = {
        ...base,
        lines: [unresolvedLine],
        selectedLineIds: [unresolvedLine.id],
      };
      const prepared = needsDecision();
      if (path === "direct response") {
        mocks.prepareImportSession.mockResolvedValue(prepared);
      } else {
        mocks.prepareImportSession.mockRejectedValue(new TypeError("network"));
      }
      const { result } = setup(initial);
      await waitFor(() => expect(result.current.busy).toBe(false));
      if (path === "lost response recovery")
        mocks.getFullImportSession.mockResolvedValue(prepared);

      let returned: ImportSessionViewV1 | null = null;
      await act(async () => {
        returned = await result.current.openReview();
      });

      expect(returned).toEqual(prepared);
      expect(result.current.view).toEqual(prepared);
      expect(result.current.question).toEqual(prepared.questions[0]);
      expect(result.current.review).toBe(false);
      expect(result.current.error).toBeNull();
      expect(mocks.prepareImportSession).toHaveBeenCalledOnce();
      expect(mocks.agentSend).not.toHaveBeenCalled();
    },
  );
});
