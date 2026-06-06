import { OpenAiCompatibleProvider } from './openai-compatible.provider';

describe('OpenAiCompatibleProvider', () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
  });

  function withEnv(env: Record<string, string | undefined>) {
    process.env = { ...OLD_ENV, ...env };
  }

  it('isConfigured: groq exige GROQ_API_KEY; ollama não', () => {
    withEnv({ AGENT_LLM_PROVIDER: 'groq', GROQ_API_KEY: undefined });
    expect(new OpenAiCompatibleProvider().isConfigured()).toBe(false);

    withEnv({ AGENT_LLM_PROVIDER: 'groq', GROQ_API_KEY: 'k' });
    expect(new OpenAiCompatibleProvider().isConfigured()).toBe(true);

    withEnv({ AGENT_LLM_PROVIDER: 'ollama' });
    expect(new OpenAiCompatibleProvider().isConfigured()).toBe(true);
  });

  it('monta o request OpenAI (model, tools, tool_choice) e parseia tool_calls', async () => {
    withEnv({ AGENT_LLM_PROVIDER: 'groq', GROQ_API_KEY: 'secret', AGENT_MODEL: 'modelo-x' });
    const provider = new OpenAiCompatibleProvider();

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'c1', function: { name: 'get_upcoming', arguments: '{"days":7}' } },
              ],
            },
          },
        ],
      }),
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const res = await provider.chat(
      [{ role: 'user', content: 'o que vence?' }],
      [{ name: 'get_upcoming', description: 'vencimentos', parameters: { type: 'object', properties: {} } }],
    );

    // Resultado parseado
    expect(res.content).toBe('');
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'get_upcoming', arguments: { days: 7 } }]);

    // Request enviado
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret');
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe('modelo-x');
    expect(sent.tool_choice).toBe('auto');
    expect(sent.tools[0]).toEqual({
      type: 'function',
      function: { name: 'get_upcoming', description: 'vencimentos', parameters: { type: 'object', properties: {} } },
    });
  });

  it('parseia resposta de texto (sem tool_calls)', async () => {
    withEnv({ AGENT_LLM_PROVIDER: 'ollama' });
    const provider = new OpenAiCompatibleProvider();
    (global as unknown as { fetch: typeof fetch }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Olá!' } }] }),
    }) as unknown as typeof fetch;

    const res = await provider.chat([{ role: 'user', content: 'oi' }], []);
    expect(res.content).toBe('Olá!');
    expect(res.toolCalls).toEqual([]);
  });

  it('lança erro em HTTP não-ok', async () => {
    withEnv({ AGENT_LLM_PROVIDER: 'ollama' });
    const provider = new OpenAiCompatibleProvider();
    (global as unknown as { fetch: typeof fetch }).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    }) as unknown as typeof fetch;

    await expect(provider.chat([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/HTTP 500/);
  });
});
