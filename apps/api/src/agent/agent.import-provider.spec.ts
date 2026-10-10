import {
  HttpException,
  ServiceUnavailableException,
  type ExecutionContext,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Request } from "express";
import {
  ImportSessionAmountMeaning,
  ImportSessionState,
  type ImportChatTurnV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";
import { buildLlmProvider } from "./agent.module";
import { AgentChatDto } from "./dto/agent-chat.dto";
import { AgentToolsService } from "./tools/agent-tools.service";
import { LLM_PROVIDER, type LlmProvider } from "./llm/llm.types";
import { FallbackLlmProvider } from "./llm/fallback-llm.provider";
import { PrismaService } from "../prisma/prisma.service";
import { ImportChatBridge } from "../imports/import-session/import-chat.bridge";
import { registerPendingImportChat } from "../imports/import-session/import-chat.admission";
import {
  ImportAuthGuard,
  readImportAuthForRequest,
} from "../imports/import-session/import-session.auth";
import { DefaultImportSessionCapability } from "../imports/import-session/import-session.capability";
import type { ImportSessionService } from "../imports/import-session/import-session.service";
import type { ImportSessionWorkflowService } from "../imports/import-session/import-session-workflow.service";

describe("Maria ANSWER provider boundary", () => {
  const now = new Date("2026-10-10T16:00:00.000Z");
  const turn: ImportChatTurnV1 = {
    version: 1,
    turnId: randomUUID(),
    sessionId: "session-provider",
    expectedRevision: 4,
    channel: "TEXT",
    intent: "ANSWER",
    literalAnswer: "total da compra",
    focus: {
      id: "question-meaning",
      field: "amountMeaning",
      lineIds: ["line-purchase"],
    },
    scope: { kind: "LINES", lineIds: ["line-purchase"] },
  };
  const view: ImportSessionViewV1 = {
    version: 1,
    id: turn.sessionId,
    ownerProjectId: "project-provider",
    cardId: "card-provider",
    state: ImportSessionState.NEEDS_INPUT,
    revision: turn.expectedRevision,
    expiresAt: "2026-10-17T16:00:00.000Z",
    lines: [
      {
        id: "line-purchase",
        observationIds: ["observation-purchase"],
        titulo: "Synthetic purchase",
        fornecedor: null,
        tipoDespesa: null,
        categoriaMaoDeObra: null,
        amountMeaning: ImportSessionAmountMeaning.UNKNOWN,
        amountCents: 12500,
        installmentCount: null,
        dataCompra: "2026-10-01",
        firstDueDate: null,
        targets: null,
        decision: { kind: "UNRESOLVED" },
      },
    ],
    selectedLineIds: ["line-purchase"],
    questions: [
      {
        id: "question-meaning",
        field: "amountMeaning",
        lineIds: ["line-purchase"],
        text: "Qual é o significado do valor?",
      },
    ],
    attachments: [],
    declaredFacts: [],
    reviewBlockers: [],
    searchComplete: false,
    proposal: null,
    confirmation: null,
    receipt: null,
    actions: ["RESOLVE", "CANCEL", "READ_RESULT"],
  };
  let unavailableUrl: string;

  beforeAll(async () => {
    // Reserve and close a loopback port: real fetch, no model or external network.
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    unavailableUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  const callAnswer = async (llm: LlmProvider): Promise<HttpException> => {
    const sessions = {
      getSession: jest.fn().mockResolvedValue(structuredClone(view)),
    } satisfies Pick<ImportSessionService, "getSession">;
    const workflow = {
      editConversationAnswer: jest.fn(),
      prepareConversation: jest.fn(),
      prepare: jest.fn(),
      confirm: jest.fn(),
      execute: jest.fn(),
    } satisfies Partial<ImportSessionWorkflowService>;
    // The bridge/admission/projection are real; only persistence is represented.
    const bridge = new ImportChatBridge(
      sessions as unknown as ImportSessionService,
      workflow as unknown as ImportSessionWorkflowService,
      {} as PrismaService,
      { now: () => now },
      new DefaultImportSessionCapability(),
      {} as never,
    );
    const execute = jest.fn();
    const module = await Test.createTestingModule({
      providers: [
        AgentService,
        { provide: LLM_PROVIDER, useValue: llm },
        { provide: AgentToolsService, useValue: { execute } },
        { provide: ImportChatBridge, useValue: bridge },
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();
    const controller = new AgentController(
      module.get(AgentService),
      {} as PrismaService,
    );
    Reflect.set(controller, "importChat", bridge);
    const body = {
      messages: [{ role: "user", content: turn.literalAnswer }],
      importTurn: turn,
    };
    const dto = plainToInstance(AgentChatDto, body);
    expect(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).toEqual([]);
    const request = {
      body: dto,
      user: {
        id: "user-provider",
        tenantId: "tenant-provider",
        authClaims: {
          sessionVersion: 0,
          expiresAtEpochSeconds: now.getTime() / 1000 + 86400,
        },
      },
    };
    new ImportAuthGuard().canActivate({
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext);
    registerPendingImportChat(request, readImportAuthForRequest(request), turn);
    try {
      await controller.chat(
        request.user.tenantId,
        { id: request.user.id, role: "OWNER" },
        dto,
        request as unknown as Request,
      );
      throw new Error("Expected an unavailable provider");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect(execute).not.toHaveBeenCalled();
      for (const write of Object.values(workflow))
        expect(write).not.toHaveBeenCalled();
      expect(sessions.getSession).toHaveBeenCalledTimes(2);
      expect(view.revision).toBe(4);
      return error as HttpException;
    } finally {
      await module.close();
    }
  };

  const expectUnavailable = (error: HttpException): void => {
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({
      importOutcome: {
        version: 1,
        turnId: turn.turnId,
        kind: "ERROR",
        code: "PROVIDER_UNAVAILABLE",
        ref: { sessionId: view.id, revision: view.revision },
        reason: null,
        retryable: true,
        recovery: "READ_SESSION",
        acknowledgment: "NONE",
      },
    });
  };

  it("reproduces the native fetch TypeError/ECONNREFUSED without a provider", async () => {
    await expect(
      fetch(`${unavailableUrl}/chat/completions`),
    ).rejects.toMatchObject({
      name: "TypeError",
      message: "fetch failed",
      cause: { code: "ECONNREFUSED" },
    });
  });

  it("returns the standard 503 outcome when the configured Ollama endpoint is absent", async () => {
    jest.replaceProperty(process, "env", {
      AGENT_LLM_PROVIDER: "ollama",
      OLLAMA_BASE_URL: unavailableUrl,
    });
    const provider = buildLlmProvider();
    expect(provider.id).toBe("ollama");
    expect(provider.isConfigured()).toBe(true);
    expectUnavailable(await callAnswer(provider));
  });

  it("returns the same standard 503 when Gemini credentials are absent, without fetching", async () => {
    jest.replaceProperty(process, "env", { AGENT_LLM_PROVIDER: "gemini" });
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    expectUnavailable(await callAnswer(buildLlmProvider()));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports an empty fallback chain as service unavailable", async () => {
    await expect(
      new FallbackLlmProvider([]).chat([], []),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("rejects a direct unconfigured provider call before sending any request", async () => {
    jest.replaceProperty(process, "env", { AGENT_LLM_PROVIDER: "gemini" });
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    await expect(buildLlmProvider().chat([], [])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the standard 503 outcome when every fallback endpoint is unavailable", async () => {
    jest.replaceProperty(process, "env", {
      AGENT_LLM_PROVIDER: "ollama",
      OLLAMA_BASE_URL: unavailableUrl,
    });
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const provider = buildLlmProvider();
    expectUnavailable(
      await callAnswer(new FallbackLlmProvider([provider, provider])),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps invalid model output distinct from provider unavailability", async () => {
    jest.replaceProperty(process, "env", {
      AGENT_LLM_PROVIDER: "ollama",
      OLLAMA_BASE_URL: unavailableUrl,
    });
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const error = await callAnswer(buildLlmProvider());
    expect(error.getStatus()).toBe(502);
    expect(error.getResponse()).toMatchObject({
      importOutcome: {
        code: "MODEL_OUTPUT_INVALID",
        retryable: false,
        acknowledgment: "NONE",
      },
    });
  });

  it("does not disguise an invalid provider URL as transient unavailability", async () => {
    jest.replaceProperty(process, "env", {
      AGENT_LLM_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "invalid-url",
    });
    await expect(buildLlmProvider().chat([], [])).rejects.toMatchObject({
      name: "TypeError",
      cause: { code: "ERR_INVALID_URL" },
    });
  });

  it("does not disguise an unrelated TypeError as provider unavailability", async () => {
    jest.replaceProperty(process, "env", {
      AGENT_LLM_PROVIDER: "ollama",
      OLLAMA_BASE_URL: unavailableUrl,
    });
    const bug = new TypeError("Unexpected programming defect");
    jest.spyOn(globalThis, "fetch").mockRejectedValue(bug);
    await expect(
      buildLlmProvider().chat([], [], { responseContract: "IMPORT_CHAT_V1" }),
    ).rejects.toBe(bug);
  });
});
