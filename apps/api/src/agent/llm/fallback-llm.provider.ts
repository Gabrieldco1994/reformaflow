import { Logger, ServiceUnavailableException } from "@nestjs/common";
import {
  ChatMessage,
  LlmCallOptions,
  LlmChatResult,
  LlmProvider,
  LlmResponseContractError,
  ToolDef,
  validateLlmCallOptions,
} from "./llm.types";

/** Erro de cota/sobrecarga do LLM — vale tentar o próximo provider. */
const RATE_LIMIT_STATUSES = new Set([429, 500, 502, 503, 413]);

export class RateLimitError extends Error {
  constructor(
    message = "O limite de uso da IA foi atingido. Tente novamente em alguns minutos.",
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Encadeia provedores de LLM: tenta o principal e, se ele falhar por cota/
 * sobrecarga (429/5xx/413), cai automaticamente para o próximo. Se TODOS
 * falharem por cota, lança RateLimitError (mensagem amigável). Outros erros
 * (ex.: payload inválido) propagam imediatamente, sem mascarar.
 */
export class FallbackLlmProvider implements LlmProvider {
  readonly id: string;
  private readonly logger = new Logger(FallbackLlmProvider.name);

  constructor(private readonly providers: LlmProvider[]) {
    this.id = providers.map((p) => p.id).join("+");
  }

  isConfigured(): boolean {
    return this.providers.some((p) => p.isConfigured());
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDef[],
    options?: LlmCallOptions,
  ): Promise<LlmChatResult> {
    validateLlmCallOptions(options);
    const active = this.providers.filter((p) => p.isConfigured());
    if (active.length === 0) {
      throw new ServiceUnavailableException();
    }

    let lastRateLimited = false;
    for (let i = 0; i < active.length; i++) {
      try {
        return options === undefined
          ? await active[i]!.chat(messages, tools)
          : await active[i]!.chat(messages, tools, options);
      } catch (e) {
        if (e instanceof LlmResponseContractError) throw e;
        const status = (e as { status?: number }).status;
        const rateLimited =
          status !== undefined && RATE_LIMIT_STATUSES.has(status);
        const isLast = i === active.length - 1;

        // Erro que não é de cota: propaga (não adianta tentar outro provider).
        if (!rateLimited) throw e;

        lastRateLimited = true;
        if (!isLast) {
          this.logger.warn(
            `Provider "${active[i]!.id}" sem cota (HTTP ${status}); tentando fallback "${active[i + 1]!.id}".`,
          );
        }
      }
    }

    if (lastRateLimited) throw new RateLimitError();
    throw new Error("Falha ao chamar o LLM.");
  }
}
