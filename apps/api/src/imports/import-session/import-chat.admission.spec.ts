require("../../../../../scripts/test-db-env.cjs");

import type { ImportChatTurnV1 } from "@reformaflow/domain";
import {
  activateImportChat,
  assertLiveImportConversationWrite,
  parseImportChatTurn,
  registerPendingImportChat,
  releaseImportChat,
  reserveImportChatOperation,
} from "./import-chat.admission";
import {
  ImportAuthGuard,
  readImportAuthForRequest,
} from "./import-session.auth";
import type { ExecutionContext } from "@nestjs/common";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { AgentController } from "../../agent/agent.controller";
import { ImportChatGuard } from "./import-chat.guard";
import { ImportUiGuard } from "./import-session-ui.guard";
import { ImportUiGrantIssuer } from "./import-session-ui-grant";

const now = new Date("2026-10-08T12:00:00.000Z");
const turn: ImportChatTurnV1 = {
  version: 1,
  turnId: "9cad9057-c2d4-4ddd-bc49-79e651b9a001",
  sessionId: "session",
  expectedRevision: 1,
  channel: "TEXT",
  literalAnswer: "206,96",
  intent: "ANSWER",
  focus: { id: "q", field: "amountCents", lineIds: ["line"] },
  scope: { kind: "LINES", lineIds: ["line"] },
};

describe("private P08 admission (not an authority minter)", () => {
  const chatRequest = () => ({
    body: { importTurn: turn },
    headers: { origin: "http://localhost:3000", "x-rf-import-ui": "1" },
    user: {
      id: "user",
      tenantId: "tenant",
      authClaims: {
        sessionVersion: 7,
        expiresAtEpochSeconds: now.getTime() / 1000 + 60,
      },
    },
  });
  const chatGuard = () =>
    new ImportChatGuard(
      new ImportAuthGuard(),
      new ImportUiGuard(
        { allowed: () => ["http://localhost:3000"] },
        new ImportUiGrantIssuer({ now: () => now }),
      ),
    );

  it.each([
    ["missing handler", undefined],
    ["same name, different identity", function chat() {}],
  ])("SEC2 rejects %s before auth minting or admission", (_label, handler) => {
    const request = chatRequest();
    const context = new ExecutionContextHost(
      [request],
      AgentController,
      handler,
    );
    expect(() => chatGuard().canActivate(context)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: "UI_ACTION_REQUIRED" }),
      }),
    );
    expect(() => readImportAuthForRequest(request)).toThrow(
      expect.objectContaining({ code: "UNAUTHENTICATED" }),
    );
    expect(activateImportChat(request, now)).toBeNull();
  });

  it("SEC2 admits the real chat handler and keeps pending separate from active", () => {
    const request = chatRequest();
    const context = new ExecutionContextHost(
      [request],
      AgentController,
      AgentController.prototype.chat,
    );
    expect(chatGuard().canActivate(context)).toBe(true);
    const originalAuth = readImportAuthForRequest(request);
    const admission = activateImportChat(request, now);
    if (!admission) throw Error("Missing admission");
    const binding = reserveImportChatOperation(admission, "EDIT", now);
    expect(binding.auth).toBe(originalAuth);
    releaseImportChat(admission);
    expect(() =>
      assertLiveImportConversationWrite(binding, originalAuth, now),
    ).toThrow(expect.objectContaining({ code: "UI_ACTION_REQUIRED" }));
  });

  it.each([
    null,
    [],
    {},
    { ...turn, tenantId: "forged" },
    { ...turn, expectedRevision: 0 },
  ])("rejects invalid envelopes explicitly: %p", (value) => {
    expect(() => parseImportChatTurn(value)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("copies and freezes the validated envelope without normalizing the literal", () => {
    const input = structuredClone(turn);
    const parsed = parseImportChatTurn(input);
    expect(parsed).toEqual(turn);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.focus?.lineIds)).toBe(true);
  });

  it("requires the exact request auth; pending is not active and release is terminal", () => {
    const request = {
      body: { importTurn: turn },
      user: {
        id: "user",
        tenantId: "tenant",
        authClaims: {
          sessionVersion: 7,
          expiresAtEpochSeconds: now.getTime() / 1000 + 60,
        },
      },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;
    new ImportAuthGuard().canActivate(context);
    const auth = readImportAuthForRequest(request);
    registerPendingImportChat(request, auth, turn);
    expect(activateImportChat({ ...request }, now)).toBeNull();
    const admission = activateImportChat(request, now);
    expect(admission).not.toBeNull();
    if (!admission) throw Error("Missing active admission");
    const binding = reserveImportChatOperation(admission, "EDIT", now);
    expect(() =>
      assertLiveImportConversationWrite(binding, auth, now),
    ).not.toThrow();
    expect(() =>
      assertLiveImportConversationWrite(binding, { ...auth }, now),
    ).toThrow(expect.objectContaining({ code: "UI_ACTION_REQUIRED" }));
    expect(() => reserveImportChatOperation(admission, "PREPARE", now)).toThrow(
      expect.objectContaining({ code: "TOOL_NOT_ALLOWED" }),
    );
    releaseImportChat(admission);
    expect(() => assertLiveImportConversationWrite(binding, auth, now)).toThrow(
      expect.objectContaining({ code: "UI_ACTION_REQUIRED" }),
    );
    expect(() => activateImportChat(request, now)).toThrow(
      expect.objectContaining({ code: "UI_ACTION_REQUIRED" }),
    );
  });

  it("does not admit a cloned request, even if its user and body are genuine", () => {
    expect(() =>
      readImportAuthForRequest({ body: { importTurn: turn } }),
    ).toThrow(expect.objectContaining({ code: "UNAUTHENTICATED" }));
  });
  it("checks the original request envelope at every reserved attempt", () => {
    const request = {
      body: { importTurn: turn },
      user: {
        id: "user",
        tenantId: "tenant",
        authClaims: {
          sessionVersion: 7,
          expiresAtEpochSeconds: now.getTime() / 1000 + 60,
        },
      },
    };
    new ImportAuthGuard().canActivate({
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext);
    registerPendingImportChat(request, readImportAuthForRequest(request), turn);
    const admission = activateImportChat(request, now);
    if (!admission) throw Error("Missing admission");
    const binding = reserveImportChatOperation(admission, "EDIT", now);
    request.body.importTurn = { ...turn, literalAnswer: "outro valor" };
    expect(() =>
      assertLiveImportConversationWrite(
        binding,
        readImportAuthForRequest(request),
        now,
      ),
    ).toThrow(expect.objectContaining({ code: "UI_ACTION_REQUIRED" }));
  });
});
