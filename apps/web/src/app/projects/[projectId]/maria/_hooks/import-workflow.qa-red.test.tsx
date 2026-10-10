import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appliedFixture,
  currentLotFixture,
} from "../_lib/import-workflow-fixtures";
import { useImportExecution } from "./useImportExecution";

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: "actor-a" } }),
}));

const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

describe("independent QA current-lot regressions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  function mount() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const lot = currentLotFixture();
    const hook = renderHook(() => useImportExecution("session-a", lot), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    return { hook, client, lot };
  }

  it("never publishes an incomplete applied receipt as success", async () => {
    const receipt = appliedFixture().receipt;
    if (!receipt) throw new Error("Missing applied receipt fixture");
    Reflect.deleteProperty(receipt.items[0], "outcome");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/current-lot")) return response(currentLotFixture());
        if (path.endsWith("/confirmation-challenge"))
          return response({
            nonce: "nonce-a",
            expiresAt: "2026-10-09T16:00:00.000Z",
          });
        if (path.endsWith("/confirm")) {
          const body = JSON.parse(String(options?.body));
          return response({
            sessionId: "session-a",
            financialRequestId: body.financialRequestId,
            state: "CONFIRMED",
          });
        }
        if (path.endsWith("/execute")) return response({});
        if (path.endsWith("/result"))
          return response({ state: "APPLIED", receipt });
        throw new Error(`Unexpected ${path}`);
      }),
    );
    const { hook, client } = mount();
    await act(async () => hook.result.current.act());
    expect(hook.result.current.notice).not.toBe(
      "Compras deste lote adicionadas.",
    );
    expect(hook.result.current.error).not.toBeNull();
    client.clear();
  });

  it("does not write when the authoritative lot changes after display", async () => {
    const writes: string[] = [];
    const changed = { ...currentLotFixture(), revision: 8 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        if (options?.method === "POST") writes.push(path);
        return response(changed);
      }),
    );
    const { hook, client } = mount();
    await act(async () => hook.result.current.act());
    expect(writes).toEqual([]);
    expect(hook.result.current.lot?.revision).toBe(8);
    expect(hook.result.current.notice).not.toBeNull();
    client.clear();
  });

  it("does not offer confirmation for a server lot with no authorized action", () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new QueryClient();
    const hook = renderHook(
      () => useImportExecution("session-a", currentLotFixture([])),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    expect(hook.result.current.financialAction).toBeNull();
    client.clear();
  });
});
