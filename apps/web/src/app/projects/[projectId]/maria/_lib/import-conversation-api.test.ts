import { afterEach, expect, it, vi } from "vitest";
import type { ImportChatTurnV1 } from "@reformaflow/domain";
import { ApiResponseError } from "@/lib/api";
import { sendImportChat } from "./import-session-api";
import { ImportConversationHttpError } from "./import-conversation-read";
import { WORKFLOW_REQUEST_ID } from "./import-workflow-fixtures";

const turn: ImportChatTurnV1 = {
  version: 1,
  turnId: WORKFLOW_REQUEST_ID,
  sessionId: "session-a",
  expectedRevision: 7,
  channel: "VOICE",
  literalAnswer: "  sim  ",
  intent: "OPEN_REVIEW",
  focus: null,
  scope: null,
};
const outcome = {
  version: 1,
  turnId: turn.turnId,
  ref: { sessionId: "session-a", revision: 7 },
  kind: "OPEN_REVIEW",
  acknowledgment: "NONE",
};
afterEach(() => vi.unstubAllGlobals());

it("sends only the literal current message, UI header and cookie, never project/history/authority", async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        importOutcome: outcome,
        reply: "Já lancei!",
        toolsUsed: ["create_expense"],
      }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await sendImportChat(turn)).toEqual(outcome);
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe("http://localhost:3001/agent/chat");
  expect(options.credentials).toBe("include");
  expect(options.headers["x-rf-import-ui"]).toBe("1");
  expect(JSON.parse(options.body)).toEqual({
    messages: [{ role: "user", content: "  sim  " }],
    importTurn: turn,
  });
});

it.each([
  null,
  {},
  { reply: "Já lancei!" },
  { importOutcome: { ...outcome, authority: true } },
])("fails explicitly on untrusted 2xx %j", async (body) => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetch);
  await expect(sendImportChat(turn)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([403, 404, 409, 429, 500, 503])(
  "preserves standard pre-handler HTTP %s without an outcome or retry",
  async (status) => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "RAW_PRIVATE_ERROR" }), {
        status,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(sendImportChat(turn)).rejects.toBeInstanceOf(ApiResponseError);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("preserves admitted error status; 2xx ERROR and opaque errors with references are malformed", async () => {
  const error = {
    ...outcome,
    kind: "ERROR",
    code: "INTERNAL_ERROR",
    reason: null,
    acknowledgment: "UNKNOWN",
    retryable: true,
    recovery: "READ_SESSION",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ importOutcome: error }), {
          status: 500,
        }),
      ),
    ),
  );
  await expect(sendImportChat(turn)).rejects.toMatchObject({
    status: 500,
    outcome: error,
  });
  await expect(sendImportChat(turn)).rejects.toBeInstanceOf(
    ImportConversationHttpError,
  );
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ importOutcome: error })),
      ),
  );
  await expect(sendImportChat(turn)).rejects.toThrow();
});
