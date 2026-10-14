import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { ImportSessionController } from "./import-session.controller";
import type { AuthenticatedImportContext } from "./import-session.contract";
import {
  IMPORT_SESSION_TERMINAL_OUTCOMES_QUERY,
  IMPORT_SESSION_TERMINAL_OUTCOMES_VERSION,
  ImportSessionService,
  parseSessionProjectionQuery,
} from "./import-session.service";

const terminalOutcomeProjection = {
  [IMPORT_SESSION_TERMINAL_OUTCOMES_QUERY]:
    IMPORT_SESSION_TERMINAL_OUTCOMES_VERSION,
} as const;

describe("GET import-session terminal outcome projection", () => {
  it("keeps the legacy projection by default and opts in only to v1", () => {
    expect(parseSessionProjectionQuery({})).toEqual({
      includeTerminalOutcomes: false,
    });
    expect(parseSessionProjectionQuery(terminalOutcomeProjection)).toEqual({
      includeTerminalOutcomes: true,
    });
  });

  it.each([
    { [IMPORT_SESSION_TERMINAL_OUTCOMES_QUERY]: "" },
    { [IMPORT_SESSION_TERMINAL_OUTCOMES_QUERY]: ["v1"] },
    { [IMPORT_SESSION_TERMINAL_OUTCOMES_QUERY]: "v2" },
    { unrelated: IMPORT_SESSION_TERMINAL_OUTCOMES_VERSION },
    {
      ...terminalOutcomeProjection,
      unrelated: IMPORT_SESSION_TERMINAL_OUTCOMES_VERSION,
    },
  ])("rejects an ambiguous or unsupported projection query", (query) => {
    expect(() => parseSessionProjectionQuery(query)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("passes the exact query through the authenticated GET boundary", async () => {
    const view = { id: randomUUID() };
    const service = {
      getSession: jest.fn().mockResolvedValue(view),
    };
    const controller = new ImportSessionController(
      service as unknown as ImportSessionService,
      {} as never,
      {} as never,
      {} as never,
    );
    const auth = {} as AuthenticatedImportContext;
    const sessionId = randomUUID();

    await expect(
      controller.getSession(auth, sessionId, terminalOutcomeProjection),
    ).resolves.toBe(view);
    expect(service.getSession).toHaveBeenCalledWith(
      auth,
      sessionId,
      terminalOutcomeProjection,
    );
  });
});
