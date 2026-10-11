import type { ExecutionContext } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { randomUUID } from "node:crypto";
import { AgentController } from "./agent.controller";
import { AgentChatDto } from "./dto/agent-chat.dto";
import {
  activateImportChat,
  registerPendingImportChat,
} from "../imports/import-session/import-chat.admission";
import {
  ImportAuthGuard,
  readImportAuthForRequest,
} from "../imports/import-session/import-session.auth";

describe("generic Maria transport origin", () => {
  it.each(["TEXT", "VOICE"] as const)(
    "admits only the exact generic %s origin",
    async (origin) => {
      const dto = plainToInstance(AgentChatDto, {
        metadata: { channel: origin },
        messages: [{ role: "user", content: "Quero importar minha fatura" }],
      });
      expect(
        await validate(dto, {
          whitelist: true,
          forbidNonWhitelisted: true,
        }),
      ).toEqual([]);
      expect(dto).toMatchObject({ metadata: { channel: origin } });
    },
  );

  it.each([
    { channel: "voice" },
    { channel: "TEXT " },
    { channel: "" },
    { channel: 1 },
    { channel: {} },
    { channel: ["VOICE"] },
    { channel: "VOICE", extra: true },
  ])(
    "rejects malformed nested metadata %p instead of coercing it",
    async (metadata) => {
      const dto = plainToInstance(AgentChatDto, {
        metadata,
        messages: [{ role: "user", content: "Quero importar minha fatura" }],
      });
      expect(
        await validate(dto, {
          whitelist: true,
          forbidNonWhitelisted: true,
        }),
      ).not.toEqual([]);
    },
  );

  it("uses contextual importTurn.channel as authority over a conflicting generic origin", async () => {
    const now = new Date("2026-10-11T12:00:00.000Z");
    const turn = {
      version: 1,
      turnId: randomUUID(),
      sessionId: "session-origin-authority",
      expectedRevision: 4,
      channel: "VOICE",
      literalAnswer: "sim",
      intent: "OPEN_REVIEW",
      focus: null,
      scope: null,
    } as const;
    const request = {
      body: {
        metadata: { channel: "TEXT" },
        messages: [{ role: "user", content: turn.literalAnswer }],
        importTurn: turn,
      },
      user: {
        id: "user-origin-authority",
        tenantId: "tenant-origin-authority",
        authClaims: {
          sessionVersion: 0,
          expiresAtEpochSeconds: now.getTime() / 1000 + 60,
        },
      },
    };
    new ImportAuthGuard().canActivate({
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext);
    registerPendingImportChat(request, readImportAuthForRequest(request), turn);
    const admission = activateImportChat(request, now);
    expect(admission).not.toBeNull();
    expect(admission!.turn.channel).toBe("VOICE");

    const agent = { chat: jest.fn().mockResolvedValue({ ok: true }) };
    const bridge = {
      contextForRequest: jest.fn().mockReturnValue(admission),
      release: jest.fn(),
    };
    const controller = new AgentController(
      agent as never,
      {
        project: { findMany: jest.fn() },
      } as never,
    );
    Reflect.set(controller, "importChat", bridge);
    await controller.chat(
      request.user.tenantId,
      { id: request.user.id, role: "OWNER" },
      request.body as never,
      request as never,
    );
    expect(agent.chat).toHaveBeenCalledWith({
      tenantId: request.user.tenantId,
      userId: request.user.id,
      messages: request.body.messages,
      importAdmission: admission,
    });
    expect(agent.chat.mock.calls[0][0].importAdmission.turn.channel).toBe(
      "VOICE",
    );
    expect(bridge.release).toHaveBeenCalledWith(admission);
  });
});
