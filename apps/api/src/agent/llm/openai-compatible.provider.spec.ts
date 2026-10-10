import { Logger } from "@nestjs/common";
import { OpenAiCompatibleProvider } from "./openai-compatible.provider";
import {
  LlmCallOptions,
  LlmChatResult,
  LlmProvider,
  LlmResponseContractError,
} from "./llm.types";

const originalFetch = global.fetch;

describe("OpenAiCompatibleProvider", () => {
  const OLD_ENV = process.env;

  it("uses a fixed 100s deadline and zero retries only for focused interpretation", async () => {
    const signal = new AbortController().signal;
    const timeout = jest.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "submit_import_interpretation",
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const provider = new OpenAiCompatibleProvider("ollama");

    await provider.chat([], [], {
      responseContract: "IMPORT_INTERPRETATION_V1",
      requiredToolName: "submit_import_interpretation",
    });
    expect(timeout).toHaveBeenCalledWith(100_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(signal);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));
    await expect(
      provider.chat([], [], {
        responseContract: "IMPORT_INTERPRETATION_V1",
        requiredToolName: "submit_import_interpretation",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not add the focused deadline to generic provider calls", async () => {
    const timeout = jest.spyOn(AbortSignal, "timeout");
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "ok" },
          },
        ],
      }),
    );
    const provider = new OpenAiCompatibleProvider("ollama");
    await provider.chat([], []);
    expect(timeout).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });

  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
    global.fetch = originalFetch;
  });

  describe("OpenAiCompatibleProvider IMPORT_CHAT_V1 (inactive opt-in)", () => {
    const options = Object.freeze({
      responseContract: "IMPORT_CHAT_V1",
    } satisfies LlmCallOptions);
    const sentinel = "PRIVATE_MODEL_SENTINEL";
    let provider: OpenAiCompatibleProvider;
    let fetchMock: jest.SpiedFunction<typeof fetch>;
    let logs: jest.SpyInstance[];
    const oldEnv = process.env;

    function call(): Promise<LlmChatResult> {
      const target: LlmProvider = provider;
      return target.chat([], [], options);
    }

    function tool(args: unknown = "{}", name: unknown = "read_preview") {
      return {
        id: "correlation",
        type: "function",
        function: { name, arguments: args },
      };
    }

    function envelope(message: unknown, finishReason?: unknown) {
      return { choices: [{ message, finish_reason: finishReason }] };
    }

    function reply(message: unknown, finishReason?: unknown) {
      fetchMock.mockResolvedValue(
        Response.json(envelope(message, finishReason)),
      );
    }

    async function rejected(reason: string, callIndex: number | null = null) {
      const result = jest.fn();
      const response = call().then(result);
      await expect(response).rejects.toBeInstanceOf(LlmResponseContractError);
      await expect(response).rejects.toMatchObject({
        name: "LlmResponseContractError",
        message: "Invalid LLM response contract",
        reason,
        callIndex,
      });
      expect(result).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
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
      logs = (
        ["log", "warn", "error", "debug", "verbose", "fatal"] as const
      ).map((method) =>
        jest
          .spyOn(Logger.prototype, method)
          .mockImplementation(() => undefined),
      );
      provider = new OpenAiCompatibleProvider("ollama");
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
      process.env = oldEnv;
    });

    it.each([
      ["empty object", "{}", {}],
      ["whitespace object", ' \n {"value":"1,23"} \t', { value: "1,23" }],
      [
        "model flags are just data",
        '{"responseContract":false,"confirmed":true}',
        { responseContract: false, confirmed: true },
      ],
    ])(
      "accepts legitimate %s without changing arguments",
      async (_label, raw, parsed) => {
        reply(
          { role: "assistant", content: null, tool_calls: [tool(raw)] },
          "tool_calls",
        );
        await expect(call()).resolves.toEqual({
          content: "",
          toolCalls: [
            { id: "correlation", name: "read_preview", arguments: parsed },
          ],
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const init = fetchMock.mock.calls[0][1];
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "qwen2.5:7b-instruct",
          temperature: 0.2,
          messages: [],
        });
      },
    );

    it("accepts metadata, all calls and existing fallback ID correlation", async () => {
      fetchMock.mockResolvedValue(
        Response.json({
          id: "upstream-id",
          usage: { total_tokens: 23 },
          responseContract: false,
          choices: [
            {
              index: 0,
              finish_reason: null,
              message: {
                role: "assistant",
                extra: sentinel,
                tool_calls: [
                  tool(),
                  { ...tool('{"n":2}', "other_read"), id: "" },
                ],
              },
            },
          ],
        }),
      );
      await expect(call()).resolves.toEqual({
        content: "",
        toolCalls: [
          { id: "correlation", name: "read_preview", arguments: {} },
          { id: "call_1", name: "other_read", arguments: { n: 2 } },
        ],
      });
    });

    it.each([undefined, null, []])(
      "accepts text with tool_calls=%p",
      async (calls) => {
        reply(
          { role: "assistant", content: " Resumo. ", tool_calls: calls },
          "stop",
        );
        await expect(call()).resolves.toEqual({
          content: " Resumo. ",
          toolCalls: [],
        });
      },
    );

    it.each([null, "", " ", "{", 1, true, {}, []])(
      "rejects invalid arguments %p",
      async (args) => {
        reply({ role: "assistant", tool_calls: [tool(args)] });
        await rejected("INVALID_TOOL_ARGUMENTS", 0);
      },
    );

    it("rejects missing arguments rather than defaulting to an empty object", async () => {
      reply({
        role: "assistant",
        tool_calls: [{ type: "function", function: { name: "read_preview" } }],
      });
      await rejected("INVALID_TOOL_ARGUMENTS", 0);
    });

    it.each(["[]", "null", "1", "true", '"x"'])(
      "rejects non-object JSON arguments %s",
      async (args) => {
        reply({ role: "assistant", tool_calls: [tool(args)] });
        await rejected("ARGUMENTS_NOT_OBJECT", 0);
      },
    );

    it.each([undefined, null, "", " \t", 1, true, {}, []])(
      "never drops missing or invalid name %p",
      async (name) => {
        const tc = { type: "function", function: { name, arguments: "{}" } };
        reply({ role: "assistant", tool_calls: [tc] });
        await rejected("MISSING_TOOL_NAME", 0);
      },
    );

    it.each([
      null,
      [],
      "call",
      {},
      { type: "other", function: {} },
      { type: "function" },
      { type: "function", function: [] },
    ])("rejects malformed tool call %p", async (tc) => {
      reply({ role: "assistant", tool_calls: [tc] });
      await rejected("INVALID_TOOL_CALL", 0);
    });

    it.each([0, 1])(
      "rejects the whole batch when unnamed call is at index %i",
      async (index) => {
        const calls = [tool()];
        calls.splice(index, 0, tool("{}", ""));
        reply({
          role: "assistant",
          content: "No partial success",
          tool_calls: calls,
        });
        await rejected("MISSING_TOOL_NAME", index);
      },
    );

    it.each([0, 1])(
      "rejects the whole batch when malformed arguments are at index %i",
      async (index) => {
        const calls = [tool()];
        calls.splice(index, 0, tool("{"));
        reply({
          role: "assistant",
          content: "No partial success",
          tool_calls: calls,
        });
        await rejected("INVALID_TOOL_ARGUMENTS", index);
      },
    );

    it.each([
      null,
      [],
      1,
      {},
      { choices: null },
      { choices: {} },
      { choices: [] },
      { choices: [null] },
      { choices: [[]] },
      { choices: [{}] },
      envelope(null),
      envelope([]),
      envelope("text"),
      envelope({ role: "user", content: "text" }),
      envelope({ content: "text" }),
      envelope({ role: "assistant", content: 1 }),
      envelope({ role: "assistant", content: {} }),
      envelope({ role: "assistant", content: [] }),
      envelope({ role: "assistant", content: null }),
      envelope({ role: "assistant" }),
      envelope({ role: "assistant", content: "" }),
      envelope({ role: "assistant", content: " \t" }),
      envelope({ role: "assistant", content: "text", tool_calls: {} }),
      envelope({ role: "assistant", content: "text", tool_calls: "calls" }),
      {
        choices: [
          { message: null },
          { message: { role: "assistant", content: "later valid" } },
        ],
      },
    ])("rejects an invalid first envelope %p", async (payload) => {
      fetchMock.mockResolvedValue(Response.json(payload));
      await rejected("INVALID_RESPONSE");
    });

    it.each(["length", "content_filter", "unknown", 1, false, {}])(
      "rejects completion reason %p, including an otherwise valid batch",
      async (reason) => {
        reply({ role: "assistant", tool_calls: [tool(), tool()] }, reason);
        await rejected("INVALID_RESPONSE");
      },
    );

    it("does not let valid calls hide invalid content or role", async () => {
      reply({ role: "assistant", content: {}, tool_calls: [tool()] });
      await rejected("INVALID_RESPONSE");
      fetchMock.mockClear();
      reply({ role: "tool", content: "text", tool_calls: [tool()] });
      await rejected("INVALID_RESPONSE");
    });

    it("sanitizes JSON SyntaxError without keeping payload, tool name, status or cause", async () => {
      fetchMock.mockResolvedValue(new Response(`{"${sentinel}`));
      await rejected("INVALID_RESPONSE");
      fetchMock.mockClear();
      reply({
        role: "assistant",
        content: sentinel,
        tool_calls: [tool(`{"${sentinel}`, sentinel)],
      });
      let error: unknown;
      try {
        await call();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(LlmResponseContractError);
      expect(error).toMatchObject({
        reason: "INVALID_TOOL_ARGUMENTS",
        callIndex: 0,
      });
      expect(Object.getOwnPropertyNames(error).sort()).toEqual([
        "callIndex",
        "message",
        "name",
        "reason",
        "stack",
      ]);
      expect(JSON.stringify(error)).not.toContain(sentinel);
      expect(String(error)).not.toContain(sentinel);
      expect(logs.flatMap((log) => log.mock.calls)).toEqual([]);
    });

    it.each([
      new DOMException("aborted", "AbortError"),
      new TypeError("stream failure"),
      new Error("read failure"),
    ])("preserves non-syntax JSON read error identity: %p", async (error) => {
      const response = new Response();
      jest.spyOn(response, "json").mockRejectedValue(error);
      fetchMock.mockResolvedValue(response);
      await expect(call()).rejects.toBe(error);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not classify fetch SyntaxError as invalid response JSON", async () => {
      const error = new SyntaxError(sentinel);
      fetchMock.mockRejectedValue(error);
      await expect(call()).rejects.toBe(error);
      expect(fetchMock).toHaveBeenCalledTimes(1);
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
    ])("rejects invalid options before IO: %p", async (selection) => {
      await expect(
        Reflect.apply(provider.chat, provider, [[], [], selection]),
      ).rejects.toEqual(new TypeError("Invalid LLM call options"));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logs.flatMap((log) => log.mock.calls)).toEqual([]);
    });

    it("keeps model fields unable to activate strict parsing on a generic call", async () => {
      reply({ responseContract: "IMPORT_CHAT_V1", tool_calls: [tool("{")] });
      await expect(provider.chat([], [])).resolves.toEqual({
        content: "",
        toolCalls: [{ id: "correlation", name: "read_preview", arguments: {} }],
      });
    });

    it.each([429, 500, 503])(
      "retains the exact internal retry budget for HTTP %i without private logs",
      async (status) => {
        jest.useFakeTimers();
        fetchMock.mockImplementation(
          async () => new Response(`${sentinel} retry in 0s`, { status }),
        );
        const result = expect(call()).rejects.toMatchObject({ status });
        await jest.runAllTimersAsync();
        await result;
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(
          logs
            .flatMap((log) => log.mock.calls)
            .flat()
            .join(" "),
        ).not.toContain(sentinel);
        expect(logs.flatMap((log) => log.mock.calls).length).toBeGreaterThan(0);
      },
    );

    it.each([401, 413, 502])(
      "does not internally retry HTTP %i or log its body",
      async (status) => {
        fetchMock.mockResolvedValue(new Response(sentinel, { status }));
        await expect(call()).rejects.toMatchObject({ status });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(
          logs
            .flatMap((log) => log.mock.calls)
            .flat()
            .join(" "),
        ).not.toContain(sentinel);
      },
    );
  });

  function withEnv(env: Record<string, string | undefined>) {
    process.env = { ...OLD_ENV, ...env };
  }

  it("isConfigured: groq exige GROQ_API_KEY; ollama não", () => {
    withEnv({ AGENT_LLM_PROVIDER: "groq", GROQ_API_KEY: undefined });
    expect(new OpenAiCompatibleProvider().isConfigured()).toBe(false);

    withEnv({ AGENT_LLM_PROVIDER: "groq", GROQ_API_KEY: "k" });
    expect(new OpenAiCompatibleProvider().isConfigured()).toBe(true);

    withEnv({ AGENT_LLM_PROVIDER: "ollama" });
    expect(new OpenAiCompatibleProvider().isConfigured()).toBe(true);
  });

  it("monta o request OpenAI (model, tools, tool_choice) e parseia tool_calls", async () => {
    withEnv({
      AGENT_LLM_PROVIDER: "groq",
      GROQ_API_KEY: "secret",
      AGENT_MODEL: "modelo-x",
    });
    const provider = new OpenAiCompatibleProvider();

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "c1",
                  function: { name: "get_upcoming", arguments: '{"days":7}' },
                },
              ],
            },
          },
        ],
      }),
    });
    (global as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    const res = await provider.chat(
      [{ role: "user", content: "o que vence?" }],
      [
        {
          name: "get_upcoming",
          description: "vencimentos",
          parameters: { type: "object", properties: {} },
        },
      ],
    );

    // Resultado parseado
    expect(res.content).toBe("");
    expect(res.toolCalls).toEqual([
      { id: "c1", name: "get_upcoming", arguments: { days: 7 } },
    ]);

    // Request enviado
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/chat/completions");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer secret",
    );
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("modelo-x");
    expect(sent.tool_choice).toBe("auto");
    expect(sent.tools[0]).toEqual({
      type: "function",
      function: {
        name: "get_upcoming",
        description: "vencimentos",
        parameters: { type: "object", properties: {} },
      },
    });
  });

  it("parseia resposta de texto (sem tool_calls)", async () => {
    withEnv({ AGENT_LLM_PROVIDER: "ollama" });
    const provider = new OpenAiCompatibleProvider();
    (global as unknown as { fetch: typeof fetch }).fetch = jest
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "Olá!" } }] }),
      }) as unknown as typeof fetch;

    const res = await provider.chat([{ role: "user", content: "oi" }], []);
    expect(res.content).toBe("Olá!");
    expect(res.toolCalls).toEqual([]);
  });

  it("lança erro em HTTP não-ok (não-retriável)", async () => {
    withEnv({ AGENT_LLM_PROVIDER: "ollama" });
    const provider = new OpenAiCompatibleProvider();
    (global as unknown as { fetch: typeof fetch }).fetch = jest
      .fn()
      .mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      }) as unknown as typeof fetch;

    await expect(
      provider.chat([{ role: "user", content: "x" }], []),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("faz retry em 429/503 e desiste após o limite", async () => {
    withEnv({ AGENT_LLM_PROVIDER: "ollama" });
    const provider = new OpenAiCompatibleProvider();
    const res = {
      ok: false,
      status: 429,
      headers: { get: () => "0" },
      clone: () => ({ text: async () => "retry in 0s" }),
      text: async () => "retry in 0s",
    };
    const fetchMock = jest.fn().mockResolvedValue(res);
    (global as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    await expect(
      provider.chat([{ role: "user", content: "x" }], []),
    ).rejects.toThrow(/HTTP 429/);
    // 1 chamada inicial + retries
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
