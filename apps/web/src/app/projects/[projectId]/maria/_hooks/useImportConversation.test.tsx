import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appliedFixture,
  currentLotFixture,
  declarationQuestionFixture,
  declarationViewFixture,
  declaredFactFixture,
} from "../_lib/import-workflow-fixtures";
import { useImportConversation } from "./useImportConversation";

const auth = vi.hoisted(() => ({
  user: { id: "actor-a" } as { id: string } | null,
}));
vi.mock("@/contexts/auth-context", () => ({ useAuth: () => auth }));
vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({ projectId: "not-an-import-anchor" }),
}));

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("useImportConversation guided documentary contract", () => {
  let client: QueryClient;
  let current: ImportSessionViewV1;
  let requests: Array<{
    path: string;
    method: string;
    body: Record<string, unknown> | null;
  }>;
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
    auth.user = { id: "actor-a" };
    current = declarationViewFixture();
    requests = [];
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    fetchStub = vi.fn(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : null;
      requests.push({ path, method, body });
      if (method === "GET") return response(current);
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(() => {
    client.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function mount(sessionId: string | null = "session-a") {
    return renderHook(({ id }) => useImportConversation(id), {
      initialProps: { id: sessionId },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
  }

  it("reads the authoritative view and focuses the first unanswered selected question", async () => {
    vi.useRealTimers();
    current.questions[0] = declarationQuestionFixture("first", "DECLARED");
    current.declaredFacts = [declaredFactFixture()];
    const h = mount();

    await waitFor(() =>
      expect(h.result.current.question?.id).toBe("oq_twin_amount"),
    );
    expect(h.result.current.view?.questions).toHaveLength(2);
    expect(requests).toEqual([
      {
        path: "/import-sessions/session-a",
        method: "GET",
        body: null,
      },
    ]);
  });

  it("keeps selected documentary questions eligible when guided focus is null", async () => {
    vi.useRealTimers();
    current = {
      ...current,
      questions: [
        {
          id: "raw-guided-decision",
          lineIds: ["first"],
          field: "decision",
          text: "raw guided question",
        },
        ...current.questions,
      ],
      guidedReview: {
        progress: "ANSWERING",
        focus: null,
        actions: ["CONTINUE_ANSWERING"],
      },
    };
    const h = mount();

    await waitFor(() => expect(h.result.current.view).not.toBeNull());
    expect(h.result.current.question?.id).toBe("oq_first_amount");
    expect(h.result.current.guidedFocus).toBeNull();
    expect(h.result.current.selectionRecoveryFocus).toBeNull();

    act(() => h.result.current.editQuestion("raw-guided-decision"));

    expect(h.result.current.question?.id).toBe("oq_first_amount");

    act(() => h.result.current.editQuestion("oq_twin_amount"));

    expect(h.result.current.question?.id).toBe("oq_twin_amount");
    expect(h.result.current.selectionRecoveryFocus).toBeNull();
  });

  it("uses a generic non-guided draft question when guided focus is null", async () => {
    vi.useRealTimers();
    const guidedFields = [
      "decision",
      "targets",
      "tipoDespesa",
      "categoriaMaoDeObra",
    ] as const;
    current = {
      ...current,
      questions: [
        ...guidedFields.map((field) => ({
          id: `raw-guided-${field}`,
          lineIds: ["first"],
          field,
          text: `raw guided ${field}`,
        })),
        {
          id: "generic-amount",
          lineIds: ["first"],
          field: "amountCents",
          text: "raw generic question",
        },
      ],
      guidedReview: {
        progress: "ANSWERING",
        focus: null,
        actions: ["CONTINUE_ANSWERING"],
      },
    };
    const h = mount();

    await waitFor(() =>
      expect(h.result.current.question?.id).toBe("generic-amount"),
    );
    expect(h.result.current.guidedFocus).toBeNull();

    for (const field of guidedFields) {
      act(() => h.result.current.editQuestion(`raw-guided-${field}`));
      expect(h.result.current.question?.id).toBe("generic-amount");
    }
  });

  it("uses only the exact guided focus question and never substitutes another raw question", async () => {
    vi.useRealTimers();
    const exactQuestion: ImportSessionViewV1["questions"][number] = {
      id: "authoritative-question",
      lineIds: ["first"],
      field: "decision",
      text: "raw exact question",
    };
    current = {
      ...current,
      questions: [current.questions[0], exactQuestion],
      guidedReview: {
        progress: "ANSWERING",
        actions: ["CONTINUE_ANSWERING"],
        focus: {
          questionId: exactQuestion.id,
          lineId: "first",
          control: "DECISION",
          prompt: "O que deve acontecer com esta compra?",
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
                kind: "DECISION",
                value: { kind: "CREATE", acceptNaturalDuplicate: false },
              },
            },
          ],
          purchaseOrdinal: 1,
          purchaseTotal: 1,
          questionOrdinal: 1,
          questionTotal: 1,
        },
      },
    };
    const h = mount();

    await waitFor(() => expect(h.result.current.view).not.toBeNull());
    expect(h.result.current.guidedFocus?.questionId).toBe(exactQuestion.id);
    expect(h.result.current.question).toEqual(exactQuestion);
  });

  it("does not read private import state without an authenticated actor", () => {
    auth.user = null;
    const h = mount();
    expect(h.result.current.view).toBeNull();
    expect(h.result.current.question).toBeNull();
    expect(requests).toEqual([]);
  });

  it("uses declarations for documentary questions and rereads the exact revision", async () => {
    vi.useRealTimers();
    fetchStub.mockImplementation(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : null;
      requests.push({ path, method, body });
      if (method === "GET") return response(current);
      if (path.endsWith("/declarations")) {
        current = {
          ...current,
          revision: 8,
          questions: [
            declarationQuestionFixture("first", "DECLARED"),
            declarationQuestionFixture("twin"),
          ],
          declaredFacts: [declaredFactFixture()],
        };
        return response({
          version: 1,
          requestId: body?.requestId,
          operation: "DECLARE",
          outcome: "APPLIED",
          revision: 8,
        });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const h = mount();
    await waitFor(() =>
      expect(h.result.current.question?.id).toBe("oq_first_amount"),
    );

    await act(async () => {
      await h.result.current.saveGuidedAnswer({
        questionId: "oq_first_amount",
        answer: { kind: "KNOWN", value: 20696 },
      });
    });

    const command = requests.find(({ path }) => path.endsWith("/declarations"));
    expect(command?.body).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: 7,
      questionId: "oq_first_amount",
      answer: { kind: "KNOWN", value: 20696 },
    });
    expect(h.result.current.view?.revision).toBe(8);
    expect(h.result.current.question?.id).toBe("oq_twin_amount");
    expect(
      requests.some(
        ({ path, method }) => path === "/agent/chat" || method === "PATCH",
      ),
    ).toBe(false);
  });

  it("uses resolutions for typed draft questions instead of generic PATCH", async () => {
    vi.useRealTimers();
    current = {
      ...current,
      questions: [
        {
          id: "q_amount",
          lineIds: ["first"],
          field: "amountCents",
          text: "RAW_TECHNICAL_QUESTION",
        },
      ],
    };
    fetchStub.mockImplementation(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : null;
      requests.push({ path, method, body });
      if (method === "GET") return response(current);
      if (path.endsWith("/resolutions")) {
        current = { ...current, revision: 8, questions: [] };
        return response({
          version: 1,
          requestId: body?.requestId,
          operation: "RESOLVE",
          outcome: "APPLIED",
          revision: 8,
        });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const h = mount();
    await waitFor(() => expect(h.result.current.question?.id).toBe("q_amount"));

    await act(async () => {
      await h.result.current.saveGuidedAnswer({
        questionId: "q_amount",
        answer: { kind: "KNOWN", value: 20696 },
      });
    });

    expect(
      requests.find(({ path }) => path.endsWith("/resolutions"))?.body,
    ).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: 7,
      questionId: "q_amount",
      answer: { kind: "CENTS", value: 20696 },
    });
    expect(requests.some(({ method }) => method === "PATCH")).toBe(false);
  });

  it.each([
    {
      field: "targets",
      answer: {
        kind: "TARGETS",
        value: [
          {
            projectId: "project-authorized",
            roomId: "room-authorized",
            amountCents: 20696,
          },
        ],
      },
    },
    {
      field: "tipoDespesa",
      answer: { kind: "EXPENSE_TYPE", value: "MATERIAL_CONSTRUCAO" },
    },
    {
      field: "categoriaMaoDeObra",
      answer: { kind: "LABOR_CATEGORY", value: "PINTOR" },
    },
  ] as const)(
    "posts the supplied $field answer directly without chat or interpretation",
    async ({ field, answer }) => {
      vi.useRealTimers();
      current = {
        ...current,
        questions: [
          {
            id: `q_${field}`,
            lineIds: ["first"],
            field,
            text: "internal",
          },
        ],
      };
      fetchStub.mockImplementation(
        async (url: string, options?: RequestInit) => {
          const path = new URL(url).pathname;
          const method = options?.method ?? "GET";
          const body = options?.body
            ? (JSON.parse(String(options.body)) as Record<string, unknown>)
            : null;
          requests.push({ path, method, body });
          if (method === "GET") return response(current);
          if (path.endsWith("/resolutions")) {
            current = { ...current, revision: 8, questions: [] };
            return response({
              version: 1,
              requestId: body?.requestId,
              operation: "RESOLVE",
              outcome: "APPLIED",
              revision: 8,
            });
          }
          throw new Error(`Unexpected request: ${method} ${path}`);
        },
      );

      const h = mount();
      await waitFor(() =>
        expect(h.result.current.question?.id).toBe(`q_${field}`),
      );

      await act(async () => {
        await h.result.current.saveGuidedAnswer({
          questionId: `q_${field}`,
          answer: answer as never,
        });
      });

      expect(
        requests.filter(({ path }) => path.endsWith("/resolutions")),
      ).toHaveLength(1);
      expect(
        requests.find(({ path }) => path.endsWith("/resolutions"))?.body,
      ).toMatchObject({ answer });
      expect(
        requests.some(
          ({ path, method }) =>
            path === "/agent/chat" ||
            path.endsWith("/interpret") ||
            method === "PATCH",
        ),
      ).toBe(false);
    },
  );

  it("emits one explicit focus request only after an accepted receipt and authoritative reread", async () => {
    vi.useRealTimers();
    const typeQuestion = {
      id: "q_type",
      lineIds: ["first"],
      field: "tipoDespesa" as const,
      text: "internal",
    };
    const laborQuestion = {
      id: "q_labor",
      lineIds: ["first"],
      field: "categoriaMaoDeObra" as const,
      text: "internal",
    };
    const focus = (
      question: typeof typeQuestion | typeof laborQuestion,
      ordinal: number,
      total: number,
      kind: "EXPENSE_TYPE" | "LABOR_CATEGORY",
    ) => ({
      progress: "ANSWERING",
      actions: ["CONTINUE_ANSWERING"],
      focus: {
        questionId: question.id,
        lineId: "first",
        control: kind,
        prompt:
          kind === "EXPENSE_TYPE"
            ? "Qual é o tipo de despesa?"
            : "Qual é a categoria de mão de obra?",
        context: {
          title: "Compra importada",
          merchant: "Loja",
          amountCents: 10_000,
          purchaseDate: "2026-10-08",
        },
        options:
          kind === "EXPENSE_TYPE"
            ? [
                {
                  label: "Material de construção",
                  answer: {
                    kind,
                    value: "MATERIAL_CONSTRUCAO",
                  },
                },
              ]
            : [
                {
                  label: "Pintura",
                  answer: { kind, value: "PINTOR" },
                },
              ],
        purchaseOrdinal: 1,
        purchaseTotal: 2,
        questionOrdinal: ordinal,
        questionTotal: total,
      },
    });
    current = {
      ...current,
      questions: [typeQuestion, laborQuestion],
    };
    Object.assign(current, {
      guidedReview: focus(typeQuestion, 1, 2, "EXPENSE_TYPE"),
    });
    fetchStub.mockImplementation(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : null;
      requests.push({ path, method, body });
      if (method === "GET") return response(current);
      if (path.endsWith("/resolutions")) {
        current = { ...current, revision: 8, questions: [laborQuestion] };
        Object.assign(current, {
          guidedReview: focus(laborQuestion, 2, 2, "LABOR_CATEGORY"),
        });
        return response({
          version: 1,
          requestId: body?.requestId,
          operation: "RESOLVE",
          outcome: "APPLIED",
          revision: 8,
        });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const h = mount();
    await waitFor(() => expect(h.result.current.question?.id).toBe("q_type"));
    expect(h.result.current.selectionRecoveryFocus).toBeNull();

    await act(async () => {
      await h.result.current.saveGuidedAnswer({
        questionId: "q_type",
        answer: {
          kind: "EXPENSE_TYPE",
          value: "MATERIAL_CONSTRUCAO",
        } as never,
      });
    });

    expect(h.result.current.question?.id).toBe("q_labor");
    expect(h.result.current.selectionRecoveryFocus).toMatchObject({
      outcome: "APPLIED",
    });
    expect(requests.map(({ method }) => method)).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });

  it("sends free text only to the consented interpretation endpoint", async () => {
    vi.useRealTimers();
    fetchStub.mockImplementation(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : null;
      requests.push({ path, method, body });
      if (method === "GET") return response(current);
      if (path.endsWith("/interpretations"))
        return response({
          version: 1,
          requestId: body?.requestId,
          outcome: "CANDIDATE",
          candidate: { kind: "KNOWN", value: 150000 },
        });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const h = mount();
    await waitFor(() => expect(h.result.current.question).not.toBeNull());

    let outcome: unknown;
    await act(async () => {
      outcome = await h.result.current.interpretAnswer("foi mil e quinhentos");
    });

    expect(outcome).toMatchObject({
      outcome: "CANDIDATE",
      candidate: { kind: "KNOWN", value: 150000 },
    });
    expect(
      requests.find(({ path }) => path.endsWith("/interpretations"))?.body,
    ).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: 7,
      questionId: "oq_first_amount",
      text: "foi mil e quinhentos",
      consentExternalProcessing: true,
    });
    expect(h.result.current.view?.revision).toBe(7);
  });

  it("prepares and then reads a partial ready lot", async () => {
    vi.useRealTimers();
    const lot = currentLotFixture();
    lot.state = "READY_WITH_PENDING";
    fetchStub.mockImplementation(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : null;
      requests.push({ path, method, body });
      if (path.endsWith("/current-lot/prepare"))
        return response({
          version: 1,
          requestId: body?.requestId,
          operation: "PREPARE_CURRENT_LOT",
          outcome: "CURRENT_LOT_READY",
          revision: 7,
        });
      if (path.endsWith("/current-lot")) return response(lot);
      if (method === "GET") return response(current);
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const h = mount();
    await waitFor(() => expect(h.result.current.view).not.toBeNull());

    await act(async () => h.result.current.reviewCurrentLot());

    expect(
      requests.slice(1).map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "POST /import-sessions/session-a/current-lot/prepare",
      "GET /import-sessions/session-a",
      "GET /import-sessions/session-a/current-lot",
    ]);
    expect(h.result.current.currentLot).toEqual(lot);
    expect(h.result.current.review).toBe(true);
    expect(h.result.current.view).toBeNull();
  });

  it("publishes a ready continuation without reading a lot or removing its query", async () => {
    vi.useRealTimers();
    current = {
      ...current,
      questions: [
        {
          id: "stale-decision",
          lineIds: ["first"],
          field: "decision",
          text: "raw stale question",
        },
      ],
      guidedReview: {
        progress: "ANSWERING",
        focus: null,
        actions: ["CONTINUE_ANSWERING"],
      },
    };
    const removeQueries = vi.spyOn(client, "removeQueries");
    const ready: ImportSessionViewV1 = {
      ...current,
      revision: 8,
      guidedReview: {
        progress: "READY_WITH_PENDING",
        focus: null,
        actions: ["CONTINUE_ANSWERING", "REVIEW_READY"],
      },
    };
    fetchStub.mockImplementation(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : null;
      requests.push({ path, method, body });
      if (path.endsWith("/current-lot/prepare")) {
        current = ready;
        return response({
          version: 1,
          requestId: body?.requestId,
          operation: "PREPARE_CURRENT_LOT",
          outcome: "CURRENT_LOT_READY",
          revision: 8,
        });
      }
      if (path.endsWith("/current-lot"))
        throw new Error("Continue intent must not read the current lot");
      if (method === "GET") return response(current);
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const h = mount();
    await waitFor(() => expect(h.result.current.view).not.toBeNull());

    await act(async () => h.result.current.prepareCurrentLot());

    expect(h.result.current.currentLot).toBeNull();
    expect(h.result.current.review).toBe(false);
    expect(h.result.current.view?.revision).toBe(8);
    expect(h.result.current.guidedReview).toEqual({
      progress: "READY_WITH_PENDING",
      focus: null,
      actions: ["CONTINUE_ANSWERING", "REVIEW_READY"],
    });
    expect(
      client.getQueryData([
        "maria",
        "import",
        "actor-a",
        "workflow",
        "session-a",
      ]),
    ).toEqual(current);
    expect(removeQueries).not.toHaveBeenCalled();
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /import-sessions/session-a",
      "POST /import-sessions/session-a/current-lot/prepare",
      "GET /import-sessions/session-a",
    ]);
  });

  it("continues null guided focus at the current revision and exposes only fresh server options", async () => {
    vi.useRealTimers();
    current = {
      ...current,
      questions: [
        {
          id: "stale-decision",
          lineIds: ["first"],
          field: "decision",
          text: "raw stale question",
        },
      ],
      guidedReview: {
        progress: "ANSWERING",
        focus: null,
        actions: ["CONTINUE_ANSWERING"],
      },
    };
    fetchStub.mockImplementation(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : null;
      requests.push({ path, method, body });
      if (path.endsWith("/current-lot/prepare")) {
        current = {
          ...current,
          revision: 8,
          questions: [
            {
              id: "server-decision",
              lineIds: ["first"],
              field: "decision",
              text: "raw server question",
            },
          ],
          guidedReview: {
            progress: "ANSWERING",
            actions: ["CONTINUE_ANSWERING"],
            focus: {
              questionId: "server-decision",
              lineId: "first",
              control: "DECISION",
              prompt: "O que deve acontecer com esta compra?",
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
                    kind: "DECISION",
                    value: { kind: "CREATE", acceptNaturalDuplicate: false },
                  },
                },
              ],
              purchaseOrdinal: 1,
              purchaseTotal: 1,
              questionOrdinal: 1,
              questionTotal: 1,
            },
          },
        };
        return response({
          version: 1,
          requestId: body?.requestId,
          operation: "PREPARE_CURRENT_LOT",
          outcome: "NEEDS_INPUT",
          revision: 8,
        });
      }
      return response(current);
    });
    const h = mount();
    await waitFor(() => expect(h.result.current.view).not.toBeNull());
    expect(h.result.current.question).toBeNull();

    await act(async () => h.result.current.prepareCurrentLot());

    expect(h.result.current.currentLot).toBeNull();
    expect(h.result.current.review).toBe(false);
    expect(h.result.current.question?.id).toBe("server-decision");
    expect(h.result.current.guidedFocus?.options).toEqual([
      {
        label: "Opção exclusiva do servidor",
        answer: {
          kind: "DECISION",
          value: { kind: "CREATE", acceptNaturalDuplicate: false },
        },
      },
    ]);
    expect(
      requests.filter(({ path }) => path.endsWith("/current-lot/prepare")),
    ).toEqual([
      {
        path: "/import-sessions/session-a/current-lot/prepare",
        method: "POST",
        body: {
          version: 1,
          requestId: expect.any(String),
          expectedRevision: 7,
        },
      },
    ]);
    expect(requests.filter(({ method }) => method === "GET")).toHaveLength(2);
  });

  it("reads an applied result only through explicit recovery", async () => {
    vi.useRealTimers();
    current = appliedFixture();
    fetchStub.mockImplementation(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      requests.push({ path, method, body: null });
      if (path.endsWith("/result"))
        return response({ state: "APPLIED", receipt: current.receipt });
      return response(current);
    });
    const h = mount();
    await waitFor(() => expect(h.result.current.view?.state).toBe("APPLIED"));
    await act(async () => h.result.current.recover(true));
    expect(h.result.current.result?.state).toBe("APPLIED");
    expect(
      requests.filter(({ path }) => path.endsWith("/result")),
    ).toHaveLength(1);
  });

  it("rejects malformed session reads without exposing partial workflow data", async () => {
    vi.useRealTimers();
    fetchStub.mockResolvedValue(response({ id: "session-a", revision: 7 }));
    const h = mount();
    await waitFor(() => expect(h.result.current.error).not.toBeNull());
    expect(h.result.current.view).toBeNull();
    expect(h.result.current.question).toBeNull();
  });

  it("settles duplicate same-tick saves as one declaration command", async () => {
    vi.useRealTimers();
    const gate = deferred<Response>();
    fetchStub.mockImplementation(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      if (method === "GET") return response(current);
      if (path.endsWith("/declarations")) return gate.promise;
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const h = mount();
    await waitFor(() => expect(h.result.current.question).not.toBeNull());
    let first!: Promise<unknown>;
    act(() => {
      first = h.result.current.saveGuidedAnswer({
        questionId: "oq_first_amount",
        answer: { kind: "KNOWN", value: 10000 },
      });
      void h.result.current.saveGuidedAnswer({
        questionId: "oq_first_amount",
        answer: { kind: "KNOWN", value: 10000 },
      });
    });
    current = { ...current, revision: 8 };
    gate.resolve(
      response({
        version: 1,
        requestId: expect.any(String),
        operation: "DECLARE",
        outcome: "APPLIED",
        revision: 8,
      }),
    );
    await act(async () => first);
    expect(
      fetchStub.mock.calls.filter(([url]) =>
        String(url).endsWith("/declarations"),
      ),
    ).toHaveLength(1);
  });

  it("drops a delayed read when the actor and session change", async () => {
    vi.useRealTimers();
    const gate = deferred<Response>();
    fetchStub.mockImplementationOnce(() => gate.promise);
    const h = mount();

    auth.user = { id: "actor-b" };
    current = { ...declarationViewFixture(), id: "session-b" };
    h.rerender({ id: "session-b" });
    gate.resolve(response(declarationViewFixture()));

    await waitFor(() => expect(h.result.current.view?.id).toBe("session-b"));
    expect(h.result.current.userId).toBe("actor-b");
    expect(h.result.current.view?.id).not.toBe("session-a");
  });
});
