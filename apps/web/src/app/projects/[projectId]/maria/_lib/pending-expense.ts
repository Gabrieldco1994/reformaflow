/**
 * Detecção heurística do "cartão de conferência" (lançamento por voz/texto que
 * ainda não foi criado no backend). O agente (system prompt em
 * `agent.service.ts`) foi ajustado para SEMPRE descrever a despesa e pedir
 * confirmação ANTES de chamar `create_expense`. Como a resposta é texto livre
 * do LLM, esta função é DELIBERADAMENTE conservadora: só vira cartão quando
 * (a) a mensagem ainda não criou a despesa (`toolsUsed` sem `create_expense`),
 * (b) contém um valor em R$ reconhecível, e (c) contém uma frase de pedido de
 * confirmação OU um resumo típico de "nova despesa". Fora isso, cai para
 * bolha de texto normal — nunca força um card quebradiço.
 */

export interface PendingExpenseCard {
  /** Valor em R$ como aparece no texto (ex.: "R$ 45,00"), sem parse numérico. */
  valorLabel: string;
  /** Texto integral da resposta, para exibir como descrição do cartão. */
  detalhe: string;
}

const MONEY_RE = /R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?/;

const CONFIRM_PHRASES = [/confere\s*\?/i, /confirma\s*\?/i, /pode confirmar/i, /posso (criar|lançar|registrar)/i];

const CREATION_HINTS = [/nova despesa/i, /entendi assim/i, /vou registrar/i, /entendi o seguinte/i];

interface AgentLikeMessage {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: string[];
}

export function detectPendingExpenseConfirmation(
  message: AgentLikeMessage,
): PendingExpenseCard | null {
  if (message.role !== 'assistant') return null;
  // Já criada (create_expense já rodou nesta resposta) — não é mais "pendente".
  if (message.toolsUsed?.includes('create_expense')) return null;

  const moneyMatch = message.content.match(MONEY_RE);
  if (!moneyMatch) return null;

  const hasConfirmPhrase = CONFIRM_PHRASES.some((re) => re.test(message.content));
  const hasCreationHint = CREATION_HINTS.some((re) => re.test(message.content));
  if (!hasConfirmPhrase && !hasCreationHint) return null;

  return { valorLabel: moneyMatch[0], detalhe: message.content };
}

/** Frases que o usuário pode usar para confirmar a despesa pendente na conversa. */
export const CONFIRM_REPLY = 'Confirmo';
