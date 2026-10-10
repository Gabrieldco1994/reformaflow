import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useImportConversation } from "./useImportConversation";
import {
  declarationViewFixture,
  declaredFactFixture,
} from "../_lib/import-workflow-fixtures";

const auth = vi.hoisted(() => ({
  user: { id: "actor-a" } as { id: string } | null,
}));

vi.mock("@/contexts/auth-context", () => ({ useAuth: () => auth }));
vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({ projectId: "not-an-import-anchor" }),
}));

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("guided import uses deterministic command transports", () => {
  let current: ImportSessionViewV1;
  let client: QueryClient;
  let requests: Array<{ path: string; method: string; body: any }>;

  beforeEach(() => {
    auth.user = { id: "actor-a" };
    current = declarationViewFixture();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    requests = [];
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

  it("guided_answer_uses_typed_declaration_command_not_literal_or_patch and keeps requestId on retry", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (path.endsWith("/declarations")) {
          attempts++;
          if (attempts === 1)
            return response({ message: "temporariamente indisponível" }, 503);
          current = {
            ...current,
            revision: 8,
            declaredFacts: [declaredFactFixture()],
          };
          return response({
            version: 1,
            requestId: body.requestId,
            operation: "DECLARE",
            outcome: "APPLIED",
            revision: 8,
          });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() =>
      expect(h.result.current.question?.id).toBe("oq_first_amount"),
    );

    await act(async () => {
      await h.result.current.saveDeclaration({
        id: "oq_first_amount",
        text: "R$ 100,00",
      });
    });
    await act(async () => {
      await h.result.current.saveDeclaration({
        id: "oq_first_amount",
        text: "R$ 100,00",
      });
    });

    const commands = requests.filter((request) =>
      request.path.endsWith("/declarations"),
    );
    expect(commands).toHaveLength(2);
    expect(commands[0].body.requestId).toBe(commands[1].body.requestId);
    expect(commands[0].body).toEqual({
      version: 1,
      requestId: commands[0].body.requestId,
      expectedRevision: 7,
      questionId: "oq_first_amount",
      answer: { kind: "KNOWN", value: 10000 },
    });
    expect(
      requests.some(
        ({ path, method }) => path === "/agent/chat" || method === "PATCH",
      ),
    ).toBe(false);
  });

  it("resolves a structured draft decision, rereads revision, and uses no interpretation or financial route", async () => {
    current = {
      ...current,
      questions: [
        {
          id: "question-decision",
          lineIds: ["first"],
          field: "decision",
          text: "raw internal text",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (path.endsWith("/resolutions")) {
          current = { ...current, revision: 8, questions: [] };
          return response({
            version: 1,
            requestId: body.requestId,
            operation: "RESOLVE",
            outcome: "APPLIED",
            revision: 8,
          });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() =>
      expect(h.result.current.question?.id).toBe("question-decision"),
    );

    await act(async () => {
      await h.result.current.saveGuidedAnswer({
        questionId: "question-decision",
        answer: {
          kind: "DECISION",
          value: { kind: "CREATE", acceptNaturalDuplicate: true },
        },
      });
    });

    const command = requests.find(({ path }) => path.endsWith("/resolutions"));
    expect(command?.body).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: 7,
      questionId: "question-decision",
      answer: {
        kind: "DECISION",
        value: { kind: "CREATE", acceptNaturalDuplicate: true },
      },
    });
    expect(h.result.current.view?.revision).toBe(8);
    expect(
      requests.some(
        ({ path }) =>
          path === "/agent/chat" ||
          path.endsWith("/interpretations") ||
          path.endsWith("/declarations") ||
          path.includes("/current-lot"),
      ),
    ).toBe(false);
  });

  it("rejects interpretation for a draft question before any provider request", async () => {
    current = {
      ...current,
      questions: [
        {
          id: "question-decision",
          lineIds: ["first"],
          field: "decision",
          text: "raw internal text",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() =>
      expect(h.result.current.question?.id).toBe("question-decision"),
    );

    await act(async () => {
      await expect(
        h.result.current.interpretAnswer("crie uma compra"),
      ).rejects.toThrow("Interpretation is unavailable");
    });

    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(0);
    expect(requests.some(({ path }) => path.endsWith("/interpretations"))).toBe(
      false,
    );
  });

  it("defer_and_reactivate_use_dedicated_idempotent_commands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        const operation = path.endsWith("/defer") ? "DEFER" : "REACTIVATE";
        current = {
          ...current,
          revision: current.revision + 1,
          selectedLineIds:
            operation === "DEFER"
              ? current.selectedLineIds.filter((id) => id !== body.lineId)
              : [...current.selectedLineIds, body.lineId],
          lines: current.lines.map((line) =>
            line.id === body.lineId
              ? {
                  ...line,
                  decision:
                    operation === "DEFER"
                      ? ({ kind: "DEFER" } as const)
                      : ({ kind: "UNRESOLVED" } as const),
                }
              : line,
          ),
        };
        return response({
          version: 1,
          requestId: body.requestId,
          operation,
          outcome: "APPLIED",
          revision: current.revision,
        });
      }),
    );
    const h = mount();
    await waitFor(() => expect(h.result.current.view).not.toBeNull());

    await act(async () => h.result.current.removeFromSelection("first"));
    await act(async () => h.result.current.addToSelection("first"));

    const commands = requests.filter(({ method }) => method === "POST");
    expect(commands.map(({ path }) => path)).toEqual([
      "/import-sessions/session-a/defer",
      "/import-sessions/session-a/reactivate",
    ]);
    for (const command of commands) {
      expect(Object.keys(command.body).sort()).toEqual([
        "expectedRevision",
        "lineId",
        "requestId",
        "version",
      ]);
    }
    expect(requests.some(({ method }) => method === "PATCH")).toBe(false);
  });

  it("case A reconciles a commit-before-abort through a read without a second POST", async () => {
    let authoritativeApplications = 0;
    let receiptCreations = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (path.endsWith("/defer")) {
          current = {
            ...current,
            revision: 8,
            selectedLineIds: current.selectedLineIds.filter(
              (id) => id !== body.lineId,
            ),
            lines: current.lines.map((line) =>
              line.id === body.lineId
                ? { ...line, decision: { kind: "DEFER" as const } }
                : line,
            ),
          };
          authoritativeApplications++;
          receiptCreations++;
          throw new TypeError("connection reset after authoritative commit");
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() => expect(h.result.current.view).not.toBeNull());

    await act(async () => {
      await h.result.current.removeFromSelection("first");
    });
    expect(h.result.current.retryableSelection).toBeNull();

    await act(async () => {
      await h.result.current.recover();
    });

    const commands = requests.filter(({ path }) => path.endsWith("/defer"));
    expect(commands).toHaveLength(1);
    expect(commands[0].body).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: 7,
      lineId: "first",
    });
    expect(authoritativeApplications).toBe(1);
    expect(receiptCreations).toBe(1);
    expect(current.revision).toBe(8);
    expect(current.selectedLineIds).not.toContain("first");
    expect(current.lines.find(({ id }) => id === "first")?.decision).toEqual({
      kind: "DEFER",
    });
    expect(h.result.current.view?.revision).toBe(8);
    expect(h.result.current.view?.selectedLineIds).not.toContain("first");
    expect(h.result.current.retryableSelection).toBeNull();
    expect(
      requests.slice(1).map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "POST /import-sessions/session-a/defer",
      "GET /import-sessions/session-a",
    ]);
  });

  it("case B exposes the retained retry only after a read proves the defer was not applied", async () => {
    let deferAttempts = 0;
    let authoritativeApplications = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (path.endsWith("/defer")) {
          deferAttempts++;
          if (deferAttempts === 1)
            throw new TypeError("connection reset before commit");
          current = {
            ...current,
            revision: 8,
            selectedLineIds: current.selectedLineIds.filter(
              (id) => id !== body.lineId,
            ),
            lines: current.lines.map((line) =>
              line.id === body.lineId
                ? { ...line, decision: { kind: "DEFER" as const } }
                : line,
            ),
          };
          authoritativeApplications++;
          return response({
            version: 1,
            requestId: body.requestId,
            operation: "DEFER",
            outcome: "APPLIED",
            revision: current.revision,
          });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() => expect(h.result.current.view?.revision).toBe(7));
    const requestOffset = requests.length;

    await act(async () => {
      await h.result.current.removeFromSelection("first");
    });
    expect(h.result.current.retryableSelection).toBeNull();
    expect(authoritativeApplications).toBe(0);

    await act(async () => {
      await h.result.current.recover();
    });
    expect(h.result.current.retryableSelection).toEqual({
      operation: "DEFER",
      lineId: "first",
    });

    await act(async () => {
      await h.result.current.retrySelection();
    });

    const commands = requests.filter(({ path }) => path.endsWith("/defer"));
    expect(commands).toHaveLength(2);
    expect(commands[1].body).toEqual(commands[0].body);
    expect(
      requests
        .slice(requestOffset)
        .map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "POST /import-sessions/session-a/defer",
      "GET /import-sessions/session-a",
      "POST /import-sessions/session-a/defer",
      "GET /import-sessions/session-a",
    ]);
    expect(authoritativeApplications).toBe(1);
    expect(h.result.current.view?.revision).toBe(8);
    expect(h.result.current.view?.selectedLineIds).not.toContain("first");
    expect(h.result.current.retryableSelection).toBeNull();
  });

  it("case C keeps only read recovery when the authoritative GET is offline", async () => {
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        requests.push({ path, method, body });
        if (method === "GET") {
          reads++;
          if (reads === 1) return response(current);
          throw new TypeError("authoritative read offline");
        }
        if (path.endsWith("/defer"))
          throw new TypeError("connection reset before commit");
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() => expect(h.result.current.view).not.toBeNull());

    await act(async () => {
      await h.result.current.removeFromSelection("first");
    });
    expect(h.result.current.retryableSelection).toBeNull();

    await act(async () => {
      await h.result.current.recover();
    });

    expect(h.result.current.error).toMatchObject({
      recovery: "READ_SESSION",
      privateContextLost: false,
    });
    expect(h.result.current.retryableSelection).toBeNull();
    expect(requests.filter(({ path }) => path.endsWith("/defer"))).toHaveLength(
      1,
    );
    expect(requests.filter(({ method }) => method === "GET")).toHaveLength(2);
  });

  it("case D suppresses retry when the authoritative read finds a changed revision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (path.endsWith("/defer")) {
          current = { ...current, revision: 8 };
          throw new TypeError("connection reset while another write won");
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() => expect(h.result.current.view?.revision).toBe(7));

    await act(async () => {
      await h.result.current.removeFromSelection("first");
    });
    expect(h.result.current.retryableSelection).toBeNull();

    await act(async () => {
      await h.result.current.recover();
    });

    expect(h.result.current.view?.revision).toBe(8);
    expect(h.result.current.retryableSelection).toBeNull();
    expect(h.result.current.error).toMatchObject({
      recovery: "NONE",
      privateContextLost: false,
    });
    expect(requests.filter(({ path }) => path.endsWith("/defer"))).toHaveLength(
      1,
    );
  });

  it("forgets a known revision-conflict attempt before a fresh revision is acted on", async () => {
    let deferAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (path.endsWith("/defer")) {
          deferAttempts++;
          if (deferAttempts === 1) {
            current = { ...current, revision: 8 };
            return response(
              {
                code: "REVISION_CONFLICT",
                retryable: false,
                sessionId: "session-a",
                currentRevision: 8,
                reason: null,
              },
              409,
            );
          }
          current = {
            ...current,
            revision: 9,
            selectedLineIds: current.selectedLineIds.filter(
              (id) => id !== body.lineId,
            ),
            lines: current.lines.map((line) =>
              line.id === body.lineId
                ? { ...line, decision: { kind: "DEFER" as const } }
                : line,
            ),
          };
          return response({
            version: 1,
            requestId: body.requestId,
            operation: "DEFER",
            outcome: "APPLIED",
            revision: 9,
          });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() => expect(h.result.current.view?.revision).toBe(7));
    const requestOffset = requests.length;

    await act(async () => {
      await h.result.current.removeFromSelection("first");
    });
    expect(h.result.current.retryableSelection).toBeNull();

    await act(async () => {
      await client.refetchQueries({
        queryKey: ["maria", "import", "actor-a", "workflow", "session-a"],
        exact: true,
      });
    });
    await waitFor(() => expect(h.result.current.view?.revision).toBe(8));

    await act(async () => {
      await h.result.current.removeFromSelection("first");
    });

    const commands = requests.filter(({ path }) => path.endsWith("/defer"));
    expect(commands).toHaveLength(2);
    expect(commands[0].body).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: 7,
      lineId: "first",
    });
    expect
      .soft(commands[1].body.requestId)
      .not.toBe(commands[0].body.requestId);
    expect.soft(commands[1].body).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: 8,
      lineId: "first",
    });
    expect(
      requests
        .slice(requestOffset)
        .map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "POST /import-sessions/session-a/defer",
      "GET /import-sessions/session-a",
      "POST /import-sessions/session-a/defer",
      "GET /import-sessions/session-a",
    ]);
    expect(h.result.current.view?.revision).toBe(9);
    expect(h.result.current.view?.selectedLineIds).not.toContain("first");
    expect(
      requests.some(
        ({ path }) =>
          path === "/agent/chat" ||
          /\/(interpretations|confirmation-challenge|confirm|execute)$/.test(
            path,
          ),
      ),
    ).toBe(false);
  });

  it("prepare_uses_command_then_server_current_lot", async () => {
    const lot = {
      version: 1,
      state: "READY_WITH_PENDING",
      revision: 7,
      confirmationHash: "a".repeat(64),
      purchases: [],
      createdEconomicTotalCents: 0,
      bankCashDeltaCents: 0,
      invoiceDeltas: [],
      hasRemainingWork: true,
      actions: ["CONFIRM"],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        requests.push({ path, method, body });
        if (path.endsWith("/current-lot/prepare"))
          return response({
            version: 1,
            requestId: body.requestId,
            operation: "PREPARE_CURRENT_LOT",
            outcome: "CURRENT_LOT_READY",
            revision: 7,
          });
        if (path.endsWith("/current-lot")) return response(lot);
        if (method === "GET") return response(current);
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() => expect(h.result.current.view).not.toBeNull());

    await act(async () => {
      await h.result.current.reviewCurrentLot();
    });

    expect(requests.map(({ path, method }) => `${method} ${path}`)).toContain(
      "POST /import-sessions/session-a/current-lot/prepare",
    );
    const prepareIndex = requests.findIndex(({ path }) =>
      path.endsWith("/current-lot/prepare"),
    );
    expect(requests[prepareIndex + 1].path).toBe("/import-sessions/session-a");
    expect(requests[prepareIndex + 2].path).toBe(
      "/import-sessions/session-a/current-lot",
    );
    expect(h.result.current.currentLot).toEqual(lot);
    expect(requests.some(({ path }) => path === "/agent/chat")).toBe(false);
  });
});
