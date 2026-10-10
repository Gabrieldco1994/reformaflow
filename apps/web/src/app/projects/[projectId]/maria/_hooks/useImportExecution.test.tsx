import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImportCurrentLotV1 } from "@reformaflow/domain";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appliedFixture } from "../_lib/import-workflow-fixtures";
import { useImportExecution } from "./useImportExecution";

const auth = vi.hoisted(() => ({
  user: { id: "actor-a" } as { id: string } | null,
}));
vi.mock("@/contexts/auth-context", () => ({ useAuth: () => auth }));

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const CONFIRMATION_HASH = "c".repeat(64);
const FINANCIAL_REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function currentLotFixture(
  actions: ImportCurrentLotV1["actions"] = ["CONFIRM"],
): ImportCurrentLotV1 {
  return {
    version: 1,
    state: actions.includes("EXECUTE") ? "CONFIRMED" : "READY_WITH_PENDING",
    revision: 7,
    confirmationHash: CONFIRMATION_HASH,
    purchases: [],
    createdEconomicTotalCents: 0,
    bankCashDeltaCents: 0,
    invoiceDeltas: [],
    hasRemainingWork: !actions.includes("EXECUTE"),
    actions,
  };
}

function publicReceipt(financialRequestId: string) {
  const receipt = structuredClone(appliedFixture(financialRequestId).receipt);
  if (!receipt) throw new Error("Fixture must carry a receipt");
  const publicValue = receipt as unknown as Record<string, unknown>;
  delete publicValue.proposalHash;
  publicValue.bindingVersion = 1;
  publicValue.confirmationHash = CONFIRMATION_HASH;
  return publicValue;
}

describe("useImportExecution current-lot authority", () => {
  let client: QueryClient;
  let lot: ImportCurrentLotV1;
  let requests: Array<{
    path: string;
    method: string;
    body: Record<string, unknown> | null;
  }>;
  let fetchStub: ReturnType<typeof vi.fn>;
  let confirmedFinancialRequestId: string;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T15:00:00.000Z"));
    auth.user = { id: "actor-a" };
    window.sessionStorage.clear();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    lot = currentLotFixture();
    requests = [];
    confirmedFinancialRequestId = "";
    fetchStub = vi.fn(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : null;
      requests.push({ path, method, body });
      if (path.endsWith("/current-lot")) return response(lot);
      if (path.endsWith("/confirmation-challenge"))
        return response({
          nonce: "nonce-a",
          expiresAt: "2026-10-09T15:05:00.000Z",
        });
      if (path.endsWith("/confirm")) {
        confirmedFinancialRequestId = String(body?.financialRequestId);
        return response({
          sessionId: "session-a",
          financialRequestId: confirmedFinancialRequestId,
          state: "CONFIRMED",
        });
      }
      if (path.endsWith("/execute")) return response({});
      if (path.endsWith("/result"))
        return response({
          state: "APPLIED",
          receipt: publicReceipt(
            confirmedFinancialRequestId || FINANCIAL_REQUEST_ID,
          ),
        });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(() => {
    client.clear();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function mount(initialLot: ImportCurrentLotV1 | null = lot) {
    return renderHook(({ id, initial }) => useImportExecution(id, initial), {
      initialProps: { id: "session-a", initial: initialLot },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
  }

  it("keeps execution unavailable until a ready-only lot is explicitly supplied", () => {
    const h = mount(null);
    expect(h.result.current.lot).toBeNull();
    expect(h.result.current.financialAction).toBeNull();
    expect(requests).toEqual([]);
  });

  it("rereads authority, challenges, confirms, executes, and reads the result", async () => {
    vi.useRealTimers();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(FINANCIAL_REQUEST_ID);
    const h = mount();
    expect(h.result.current.financialAction).toBe("CONFIRM");

    await act(async () => h.result.current.act());

    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /import-sessions/session-a/current-lot",
      "POST /import-sessions/session-a/confirmation-challenge",
      "POST /import-sessions/session-a/confirm",
      "POST /import-sessions/session-a/execute",
      "GET /import-sessions/session-a/result",
    ]);
    expect(requests[1].body).toStrictEqual({
      expectedRevision: 7,
      confirmationHash: CONFIRMATION_HASH,
    });
    expect(requests[2].body).toStrictEqual({
      expectedRevision: 7,
      confirmationHash: CONFIRMATION_HASH,
      financialRequestId: FINANCIAL_REQUEST_ID,
      nonce: "nonce-a",
    });
    expect(requests[3].body).toStrictEqual({
      financialRequestId: FINANCIAL_REQUEST_ID,
    });
    expect(h.result.current.notice).toBe("Compras deste lote adicionadas.");
    expect(h.result.current.result?.state).toBe("APPLIED");
    expect(h.result.current.lot).toBeNull();
    expect(h.result.current.financialAction).toBeNull();
    expect(
      window.sessionStorage.getItem(
        "rf:import-financial-request:actor-a:session-a",
      ),
    ).toBeNull();
  });

  it.each([
    ["revision", 8],
    ["confirmationHash", "b".repeat(64)],
  ] as const)(
    "refuses a changed %s before any financial write",
    async (key, value) => {
      vi.useRealTimers();
      const initial = currentLotFixture();
      lot = { ...initial, [key]: value };
      const h = mount(initial);

      await act(async () => h.result.current.act());

      expect(requests).toHaveLength(1);
      expect(requests[0].path).toBe("/import-sessions/session-a/current-lot");
      expect(h.result.current.notice).toBe(
        "A revisão mudou. Confira as compras atuais antes de continuar.",
      );
      expect(h.result.current.lot?.[key]).toBe(value);
    },
  );

  it("refuses confirmation when the fresh lot no longer authorizes it", async () => {
    vi.useRealTimers();
    const initial = currentLotFixture();
    lot = currentLotFixture(["EXECUTE"]);
    const h = mount(initial);
    await act(async () => h.result.current.act());
    expect(requests).toHaveLength(1);
    expect(h.result.current.financialAction).toBeNull();
  });

  it("resumes EXECUTE only with the retained financial request id", async () => {
    vi.useRealTimers();
    window.sessionStorage.setItem(
      "rf:import-financial-request:actor-a:session-a",
      FINANCIAL_REQUEST_ID,
    );
    lot = currentLotFixture(["EXECUTE"]);
    const h = mount();
    expect(h.result.current.financialAction).toBe("EXECUTE");

    await act(async () => h.result.current.act());

    expect(
      requests.filter(({ path }) =>
        /confirmation-challenge|\/confirm$/.test(path),
      ),
    ).toEqual([]);
    expect(
      requests.find(({ path }) => path.endsWith("/execute"))?.body,
    ).toStrictEqual({
      financialRequestId: FINANCIAL_REQUEST_ID,
    });
    expect(h.result.current.notice).toBe("Compras deste lote adicionadas.");
  });

  it("does not synthesize EXECUTE without a retained request id", () => {
    lot = currentLotFixture(["EXECUTE"]);
    const h = mount();
    expect(h.result.current.financialAction).toBeNull();
  });

  it("recovers an applied result after the execute response is lost without posting execute again", async () => {
    vi.useRealTimers();
    window.sessionStorage.setItem(
      "rf:import-financial-request:actor-a:session-a",
      FINANCIAL_REQUEST_ID,
    );
    lot = currentLotFixture(["EXECUTE"]);
    let applied = false;
    fetchStub.mockImplementation(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : null;
      requests.push({ path, method, body });
      if (path.endsWith("/result"))
        return response(
          applied
            ? {
                state: "APPLIED",
                receipt: publicReceipt(FINANCIAL_REQUEST_ID),
              }
            : { state: "CONFIRMED", receipt: null },
        );
      if (path.endsWith("/current-lot")) {
        if (applied)
          return response(
            {
              code: "ALREADY_APPLIED",
              retryable: false,
              sessionId: "session-a",
              currentRevision: 7,
              reason: null,
            },
            409,
          );
        return response(lot);
      }
      if (path.endsWith("/execute")) {
        applied = true;
        throw new TypeError("execute response lost");
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const h = mount();

    await act(async () => h.result.current.act());
    expect(h.result.current.error).not.toBeNull();
    expect(
      requests.filter(({ path }) => path.endsWith("/execute")),
    ).toHaveLength(1);

    await act(async () => h.result.current.retry());

    expect(requests.slice(-1).map(({ path }) => path)).toEqual([
      "/import-sessions/session-a/result",
    ]);
    expect(
      requests.filter(({ path }) => path.endsWith("/execute")),
    ).toHaveLength(1);
    expect(h.result.current.result?.state).toBe("APPLIED");
    expect(h.result.current.lot).toBeNull();
    expect(h.result.current.financialAction).toBeNull();
    expect(h.result.current.error).toBeNull();
    expect(h.result.current.notice).toBe("Compras deste lote adicionadas.");
    expect(window.sessionStorage.length).toBe(0);
  });

  it.each([
    ["READY", currentLotFixture(), "CONFIRM"],
    ["CONFIRMED", currentLotFixture(["EXECUTE"]), "EXECUTE"],
  ] as const)(
    "rereads the current lot after result recovery reports %s",
    async (state, recoveredLot, action) => {
      vi.useRealTimers();
      if (state === "CONFIRMED")
        window.sessionStorage.setItem(
          "rf:import-financial-request:actor-a:session-a",
          FINANCIAL_REQUEST_ID,
        );
      lot = recoveredLot;
      fetchStub.mockImplementation(
        async (url: string, options?: RequestInit) => {
          const path = new URL(url).pathname;
          const method = options?.method ?? "GET";
          requests.push({ path, method, body: null });
          if (path.endsWith("/result"))
            return response({ state, receipt: null });
          if (path.endsWith("/current-lot")) return response(recoveredLot);
          throw new Error(`Unexpected request: ${method} ${path}`);
        },
      );
      const h = mount(recoveredLot);

      await act(async () => h.result.current.retry());

      expect(requests.map(({ path }) => path)).toEqual([
        "/import-sessions/session-a/result",
        "/import-sessions/session-a/current-lot",
      ]);
      expect(h.result.current.result?.state).toBe(state);
      expect(h.result.current.lot).toEqual(recoveredLot);
      expect(h.result.current.financialAction).toBe(action);
      expect(h.result.current.error).toBeNull();
    },
  );

  it("surfaces a typed result recovery failure without falling through to current-lot", async () => {
    vi.useRealTimers();
    fetchStub.mockImplementation(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      requests.push({ path, method: options?.method ?? "GET", body: null });
      return response(
        {
          code: "CAPABILITY_DISABLED",
          retryable: true,
          sessionId: null,
          currentRevision: null,
          reason: null,
        },
        503,
      );
    });
    const h = mount();

    await act(async () => h.result.current.retry());

    expect(requests.map(({ path }) => path)).toEqual([
      "/import-sessions/session-a/result",
    ]);
    expect(h.result.current.error).toBe(
      "A importação pela Maria está indisponível no momento. Suas importações continuam guardadas.",
    );
    expect(h.result.current.financialAction).toBeNull();
  });

  it("recovers a lost confirm response with only the retained request id", async () => {
    vi.useRealTimers();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(FINANCIAL_REQUEST_ID);
    fetchStub.mockImplementation(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : null;
      requests.push({ path, method, body });
      if (path.endsWith("/current-lot")) return response(lot);
      if (path.endsWith("/confirmation-challenge"))
        return response({
          nonce: "nonce-a",
          expiresAt: "2026-10-09T15:05:00.000Z",
        });
      if (path.endsWith("/confirm")) throw new TypeError("response lost");
      if (path.endsWith("/execute")) return response({});
      if (path.endsWith("/result"))
        return response({
          state: "APPLIED",
          receipt: publicReceipt(FINANCIAL_REQUEST_ID),
        });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const first = mount();

    await act(async () => first.result.current.act());

    expect(
      Object.fromEntries(
        Array.from({ length: window.sessionStorage.length }, (_, index) => {
          const key = window.sessionStorage.key(index);
          if (key === null) throw new Error("Missing storage key");
          return [key, window.sessionStorage.getItem(key)];
        }),
      ),
    ).toStrictEqual({
      "rf:import-financial-request:actor-a:session-a": FINANCIAL_REQUEST_ID,
    });

    first.unmount();
    lot = currentLotFixture(["EXECUTE"]);
    const recovered = mount(lot);
    expect(recovered.result.current.financialAction).toBe("EXECUTE");

    await act(async () => recovered.result.current.act());

    expect(
      requests.filter(({ path }) =>
        /confirmation-challenge|\/confirm$/.test(path),
      ),
    ).toStrictEqual([
      {
        path: "/import-sessions/session-a/confirmation-challenge",
        method: "POST",
        body: {
          expectedRevision: 7,
          confirmationHash: CONFIRMATION_HASH,
        },
      },
      {
        path: "/import-sessions/session-a/confirm",
        method: "POST",
        body: {
          expectedRevision: 7,
          confirmationHash: CONFIRMATION_HASH,
          financialRequestId: FINANCIAL_REQUEST_ID,
          nonce: "nonce-a",
        },
      },
    ]);
    expect(requests.filter(({ path }) => path.endsWith("/execute"))).toEqual([
      {
        path: "/import-sessions/session-a/execute",
        method: "POST",
        body: { financialRequestId: FINANCIAL_REQUEST_ID },
      },
    ]);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("surfaces a failed authoritative reread and performs no write", async () => {
    vi.useRealTimers();
    fetchStub.mockResolvedValueOnce(
      response({ message: "temporariamente indisponível" }, 503),
    );
    const h = mount();
    await act(async () => h.result.current.act());

    expect(requests).toHaveLength(0);
    expect(h.result.current.error).toEqual(expect.any(String));
    expect(h.result.current.notice).toEqual(expect.any(String));
    expect(h.result.current.financialAction).toBeNull();
  });

  it("settles same-tick duplicate actions as one financial sequence", async () => {
    vi.useRealTimers();
    const challenge = deferred<Response>();
    fetchStub.mockImplementationOnce(
      async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        requests.push({ path, method: options?.method ?? "GET", body: null });
        return response(lot);
      },
    );
    fetchStub.mockImplementationOnce(() => challenge.promise);
    const h = mount();

    let first!: Promise<void>;
    act(() => {
      first = h.result.current.act();
      void h.result.current.act();
    });
    challenge.resolve(
      response({
        nonce: "nonce-a",
        expiresAt: "2026-10-09T15:05:00.000Z",
      }),
    );
    await act(async () => first);

    expect(
      fetchStub.mock.calls.filter(([url]) =>
        String(url).endsWith("/confirmation-challenge"),
      ),
    ).toHaveLength(1);
    expect(
      fetchStub.mock.calls.filter(([url]) => String(url).endsWith("/execute")),
    ).toHaveLength(1);
  });

  it("drops a delayed completion after the actor changes", async () => {
    vi.useRealTimers();
    const gate = deferred<Response>();
    fetchStub.mockImplementationOnce(() => gate.promise);
    const h = mount();
    let action!: Promise<void>;
    act(() => {
      action = h.result.current.act();
    });

    auth.user = { id: "actor-b" };
    h.rerender({ id: "session-b", initial: currentLotFixture() });
    gate.resolve(response(lot));
    await act(async () => action);

    expect(h.result.current.notice).toBeNull();
    expect(h.result.current.error).toBeNull();
    expect(
      fetchStub.mock.calls
        .filter(([, options]) => options?.method === "POST")
        .map(([url]) => new URL(String(url)).pathname),
    ).toEqual([]);
  });

  it("retry accepts the authoritative applied result without rereading current-lot", async () => {
    vi.useRealTimers();
    const initial = currentLotFixture();
    lot = { ...currentLotFixture(["EXECUTE"]), revision: 8 };
    const h = mount(initial);
    await act(async () => h.result.current.retry());

    expect(requests.map(({ path }) => path)).toEqual([
      "/import-sessions/session-a/result",
    ]);
    expect(h.result.current.result?.state).toBe("APPLIED");
    expect(h.result.current.lot).toBeNull();
    expect(h.result.current.financialAction).toBeNull();
  });
});
