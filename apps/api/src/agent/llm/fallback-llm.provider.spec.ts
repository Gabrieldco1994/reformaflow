import { FallbackLlmProvider, RateLimitError } from './fallback-llm.provider';
import { LlmProvider } from './llm.types';

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

describe('FallbackLlmProvider', () => {
  it('usa o principal quando ele responde', async () => {
    const primary = provider('groq', { chat: jest.fn().mockResolvedValue({ content: 'ok', toolCalls: [] }) });
    const fallback = provider('gemini', { chat: jest.fn() });
    const fb = new FallbackLlmProvider([primary, fallback]);

    const r = await fb.chat([], []);
    expect(r.content).toBe('ok');
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it('cai para o fallback quando o principal está sem cota (429)', async () => {
    const primary = provider('groq', { chat: jest.fn().mockRejectedValue(rateErr(429)) });
    const fallback = provider('gemini', { chat: jest.fn().mockResolvedValue({ content: 'via fallback', toolCalls: [] }) });
    const fb = new FallbackLlmProvider([primary, fallback]);

    const r = await fb.chat([], []);
    expect(r.content).toBe('via fallback');
    expect(primary.chat).toHaveBeenCalled();
  });

  it('lança RateLimitError quando TODOS estão sem cota', async () => {
    const primary = provider('groq', { chat: jest.fn().mockRejectedValue(rateErr(429)) });
    const fallback = provider('gemini', { chat: jest.fn().mockRejectedValue(rateErr(503)) });
    const fb = new FallbackLlmProvider([primary, fallback]);

    await expect(fb.chat([], [])).rejects.toBeInstanceOf(RateLimitError);
  });

  it('propaga erro NÃO-cota imediatamente (não tenta o fallback)', async () => {
    const primary = provider('groq', { chat: jest.fn().mockRejectedValue(new Error('payload inválido')) });
    const fallback = provider('gemini', { chat: jest.fn() });
    const fb = new FallbackLlmProvider([primary, fallback]);

    await expect(fb.chat([], [])).rejects.toThrow(/payload inválido/);
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it('ignora providers não configurados', async () => {
    const primary = provider('groq', { isConfigured: () => false, chat: jest.fn() });
    const fallback = provider('gemini', { chat: jest.fn().mockResolvedValue({ content: 'só fallback', toolCalls: [] }) });
    const fb = new FallbackLlmProvider([primary, fallback]);

    const r = await fb.chat([], []);
    expect(r.content).toBe('só fallback');
    expect(primary.chat).not.toHaveBeenCalled();
  });
});
