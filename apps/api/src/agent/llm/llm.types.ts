export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Argumentos já parseados do JSON. */
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Presente em mensagens 'assistant' que pedem chamadas de ferramenta. */
  toolCalls?: ToolCall[];
  /** Presente em mensagens 'tool' (id da chamada que está sendo respondida). */
  toolCallId?: string;
  /** Nome da ferramenta (mensagens 'tool'). */
  name?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema dos parâmetros. */
  parameters: Record<string, unknown>;
}

export interface LlmChatResult {
  content: string;
  toolCalls: ToolCall[];
}

export interface LlmProvider {
  /** Identificação do backend para logs/diagnóstico. */
  readonly id: string;
  /** Retorna true se o provider está configurado (ex.: chave/baseUrl presentes). */
  isConfigured(): boolean;
  chat(messages: ChatMessage[], tools: ToolDef[]): Promise<LlmChatResult>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
