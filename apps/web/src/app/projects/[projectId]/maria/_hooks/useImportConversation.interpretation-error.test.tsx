import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { declarationViewFixture } from "../_lib/import-workflow-fixtures";
import { useImportConversation } from "./useImportConversation";

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: "actor-a" } }),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("guided interpretation attempt identity", () => {
  let client: QueryClient;
  let requests: Array<{
    path: string;
    method: string;
    body: Record<string, unknown> | null;
  }>;

  beforeEach(() => {
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

  it.each([
    [503, "PROVIDER_UNAVAILABLE"],
    [502, "MODEL_OUTPUT_INVALID"],
  ] as const)(
    "uses a new request id after terminal HTTP %s %s",
    async (status, code) => {
      let interpretations = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, options?: RequestInit) => {
          const path = new URL(url).pathname;
          const method = options?.method ?? "GET";
          const body = options?.body
            ? (JSON.parse(String(options.body)) as Record<string, unknown>)
            : null;
          requests.push({ path, method, body });
          if (method === "GET") return json(declarationViewFixture());
          if (path.endsWith("/interpretations")) {
            interpretations++;
            if (interpretations === 1)
              return json(
                {
                  version: 1,
                  requestId: body?.requestId,
                  code,
                },
                status,
              );
            return json({
              version: 1,
              requestId: body?.requestId,
              outcome: "CLARIFY",
            });
          }
          throw new Error(`Unexpected request: ${method} ${path}`);
        }),
      );
      const h = mount();
      await waitFor(() => expect(h.result.current.question).not.toBeNull());

      await act(async () => {
        await expect(
          h.result.current.interpretAnswer("cem reais"),
        ).rejects.toMatchObject({ status });
      });
      await act(async () => {
        await h.result.current.interpretAnswer("cem reais");
      });

      const commands = requests.filter(({ path }) =>
        path.endsWith("/interpretations"),
      );
      expect(commands).toHaveLength(2);
      expect(commands[1].body?.requestId).not.toBe(commands[0].body?.requestId);
      expect(
        requests
          .filter(({ method }) => method !== "GET")
          .map(({ path }) => path),
      ).toEqual([
        "/import-sessions/session-a/interpretations",
        "/import-sessions/session-a/interpretations",
      ]);
      expect(
        requests.some(
          ({ path }) =>
            path === "/agent/chat" ||
            /\/(declarations|resolutions|defer|reactivate|current-lot|confirm|execute)$/.test(
              path,
            ),
        ),
      ).toBe(false);
    },
  );

  it.each([
    {
      name: "a truncated 503 body",
      first: () =>
        new Response("gateway unavailable", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        }),
    },
    {
      name: "an offline network failure",
      first: () => Promise.reject(new TypeError("connection reset")),
    },
    {
      name: "a typed lease conflict",
      first: () =>
        json(
          {
            code: "LEASE_CONFLICT",
            retryable: true,
            sessionId: "session-a",
            currentRevision: 7,
            reason: null,
          },
          409,
        ),
    },
  ])("retains the same request id after $name", async ({ first }) => {
    let interpretations = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return json(declarationViewFixture());
        if (path.endsWith("/interpretations")) {
          interpretations++;
          if (interpretations === 1) return first();
          return json({
            version: 1,
            requestId: body?.requestId,
            outcome: "CLARIFY",
          });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() => expect(h.result.current.question).not.toBeNull());

    await act(async () => {
      await expect(
        h.result.current.interpretAnswer("cem reais"),
      ).rejects.toBeInstanceOf(Error);
    });
    await act(async () => {
      await h.result.current.interpretAnswer("cem reais");
    });

    const commands = requests.filter(({ path }) =>
      path.endsWith("/interpretations"),
    );
    expect(commands).toHaveLength(2);
    expect(commands[1].body).toEqual(commands[0].body);
  });

  it("discards a successful clarification attempt id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return json(declarationViewFixture());
        if (path.endsWith("/interpretations"))
          return json({
            version: 1,
            requestId: body?.requestId,
            outcome: "CLARIFY",
          });
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const h = mount();
    await waitFor(() => expect(h.result.current.question).not.toBeNull());

    await act(async () => {
      await h.result.current.interpretAnswer("cem reais");
      await h.result.current.interpretAnswer("cem reais");
    });

    const commands = requests.filter(({ path }) =>
      path.endsWith("/interpretations"),
    );
    expect(commands[1].body?.requestId).not.toBe(commands[0].body?.requestId);
  });
});
