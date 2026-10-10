export type ChatRole = "system" | "user" | "assistant" | "tool";

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

/**
 * Opt-in interno de decodificação, ainda sem consumidor no AgentService.
 * Não concede autoridade/admissão e nunca é serializado para o modelo.
 * Ausente preserva o contrato genérico, inclusive chamadas com dois argumentos.
 */
export interface LlmCallOptions {
  readonly responseContract: "IMPORT_CHAT_V1";
}

export function validateLlmCallOptions(
  options: unknown,
): asserts options is LlmCallOptions | undefined {
  if (options === undefined) return;
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Reflect.ownKeys(options).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(options, "responseContract") ||
    !("responseContract" in options) ||
    options.responseContract !== "IMPORT_CHAT_V1"
  ) {
    throw new TypeError("Invalid LLM call options");
  }
}

export type LlmResponseContractReason =
  | "INVALID_RESPONSE"
  | "INVALID_TOOL_CALL"
  | "MISSING_TOOL_NAME"
  | "INVALID_TOOL_ARGUMENTS"
  | "ARGUMENTS_NOT_OBJECT";

/**
 * Falha terminal de forma do resultado completo, sem retry/repair/fallback.
 * Não carrega payload, nome de tool, status upstream ou causa JSON; a fronteira
 * contextual futura é responsável pela tradução pública, não este provider.
 */
export class LlmResponseContractError extends Error {
  constructor(
    readonly reason: LlmResponseContractReason,
    readonly callIndex: number | null = null,
  ) {
    super("Invalid LLM response contract");
    this.name = "LlmResponseContractError";
  }
}

export interface LlmProvider {
  /** Identificação do backend para logs/diagnóstico. */
  readonly id: string;
  /** Retorna true se o provider está configurado (ex.: chave/baseUrl presentes). */
  isConfigured(): boolean;
  chat(
    messages: ChatMessage[],
    tools: ToolDef[],
    options?: LlmCallOptions,
  ): Promise<LlmChatResult>;
}

export const LLM_PROVIDER = Symbol("LLM_PROVIDER");
