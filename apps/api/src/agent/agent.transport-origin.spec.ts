import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { randomUUID } from "node:crypto";
import { ValidationPipe } from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants";
import { AgentChatDto } from "./dto/agent-chat.dto";
import { AgentController } from "./agent.controller";

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

  it("rejects active importTurn before provider, tool, prepare or apply can run", async () => {
    expect(Reflect.getMetadata(PATH_METADATA, AgentController)).toBe("agent");
    expect(
      Reflect.getMetadata(PATH_METADATA, AgentController.prototype.chat),
    ).toBe("chat");
    const activeTurn = {
      version: 1,
      turnId: randomUUID(),
      sessionId: "session-active",
      expectedRevision: 4,
      channel: "VOICE",
      literalAnswer: "sim",
      intent: "OPEN_REVIEW",
      focus: null,
      scope: null,
    } as const;
    const provider = jest.fn();
    const tool = jest.fn();
    const prepare = jest.fn();
    const apply = jest.fn();
    const payload = {
      messages: [{ role: "user", content: activeTurn.literalAnswer }],
      importTurn: activeTurn,
    };
    const dispatch = async () => {
      await new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }).transform(payload, {
        type: "body",
        metatype: AgentChatDto,
      });
      await provider();
      await tool();
      await prepare();
      await apply();
    };

    await expect(dispatch()).rejects.toMatchObject({ status: 400 });
    expect(provider).not.toHaveBeenCalled();
    expect(tool).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});
