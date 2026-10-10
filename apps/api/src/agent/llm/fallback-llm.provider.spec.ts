import { Logger } from "@nestjs/common";
import { FallbackLlmProvider, RateLimitError } from "./fallback-llm.provider";
import {
  LlmCallOptions,
  LlmChatResult,
  LlmProvider,
  LlmResponseContractError,
} from "./llm.types";
import { OpenAiCompatibleProvider } from "./openai-compatible.provider";

function provider(id: string, impl: Partial<LlmProvider>): LlmProvider {
  return {
    id,
    isConfigured: () => true,
    chat: jest.fn(),
    ...impl,
  } as LlmProvider;
}

function rateErr(status: number): Error {
  const e = new Error(`HTTP ${status}`) as Error & { status?: number };
  e.status = status;
  return e;
}

describe("FallbackLlmProvider", () => {
  it("usa o principal quando ele responde", async () => {
    const primary = provider("groq", {
      chat: jest.fn().mockResolvedValue({ content: "ok", toolCalls: [] }),
    });
    const fallback = provider("gemini", { chat: jest.fn() });
    const fb = new FallbackLlmProvider([primary, fallback]);

    const r = await fb.chat([], []);
    expect(r.content).toBe("ok");
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  describe("FallbackLlmProvider IMPORT_CHAT_V1 (real children, controlled fetch)", () => {
    const options = Object.freeze({
      responseContract: "IMPORT_CHAT_V1",
    } satisfies LlmCallOptions);
    const oldEnv = process.env;
    let primary: OpenAiCompatibleProvider;
    let secondary: OpenAiCompatibleProvider;
    let chain: FallbackLlmProvider;
    let fetchMock: jest.SpiedFunction<typeof fetch>;
    let primaryChat: jest.SpiedFunction<OpenAiCompatibleProvider["chat"]>;
    let secondaryChat: jest.SpiedFunction<OpenAiCompatibleProvider["chat"]>;

    function call(): Promise<LlmChatResult> {
      return chain.chat([], [], options);
    }

    function malformed() {
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  type: "function",
                  function: { name: "read_preview", arguments: "{}" },
                },
                {
                  type: "function",
                  function: { name: "read_preview", arguments: "{" },
                },
              ],
            },
          },
        ],
      });
    }

    beforeEach(() => {
      process.env = {
        ...oldEnv,
        OLLAMA_API_KEY: undefined,
        OLLAMA_BASE_URL: "http://unused.invalid/v1",
      };
      fetchMock = jest
        .spyOn(global, "fetch")
        .mockRejectedValue(new Error("Unexpected fetch"));
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      primary = new OpenAiCompatibleProvider("ollama", "primary");
      secondary = new OpenAiCompatibleProvider("ollama", "secondary");
      primaryChat = jest.spyOn(primary, "chat");
      secondaryChat = jest.spyOn(secondary, "chat");
      chain = new FallbackLlmProvider([primary, secondary]);
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
      process.env = oldEnv;
    });

    it("preserves option identity through operational fallback and rejects the entire secondary batch", async () => {
      fetchMock
        .mockResolvedValueOnce(new Response("unavailable", { status: 502 }))
        .mockResolvedValueOnce(malformed());
      const result = jest.fn();
      await expect(call().then(result)).rejects.toMatchObject({
        name: "LlmResponseContractError",
        reason: "INVALID_TOOL_ARGUMENTS",
        callIndex: 1,
      });
      expect(result).not.toHaveBeenCalled();
      expect(primaryChat).toHaveBeenCalledTimes(1);
      expect(secondaryChat).toHaveBeenCalledTimes(1);
      for (const child of [primaryChat, secondaryChat]) {
        expect(child.mock.calls[0]).toHaveLength(3);
        expect(child.mock.calls[0].at(2)).toBe(options);
      }
      expect(secondaryChat.mock.calls[0][0]).toBe(primaryChat.mock.calls[0][0]);
      expect(secondaryChat.mock.calls[0][1]).toBe(primaryChat.mock.calls[0][1]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("makes a malformed 2xx terminal without partial results, retry or another child", async () => {
      fetchMock.mockResolvedValue(malformed());
      const result = jest.fn();
      await expect(call().then(result)).rejects.toMatchObject({
        name: "LlmResponseContractError",
        reason: "INVALID_TOOL_ARGUMENTS",
        callIndex: 1,
      });
      expect(result).not.toHaveBeenCalled();
      expect(secondaryChat).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("propagates the same contract error before considering even a retryable status", async () => {
      fetchMock.mockResolvedValue(malformed());
      let error: unknown;
      try {
        await primary.chat([], [], options);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(LlmResponseContractError);
      if (!(error instanceof Error))
        throw new Error("Expected a contract error");
      Object.assign(error, { status: 502 });
      primaryChat.mockRejectedValue(error);
      fetchMock.mockClear();
      await expect(call()).rejects.toBe(error);
      expect(secondaryChat).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      new DOMException("aborted", "AbortError"),
      new TypeError("read failed"),
      new Error("stream failed"),
    ])(
      "propagates stream error %p by identity without fallback",
      async (error) => {
        const response = new Response();
        jest.spyOn(response, "json").mockRejectedValue(error);
        fetchMock.mockResolvedValue(response);
        await expect(call()).rejects.toBe(error);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(secondaryChat).not.toHaveBeenCalled();
      },
    );

    it("propagates a sanitized JSON syntax failure without fallback", async () => {
      fetchMock.mockResolvedValue(new Response("{"));
      await expect(call()).rejects.toMatchObject({
        name: "LlmResponseContractError",
        reason: "INVALID_RESPONSE",
        callIndex: null,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(secondaryChat).not.toHaveBeenCalled();
    });

    it("keeps network failure identity and existing no-fallback behavior", async () => {
      const error = new TypeError("network failure");
      fetchMock.mockRejectedValue(error);
      await expect(call()).rejects.toBe(error);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(secondaryChat).not.toHaveBeenCalled();
    });

    it.each([
      null,
      false,
      "IMPORT_CHAT_V1",
      [],
      {},
      { responseContract: null },
      { responseContract: "OTHER" },
      { responseContract: "IMPORT_CHAT_V1", extra: true },
      Object.create({ responseContract: "IMPORT_CHAT_V1" }),
      Object.defineProperty({ responseContract: "IMPORT_CHAT_V1" }, "hidden", {
        value: true,
      }),
      { responseContract: "IMPORT_CHAT_V1", [Symbol("extra")]: true },
    ])(
      "rejects invalid options before even selecting a child: %p",
      async (selection) => {
        const configured = jest.spyOn(primary, "isConfigured");
        const secondaryConfigured = jest.spyOn(secondary, "isConfigured");
        await expect(
          Reflect.apply(chain.chat, chain, [[], [], selection]),
        ).rejects.toEqual(new TypeError("Invalid LLM call options"));
        expect(configured).not.toHaveBeenCalled();
        expect(secondaryConfigured).not.toHaveBeenCalled();
        expect(primaryChat).not.toHaveBeenCalled();
        expect(secondaryChat).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it.each([false, true])(
      "preserves exactly two child arguments with undefined options (explicit=%p)",
      async (explicit) => {
        fetchMock
          .mockResolvedValueOnce(new Response("unavailable", { status: 502 }))
          .mockResolvedValueOnce(malformed());
        const result = explicit
          ? Reflect.apply(chain.chat, chain, [[], [], undefined])
          : chain.chat([], []);
        await expect(result).resolves.toMatchObject({
          toolCalls: [
            { name: "read_preview", arguments: {} },
            { name: "read_preview", arguments: {} },
          ],
        });
        expect(primaryChat.mock.calls[0]).toHaveLength(2);
        expect(secondaryChat.mock.calls[0]).toHaveLength(2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      },
    );

    it.each([429, 500, 503, 502, 413])(
      "preserves operational fallback and budgets for status %i",
      async (status) => {
        jest.useFakeTimers();
        fetchMock.mockImplementation(async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          return body.model === "primary"
            ? new Response("retry in 0s", { status })
            : Response.json({
                choices: [{ message: { role: "assistant", content: "ok" } }],
              });
        });
        const result = expect(call()).resolves.toEqual({
          content: "ok",
          toolCalls: [],
        });
        await jest.runAllTimersAsync();
        await result;
        expect(fetchMock).toHaveBeenCalledTimes(
          [429, 500, 503].includes(status) ? 4 : 2,
        );
        expect(secondaryChat).toHaveBeenCalledTimes(1);
      },
    );

    it("retains RateLimitError when every real provider exhausts its budget", async () => {
      jest.useFakeTimers();
      fetchMock.mockImplementation(
        async () => new Response("retry in 0s", { status: 429 }),
      );
      const result = expect(call()).rejects.toBeInstanceOf(RateLimitError);
      await jest.runAllTimersAsync();
      await result;
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it("does not fall back on non-retryable HTTP status", async () => {
      fetchMock.mockResolvedValue(new Response("denied", { status: 401 }));
      await expect(call()).rejects.toMatchObject({ status: 401 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(secondaryChat).not.toHaveBeenCalled();
    });
  });

  it("cai para o fallback quando o principal está sem cota (429)", async () => {
    const primary = provider("groq", {
      chat: jest.fn().mockRejectedValue(rateErr(429)),
    });
    const fallback = provider("gemini", {
      chat: jest
        .fn()
        .mockResolvedValue({ content: "via fallback", toolCalls: [] }),
    });
    const fb = new FallbackLlmProvider([primary, fallback]);

    const r = await fb.chat([], []);
    expect(r.content).toBe("via fallback");
    expect(primary.chat).toHaveBeenCalled();
  });

  it("lança RateLimitError quando TODOS estão sem cota", async () => {
    const primary = provider("groq", {
      chat: jest.fn().mockRejectedValue(rateErr(429)),
    });
    const fallback = provider("gemini", {
      chat: jest.fn().mockRejectedValue(rateErr(503)),
    });
    const fb = new FallbackLlmProvider([primary, fallback]);

    await expect(fb.chat([], [])).rejects.toBeInstanceOf(RateLimitError);
  });

  it("propaga erro NÃO-cota imediatamente (não tenta o fallback)", async () => {
    const primary = provider("groq", {
      chat: jest.fn().mockRejectedValue(new Error("payload inválido")),
    });
    const fallback = provider("gemini", { chat: jest.fn() });
    const fb = new FallbackLlmProvider([primary, fallback]);

    await expect(fb.chat([], [])).rejects.toThrow(/payload inválido/);
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it("ignora providers não configurados", async () => {
    const primary = provider("groq", {
      isConfigured: () => false,
      chat: jest.fn(),
    });
    const fallback = provider("gemini", {
      chat: jest
        .fn()
        .mockResolvedValue({ content: "só fallback", toolCalls: [] }),
    });
    const fb = new FallbackLlmProvider([primary, fallback]);

    const r = await fb.chat([], []);
    expect(r.content).toBe("só fallback");
    expect(primary.chat).not.toHaveBeenCalled();
  });
});
