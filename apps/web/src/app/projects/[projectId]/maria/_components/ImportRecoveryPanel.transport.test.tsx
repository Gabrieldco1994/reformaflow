import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ImportSessionErrorV1,
  ImportSessionResultV1,
} from "@reformaflow/domain";
import { summaryFixture, viewFixture } from "../_lib/import-session-fixtures";
import { ImportRecoveryPanel } from "./ImportRecoveryPanel";

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: "user-a" } }),
}));

// Only fetch is replaced: the shared API helper, wire readers and recovery hooks all run.
const fetchMock = vi.fn<typeof fetch>();
const detailResponse = vi.fn<() => Response>();
const cancelResponse = vi.fn<() => Response>();
const resultResponse = vi.fn<() => Response>();
const draft = viewFixture({ searchComplete: false });
const cancelled = viewFixture({
  state: "CANCELLED",
  revision: 4,
  expiresAt: null,
  searchComplete: false,
  attachments: [],
  actions: [],
});
const activePage = {
  items: [summaryFixture()],
  nextCursor: null,
  entry: { version: 1, kind: "UNAVAILABLE", reason: "NOT_ENABLED" },
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  detailResponse.mockReset().mockImplementation(() => reply(draft));
  cancelResponse.mockReset().mockImplementation(() => reply(cancelled));
  resultResponse.mockReset();
  fetchMock.mockImplementation(async (input, options) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const method = options?.method ?? "GET";
    if (method === "GET" && url.pathname === "/import-sessions")
      return reply(activePage);
    if (method === "GET" && url.pathname === "/import-sessions/sess-1")
      return detailResponse();
    if (method === "POST" && url.pathname === "/import-sessions/sess-1/cancel")
      return cancelResponse();
    if (method === "GET" && url.pathname === "/import-sessions/sess-1/result")
      return resultResponse();
    if (
      method === "GET" &&
      ["/tenant/credit-cards", "/projects"].includes(url.pathname)
    )
      return reply([]);
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  });
});

afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
});

function renderPanel() {
  render(
    <QueryClientProvider client={client}>
      <ImportRecoveryPanel />
    </QueryClientProvider>,
  );
}

async function requestCancel() {
  renderPanel();
  fireEvent.click(await screen.findByTestId("import-session-row"));
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancelar importação" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Sim, cancelar" }));
}

describe("composed recovery HTTP contract", () => {
  it("sends the current revision once with cookie credentials and the UI header, then reads the cancelled projection", async () => {
    detailResponse
      .mockImplementationOnce(() => reply(draft))
      .mockImplementation(() => reply(cancelled));

    await requestCancel();

    expect(
      await screen.findByText("Importação cancelada."),
    ).toBeInTheDocument();
    await waitFor(() => expect(detailResponse).toHaveBeenCalledTimes(2));
    expect(cancelResponse).toHaveBeenCalledTimes(1);
    const writes = fetchMock.mock.calls.filter(
      ([, options]) => options?.method === "POST",
    );
    expect(writes).toEqual([
      [
        expect.stringMatching(/\/import-sessions\/sess-1\/cancel$/),
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          body: JSON.stringify({ expectedRevision: 3 }),
          headers: {
            "Content-Type": "application/json",
            "x-rf-import-ui": "1",
          },
        }),
      ],
    ]);
    expect(
      screen.queryByRole("button", { name: "Cancelar importação" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /analisar|anexar|responder|confirmar lote/i,
      }),
    ).toBeNull();
  });

  it("uses the persisted-result endpoint after ALREADY_APPLIED and never retries the financial operation", async () => {
    const conflict: ImportSessionErrorV1 = {
      code: "ALREADY_APPLIED",
      retryable: false,
      sessionId: draft.id,
      currentRevision: 4,
      reason: null,
    };
    const notFound: ImportSessionErrorV1 = {
      code: "NOT_FOUND",
      retryable: false,
      sessionId: null,
      currentRevision: null,
      reason: null,
    };
    cancelResponse.mockImplementation(() => reply(conflict, 409));
    resultResponse.mockImplementation(() => reply(notFound, 404));

    await requestCancel();

    await waitFor(() => expect(resultResponse).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(cancelResponse).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("import-receipt")).toBeNull();
    expect(screen.queryByText("Importação cancelada.")).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(1);
  });

  it("preserves the result-without-receipt shape instead of manufacturing a full session", async () => {
    const result: ImportSessionResultV1 = {
      state: "CANCELLED",
      receipt: null,
    };
    resultResponse.mockImplementation(() => reply(result));
    const { getImportResult } = await import("../_lib/import-session-api");

    await expect(getImportResult("sess-1")).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/import-sessions\/sess-1\/result$/),
      expect.objectContaining({ credentials: "include" }),
    );
    expect(cancelResponse).not.toHaveBeenCalled();
  });
});
