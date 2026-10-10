import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImportCurrentLotV1 } from "@reformaflow/domain";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appliedFixture } from "../_lib/import-workflow-fixtures";
import { useImportExecution } from "./useImportExecution";

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: "actor-a" } }),
}));

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const CONFIRMATION_HASH = "c".repeat(64);

function publicReceipt(financialRequestId: string) {
  const receipt = structuredClone(appliedFixture(financialRequestId).receipt);
  if (!receipt) throw new Error("Fixture must carry a receipt");
  const publicValue = receipt as unknown as Record<string, unknown>;
  delete publicValue.proposalHash;
  publicValue.bindingVersion = 1;
  publicValue.confirmationHash = CONFIRMATION_HASH;
  return publicValue;
}

const lot: ImportCurrentLotV1 = {
  version: 1,
  state: "READY",
  revision: 7,
  confirmationHash: CONFIRMATION_HASH,
  purchases: [],
  createdEconomicTotalCents: 0,
  bankCashDeltaCents: 0,
  invoiceDeltas: [],
  hasRemainingWork: false,
  actions: ["CONFIRM"],
};

describe("useImportExecution current-lot authority", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  it("uses the confirmation response request id to execute after one explicit confirmation", async () => {
    const calls: Array<{
      path: string;
      method: string;
      body: Record<string, unknown> | null;
    }> = [];
    let financialRequestId = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        calls.push({ path, method, body });
        if (path.endsWith("/current-lot")) return response(lot);
        if (path.endsWith("/confirmation-challenge"))
          return response({
            nonce: "nonce-a",
            expiresAt: "2026-10-09T16:00:00.000Z",
          });
        if (path.endsWith("/confirm")) {
          financialRequestId = String(body?.financialRequestId);
          return response({
            sessionId: "session-a",
            financialRequestId,
            state: "CONFIRMED",
          });
        }
        if (path.endsWith("/execute")) return response({});
        if (path.endsWith("/result"))
          return response({
            state: "APPLIED",
            receipt: publicReceipt(financialRequestId),
          });
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const h = renderHook(() => useImportExecution("session-a", lot), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() =>
      expect(h.result.current.financialAction).toBe("CONFIRM"),
    );

    await act(async () => {
      await h.result.current.act();
    });

    const confirm = calls.find(({ path }) => path.endsWith("/confirm"));
    const challenge = calls.find(({ path }) =>
      path.endsWith("/confirmation-challenge"),
    );
    const execute = calls.find(({ path }) => path.endsWith("/execute"));
    expect(challenge).toStrictEqual({
      path: "/import-sessions/session-a/confirmation-challenge",
      method: "POST",
      body: {
        expectedRevision: 7,
        confirmationHash: CONFIRMATION_HASH,
      },
    });
    expect(confirm?.body).toStrictEqual({
      expectedRevision: 7,
      confirmationHash: CONFIRMATION_HASH,
      financialRequestId: expect.any(String),
      nonce: "nonce-a",
    });
    expect(confirm?.body?.financialRequestId).toEqual(expect.any(String));
    expect(execute?.body).toStrictEqual({
      financialRequestId: confirm?.body?.financialRequestId,
    });
    expect(h.result.current.notice).toBe("Compras deste lote adicionadas.");
  });
});
