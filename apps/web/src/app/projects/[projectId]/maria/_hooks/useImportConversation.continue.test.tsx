import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExpenseType, type ImportSessionViewV1 } from "@reformaflow/domain";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentLotFixture,
  declarationViewFixture,
} from "../_lib/import-workflow-fixtures";
import { useImportConversation } from "./useImportConversation";

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: "actor-a" } }),
}));

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function pendingView(): ImportSessionViewV1 {
  const view = declarationViewFixture();
  return {
    ...view,
    state: "READY",
    revision: 8,
    questions: [],
    guidedReview: {
      progress: "READY_WITH_PENDING",
      focus: null,
      actions: ["CONTINUE_ANSWERING", "REVIEW_READY"],
    },
  };
}

function answeringView(revision = 9): ImportSessionViewV1 {
  const view = pendingView();
  const question = {
    id: "question-type",
    lineIds: ["first"],
    field: "tipoDespesa" as const,
    text: "internal",
  };
  return {
    ...view,
    state: "NEEDS_INPUT",
    revision,
    questions: [question],
    guidedReview: {
      progress: "ANSWERING",
      actions: ["CONTINUE_ANSWERING"],
      focus: {
        questionId: question.id,
        lineId: "first",
        control: "EXPENSE_TYPE",
        prompt: "Qual é o tipo de despesa?",
        context: {
          title: "Compra importada",
          merchant: "Loja",
          amountCents: 10_000,
          purchaseDate: "2026-10-08",
        },
        options: [
          {
            label: "Opção exclusiva do servidor",
            answer: {
              kind: "EXPENSE_TYPE",
              value: ExpenseType.MATERIAL_CONSTRUCAO,
            },
          },
        ],
        purchaseOrdinal: 1,
        purchaseTotal: 2,
        questionOrdinal: 3,
        questionTotal: 4,
      },
    },
  };
}

describe("useImportConversation continuation intents", () => {
  let client: QueryClient;
  let current: ImportSessionViewV1;
  let calls: Array<{
    method: string;
    path: string;
    body: Record<string, unknown> | null;
  }>;

  beforeEach(() => {
    current = pendingView();
    calls = [];
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    client.clear();
    vi.unstubAllGlobals();
  });

  function mount() {
    return renderHook(() => useImportConversation("session-a"), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
  }

  it("continues pending work with a server command, authoritative read, and fresh focus once", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? "GET";
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : null;
        calls.push({ method, path, body });
        if (path.endsWith("/current-lot/continue")) {
          current = answeringView();
          return response({
            version: 1,
            requestId: body?.requestId,
            operation: "CONTINUE_ANSWERING",
            outcome: "NEEDS_INPUT",
            revision: 9,
          });
        }
        if (method === "GET") return response(current);
        throw new Error(`Unexpected ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() =>
      expect(h.result.current.guidedReview?.progress).toBe(
        "READY_WITH_PENDING",
      ),
    );

    await act(async () => h.result.current.continueGuidedReview());

    expect(calls.slice(1)).toEqual([
      {
        method: "POST",
        path: "/import-sessions/session-a/current-lot/continue",
        body: {
          version: 1,
          requestId: expect.any(String),
          expectedRevision: 8,
        },
      },
      {
        method: "GET",
        path: "/import-sessions/session-a",
        body: null,
      },
    ]);
    expect(h.result.current.question?.id).toBe("question-type");
    expect(h.result.current.guidedFocus?.options).toEqual(
      answeringView().guidedReview?.focus?.options,
    );
    expect(h.result.current.selectionRecoveryFocus).toEqual({
      epoch: 1,
      outcome: "APPLIED",
    });
    expect(
      calls.some(({ path }) => path.endsWith("/current-lot/prepare")),
    ).toBe(false);

    act(() => h.rerender());
    expect(h.result.current.selectionRecoveryFocus).toEqual({
      epoch: 1,
      outcome: "APPLIED",
    });
  });

  it("replays the same request id after response loss is verified as not applied", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? "GET";
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : null;
        calls.push({ method, path, body });
        if (path.endsWith("/current-lot/continue")) {
          posts += 1;
          if (posts === 1) throw new TypeError("response lost");
          current = answeringView();
          return response({
            version: 1,
            requestId: body?.requestId,
            operation: "CONTINUE_ANSWERING",
            outcome: "NEEDS_INPUT",
            revision: 9,
          });
        }
        if (method === "GET") return response(current);
        throw new Error(`Unexpected ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() => expect(h.result.current.view?.revision).toBe(8));

    await act(async () => h.result.current.continueGuidedReview());
    expect(h.result.current.error).not.toBeNull();

    await act(async () => h.result.current.recover());
    expect(h.result.current.error).toBeNull();
    expect(h.result.current.guidedReview?.progress).toBe("READY_WITH_PENDING");

    await act(async () => h.result.current.continueGuidedReview());

    const commands = calls.filter(({ path }) =>
      path.endsWith("/current-lot/continue"),
    );
    expect(commands).toHaveLength(2);
    expect(commands[1].body).toEqual(commands[0].body);
    expect(h.result.current.question?.id).toBe("question-type");
  });

  it("recovers an applied command whose response was lost without posting twice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? "GET";
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : null;
        calls.push({ method, path, body });
        if (path.endsWith("/current-lot/continue")) {
          current = answeringView();
          throw new TypeError("response lost");
        }
        if (method === "GET") return response(current);
        throw new Error(`Unexpected ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() => expect(h.result.current.view?.revision).toBe(8));

    await act(async () => h.result.current.continueGuidedReview());
    expect(h.result.current.error).not.toBeNull();

    await act(async () => h.result.current.recover());

    expect(h.result.current.error).toBeNull();
    expect(h.result.current.question?.id).toBe("question-type");
    expect(h.result.current.selectionRecoveryFocus).toEqual({
      epoch: 1,
      outcome: "APPLIED",
    });
    expect(
      calls.filter(({ path }) => path.endsWith("/current-lot/continue")),
    ).toHaveLength(1);
  });

  it("rejects a stale command/read pair without exposing stale browser questions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? "GET";
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : null;
        calls.push({ method, path, body });
        if (path.endsWith("/current-lot/continue"))
          return response({
            version: 1,
            requestId: body?.requestId,
            operation: "CONTINUE_ANSWERING",
            outcome: "NEEDS_INPUT",
            revision: 9,
          });
        if (method === "GET") return response(current);
        throw new Error(`Unexpected ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() => expect(h.result.current.view?.revision).toBe(8));

    await act(async () => h.result.current.continueGuidedReview());

    expect(h.result.current.error).not.toBeNull();
    expect(h.result.current.question).toBeNull();
    expect(h.result.current.guidedFocus).toBeNull();
  });

  it("drops a definitively stale command before retrying the fresh revision", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? "GET";
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : null;
        calls.push({ method, path, body });
        if (path.endsWith("/current-lot/continue")) {
          posts += 1;
          if (posts === 1) {
            current = { ...pendingView(), revision: 9 };
            return response(
              {
                code: "REVISION_CONFLICT",
                currentRevision: 9,
                reason: null,
                retryable: false,
                sessionId: "session-a",
              },
              409,
            );
          }
          current = answeringView(10);
          return response({
            version: 1,
            requestId: body?.requestId,
            operation: "CONTINUE_ANSWERING",
            outcome: "NEEDS_INPUT",
            revision: 10,
          });
        }
        if (method === "GET") return response(current);
        throw new Error(`Unexpected ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() => expect(h.result.current.view?.revision).toBe(8));

    await act(async () => h.result.current.continueGuidedReview());
    expect(h.result.current.error).not.toBeNull();
    await act(async () => h.result.current.recover());
    expect(h.result.current.view?.revision).toBe(9);

    await act(async () => h.result.current.continueGuidedReview());

    const commands = calls.filter(({ path }) =>
      path.endsWith("/current-lot/continue"),
    );
    expect(commands).toHaveLength(2);
    expect(commands[0].body).toMatchObject({ expectedRevision: 8 });
    expect(commands[1].body).toMatchObject({ expectedRevision: 9 });
    expect(commands[1].body?.requestId).not.toBe(commands[0].body?.requestId);
  });

  it.each(["READY", "READY_WITH_PENDING"] as const)(
    "opens an already %s lot with one GET, no write, then removes private workflow data",
    async (progress) => {
      current = {
        ...pendingView(),
        guidedReview:
          progress === "READY"
            ? {
                progress,
                focus: null,
                actions: ["REVIEW_READY"],
              }
            : pendingView().guidedReview,
      };
      const lot = {
        ...currentLotFixture(),
        state:
          progress === "READY"
            ? ("READY" as const)
            : ("READY_WITH_PENDING" as const),
        revision: 8,
        confirmationHash: "b".repeat(64),
        hasRemainingWork: progress === "READY_WITH_PENDING",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          const method = init?.method ?? "GET";
          const body = init?.body
            ? (JSON.parse(String(init.body)) as Record<string, unknown>)
            : null;
          calls.push({ method, path, body });
          return response(path.endsWith("/current-lot") ? lot : current);
        }),
      );
      const removeQueries = vi.spyOn(client, "removeQueries");
      const h = mount();
      await waitFor(() =>
        expect(h.result.current.guidedReview?.progress).toBe(progress),
      );
      const offset = calls.length;

      await act(async () => h.result.current.reviewCurrentLot());

      expect(calls.slice(offset)).toEqual([
        {
          method: "GET",
          path: "/import-sessions/session-a/current-lot",
          body: null,
        },
      ]);
      expect(h.result.current.currentLot).toEqual(lot);
      expect(h.result.current.currentLot).toMatchObject({
        revision: 8,
        confirmationHash: "b".repeat(64),
      });
      expect(removeQueries).toHaveBeenCalledWith({
        queryKey: ["maria", "import", "actor-a", "workflow", "session-a"],
        exact: true,
      });
      expect(
        client.getQueryData([
          "maria",
          "import",
          "actor-a",
          "workflow",
          "session-a",
        ]),
      ).toBeUndefined();
      expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);
    },
  );
});
