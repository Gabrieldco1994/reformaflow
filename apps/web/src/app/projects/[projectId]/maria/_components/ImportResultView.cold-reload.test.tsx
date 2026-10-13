import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImportResultView } from "./ImportResultView";

const SOURCE_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const CONTINUATION_SESSION_ID = "550e8400-e29b-41d4-a716-446655440001";
const OTHER_SESSION_ID = "550e8400-e29b-41d4-a716-446655440002";

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function summary(
  id: string,
  continuationSessionId: string | null,
  createdAt: string,
) {
  return {
    id,
    state: "APPLIED",
    revision: 4,
    cardId: "550e8400-e29b-41d4-a716-446655440003",
    ownerProjectId: "550e8400-e29b-41d4-a716-446655440004",
    createdAt,
    expiresAt: null,
    appliedAt: "2026-10-13T20:00:00.000Z",
    attachmentCount: 1,
    hasConfirmation: true,
    continuationSessionId,
    actions: ["READ_RESULT"],
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reconstructs and opens the remaining draft from persisted pages after a cold result reload", async () => {
  const requestedUrls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      requestedUrls.push(url);

      if (url.endsWith(`/import-sessions/${SOURCE_SESSION_ID}/result`)) {
        return json({
          state: "APPLIED",
          receipt: {
            appliedAt: "2026-10-13T20:00:00.000Z",
            continuationSessionId: null,
            items: [],
            snapshot: {
              lines: [],
              createdEconomicTotalCents: 12_345,
              bankCashDeltaCents: 0,
              invoiceDeltas: [],
            },
          },
        });
      }
      if (url.endsWith("/import-sessions?state=applied")) {
        return json({
          items: [summary(OTHER_SESSION_ID, null, "2026-10-13T21:00:00.000Z")],
          nextCursor: "older-applied",
          entry: { kind: "CARD_INVOICE", formats: ["CSV"] },
        });
      }
      if (url.endsWith("/import-sessions?state=applied&cursor=older-applied")) {
        return json({
          items: [
            summary(
              SOURCE_SESSION_ID,
              CONTINUATION_SESSION_ID,
              "2026-10-13T19:00:00.000Z",
            ),
          ],
          nextCursor: null,
          entry: { kind: "CARD_INVOICE", formats: ["CSV"] },
        });
      }
      if (url.endsWith("/tenant/credit-cards") || url.endsWith("/projects"))
        return json([]);
      return new Response(null, { status: 404 });
    }),
  );
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const onOpenSession = vi.fn();

  render(
    <QueryClientProvider client={client}>
      <ImportResultView
        userId="user-1"
        sessionId={SOURCE_SESSION_ID}
        onOpenSession={onOpenSession}
      />
    </QueryClientProvider>,
  );

  const continuation = await screen.findByRole("button", {
    name: "Ver rascunho restante",
  });
  expect(requestedUrls).toContainEqual(
    expect.stringContaining("/import-sessions?state=applied"),
  );
  expect(requestedUrls).toContainEqual(
    expect.stringContaining(
      "/import-sessions?state=applied&cursor=older-applied",
    ),
  );
  fireEvent.click(continuation);
  await waitFor(() =>
    expect(onOpenSession).toHaveBeenCalledWith(CONTINUATION_SESSION_ID),
  );
});
