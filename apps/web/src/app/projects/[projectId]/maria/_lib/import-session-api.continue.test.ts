import type { ContinueAnsweringCommandV1 } from "@reformaflow/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    post: (...args: unknown[]) => post(...args),
  },
}));

import { continueImportAnswering } from "./import-session-api";

const request: ContinueAnsweringCommandV1 = {
  version: 1,
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  expectedRevision: 8,
};

const receipt = {
  version: 1,
  requestId: request.requestId,
  operation: "CONTINUE_ANSWERING",
  outcome: "NEEDS_INPUT",
  revision: 9,
} as const;

describe("continue answering API contract", () => {
  beforeEach(() => post.mockReset());

  it("posts the typed CAS command with a fresh UI grant request", async () => {
    post.mockResolvedValue(receipt);

    await expect(
      continueImportAnswering("session/a", request),
    ).resolves.toEqual(receipt);
    expect(post).toHaveBeenCalledWith(
      "/import-sessions/session%2Fa/current-lot/continue",
      request,
      { headers: { "x-rf-import-ui": "1" } },
    );
  });

  it.each([
    ["wrong request", { ...receipt, requestId: crypto.randomUUID() }],
    ["wrong operation", { ...receipt, operation: "PREPARE_CURRENT_LOT" }],
    ["stale revision shape", { ...receipt, revision: -1 }],
    ["wrong successful outcome", { ...receipt, outcome: "APPLIED" }],
    ["unknown outcome", { ...receipt, outcome: "CONTINUED" }],
    ["extra private member", { ...receipt, lineIds: ["private-line"] }],
  ])("rejects a strict %s receipt", async (_name, malformed) => {
    post.mockResolvedValue(malformed);

    await expect(continueImportAnswering("session-a", request)).rejects.toThrow(
      "Unexpected import command response",
    );
  });
});
