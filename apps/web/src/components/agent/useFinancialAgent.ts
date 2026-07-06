import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useProject } from '@/contexts/project-context';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: string[];
}

interface AgentResponse {
  reply: string;
  toolsUsed: string[];
  provider: string;
}

// Ferramentas que ALTERAM dados — ao usá-las, as telas precisam recarregar.
const WRITE_TOOLS = new Set(['create_expense', 'create_receipt', 'create_obra_expense']);

// Famílias de query (React Query) afetadas por uma escrita do copiloto.
const INVALIDATE_ON_WRITE: string[][] = [
  ['expenses'],
  ['receipts'],
  ['cash-flow'],
  ['dashboard'],
  ['tenant-financial'],
  ['cross-project-expenses'],
  ['monthly-overview'],
  ['bank-accounts'],
  ['credit-cards'],
  ['notifications'],
];

function describeError(error: unknown): string {
  const msg = error instanceof Error ? error.message : 'Erro ao falar com o agente.';
  const lower = msg.toLowerCase();
  if (lower.includes('limite de uso') || lower.includes('rate limit')) {
    return '⏳ O limite de uso da IA foi atingido. Tente novamente em alguns minutos.';
  }
  if (lower.includes('não configurado') || lower.includes('nao configurado')) {
    return 'O agente ainda não está configurado neste ambiente.';
  }
  return `Ops, não consegui responder agora. (${msg})`;
}

/**
 * Lógica de conversa do Copiloto compartilhada entre o chat (texto) e a tela
 * 100% voz. `send` devolve a mensagem do assistente para quem precisar falá-la.
 */
export function useFinancialAgent() {
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const messagesRef = useRef<ChatMessage[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const send = useCallback(
    async (text: string): Promise<ChatMessage | null> => {
      const content = text.trim();
      if (!content) return null;

      const history: ChatMessage[] = [...messagesRef.current, { role: 'user', content }];
      setMessages(history);
      setLoading(true);

      let assistant: ChatMessage;
      try {
        const res = await api.post<AgentResponse>(
          '/agent/chat',
          {
            projectId,
            messages: history.map((m) => ({ role: m.role, content: m.content })),
          },
          // O agente roda um loop LLM (até 12 iterações) com fallback de provider;
          // pode passar bem dos 25s padrão. Damos folga para evitar abortar uma
          // chamada que JÁ está criando a despesa no servidor (o que gerava
          // duplicatas quando o usuário reenviava após o "timeout").
          { timeoutMs: 120_000 },
        );
        assistant = { role: 'assistant', content: res.reply, toolsUsed: res.toolsUsed };
        setMessages((prev) => [...prev, assistant]);

        if (res.toolsUsed?.some((t) => WRITE_TOOLS.has(t))) {
          for (const queryKey of INVALIDATE_ON_WRITE) {
            queryClient.invalidateQueries({ queryKey });
          }
        }
      } catch (error) {
        assistant = { role: 'assistant', content: describeError(error) };
        setMessages((prev) => [...prev, assistant]);
      } finally {
        setLoading(false);
      }

      return assistant;
    },
    [projectId, queryClient],
  );

  const reset = useCallback(() => setMessages([]), []);

  return { messages, loading, send, reset };
}
