import { Logger } from '@nestjs/common';
import {
  ChatMessage,
  LlmChatResult,
  LlmProvider,
  ToolCall,
  ToolDef,
} from './llm.types';

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiMessage {
  role: string;
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

/**
 * Provider compatível com a API OpenAI `/chat/completions` (function calling).
 * Cobre tanto Ollama (dev, local) quanto Groq (prod, free tier) — ambos expõem
 * o mesmo formato. Configurado por env:
 *   AGENT_LLM_PROVIDER = 'ollama' | 'groq' | 'gemini'
 *   AGENT_MODEL        = override do modelo
 *   OLLAMA_BASE_URL    = base do ollama (default http://localhost:11434/v1)
 *   GROQ_API_KEY       = chave do Groq (prod)
 *   GEMINI_API_KEY     = chave do Google Gemini (prod)
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiCompatibleProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;

  constructor() {
    const provider = (process.env['AGENT_LLM_PROVIDER'] || 'ollama').toLowerCase();
    this.id = provider;
    if (provider === 'groq') {
      this.baseUrl = process.env['GROQ_BASE_URL'] || 'https://api.groq.com/openai/v1';
      this.apiKey = process.env['GROQ_API_KEY'];
      this.model = process.env['AGENT_MODEL'] || 'llama-3.3-70b-versatile';
    } else if (provider === 'gemini') {
      // Endpoint OpenAI-compatível do Google Gemini (suporta function calling).
      this.baseUrl =
        process.env['GEMINI_BASE_URL'] ||
        'https://generativelanguage.googleapis.com/v1beta/openai';
      this.apiKey = process.env['GEMINI_API_KEY'] || process.env['GOOGLE_API_KEY'];
      this.model = process.env['AGENT_MODEL'] || 'gemini-2.5-flash';
    } else {
      // ollama (default)
      this.baseUrl = process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434/v1';
      this.apiKey = process.env['OLLAMA_API_KEY']; // normalmente não exigido
      this.model = process.env['AGENT_MODEL'] || 'qwen2.5:7b-instruct';
    }
  }

  isConfigured(): boolean {
    if (this.id === 'groq' || this.id === 'gemini') return !!this.apiKey;
    return !!this.baseUrl; // ollama não exige chave
  }

  async chat(messages: ChatMessage[], tools: ToolDef[]): Promise<LlmChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: 0.2,
      messages: messages.map((m) => this.toOpenAiMessage(m)),
    };
    if (tools.length > 0) {
      body['tools'] = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body['tool_choice'] = 'auto';
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const res = await this.fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      { method: 'POST', headers, body: JSON.stringify(body) },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.error(`LLM ${this.id} HTTP ${res.status}: ${text.slice(0, 500)}`);
      throw new Error(`Falha ao chamar o LLM (${this.id}): HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: OpenAiMessage }>;
    };
    const msg = data.choices?.[0]?.message;
    const toolCalls = this.parseToolCalls(msg?.tool_calls);
    return { content: msg?.content ?? '', toolCalls };
  }

  /**
   * fetch com retry em 429 (rate limit). Respeita o tempo sugerido pelo provider
   * (header Retry-After ou "retry in Xs" no corpo), com teto e backoff. Resolve
   * o limite de requisições/minuto do free tier (Gemini ~20 RPM) sem falhar a
   * conversa quando o agente encadeia várias chamadas.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    maxRetries = 3,
  ): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const res = await fetch(url, init);
      if (res.status !== 429 || attempt >= maxRetries) return res;

      const body = await res.clone().text().catch(() => '');
      const waitMs = this.retryDelayMs(res.headers.get('retry-after'), body, attempt);
      this.logger.warn(
        `LLM ${this.id} 429 (tentativa ${attempt + 1}/${maxRetries}); aguardando ${Math.round(waitMs / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      attempt += 1;
    }
  }

  /** Tempo de espera: Retry-After, ou "retry in Xs" do corpo, ou backoff. Teto 30s. */
  private retryDelayMs(retryAfter: string | null, body: string, attempt: number): number {
    const cap = 30_000;
    const ra = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000 + 500, cap);
    const m = body.match(/retry\s*in\s*([\d.]+)s/i);
    if (m && m[1]) return Math.min(Math.ceil(parseFloat(m[1])) * 1000 + 500, cap);
    return Math.min(2000 * 2 ** attempt, cap); // 2s, 4s, 8s…
  }

  private toOpenAiMessage(m: ChatMessage): OpenAiMessage {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        })) as OpenAiToolCall[],
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId, name: m.name };
    }
    return { role: m.role, content: m.content };
  }

  private parseToolCalls(raw: OpenAiToolCall[] | undefined): ToolCall[] {
    if (!raw || raw.length === 0) return [];
    const out: ToolCall[] = [];
    for (let i = 0; i < raw.length; i++) {
      const tc = raw[i];
      const name = tc.function?.name;
      if (!name) continue;
      let args: Record<string, unknown> = {};
      const rawArgs = tc.function?.arguments;
      if (rawArgs) {
        try {
          const parsed = JSON.parse(rawArgs);
          if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
        } catch {
          this.logger.warn(`Argumentos inválidos para ${name}: ${rawArgs.slice(0, 200)}`);
        }
      }
      out.push({ id: tc.id || `call_${i}`, name, arguments: args });
    }
    return out;
  }
}
