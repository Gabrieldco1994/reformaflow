'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, Send, X, Sparkles } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useProject } from '@/contexts/project-context';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: string[];
}

interface AgentResponse {
  reply: string;
  toolsUsed: string[];
  provider: string;
}

const TOOL_LABELS: Record<string, string> = {
  list_projects: 'projetos',
  get_financial_overview: 'visão geral',
  get_by_project: 'por projeto',
  get_expenses_by_category: 'por categoria',
  get_upcoming: 'próximos vencimentos',
  get_top_suppliers: 'fornecedores',
  get_category_taxonomy: 'categorias',
  get_cashflow_history: 'histórico',
  get_recurring_bills: 'contas recorrentes',
  get_account_balances: 'saldos',
  find_expenses: 'busca de despesas',
  list_payment_methods: 'cartões/contas',
  create_expense: 'registrou despesa',
  create_receipt: 'registrou recebimento',
  create_obra_expense: 'registrou despesa de obra (caixa pessoal)',
};

// Ferramentas que ALTERAM dados — ao usá-las, as telas precisam recarregar.
const WRITE_TOOLS = new Set(['create_expense', 'create_receipt', 'create_obra_expense']);

// Famílias de query (React Query) afetadas por uma escrita do copiloto.
const INVALIDATE_ON_WRITE = [
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

const SUGGESTIONS = [
  'Quanto tenho em caixa?',
  'O que vence nos próximos 7 dias?',
  'Onde estou gastando mais?',
];

export function FinancialAgentWidget() {
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || loading) return;
    const userMsg: ChatMessage = { role: 'user', content };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setLoading(true);
    try {
      const res = await api.post<AgentResponse>('/agent/chat', {
        projectId,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
      });
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: res.reply, toolsUsed: res.toolsUsed },
      ]);
      // Se o copiloto criou/alterou algo, invalida as listas para a UI refletir
      // sem o usuário precisar recarregar a página.
      if (res.toolsUsed?.some((t) => WRITE_TOOLS.has(t))) {
        for (const queryKey of INVALIDATE_ON_WRITE) {
          queryClient.invalidateQueries({ queryKey });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Erro ao falar com o agente.';
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            msg.includes('não configurado') || msg.includes('503')
              ? 'O agente ainda não está configurado neste ambiente. Defina o provider de LLM (Ollama no dev ou GROQ_API_KEY no prod).'
              : `Ops, não consegui responder agora. (${msg})`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* FAB */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Abrir Copiloto Financeiro"
          className="fixed bottom-20 right-4 md:bottom-6 md:right-6 z-40 flex items-center gap-2 rounded-full bg-darc-velvet text-white shadow-lg px-4 py-3 hover:opacity-90 transition-opacity"
        >
          <Sparkles className="w-5 h-5" />
          <span className="hidden sm:inline text-sm font-medium">Copiloto</span>
        </button>
      )}

      {/* Painel */}
      {open && (
        <div className="fixed bottom-4 right-4 md:bottom-6 md:right-6 z-50 flex flex-col w-[calc(100vw-2rem)] sm:w-96 h-[70vh] max-h-[600px] rounded-2xl bg-white border border-darc-linen shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-darc-velvet text-white">
            <div className="flex items-center gap-2">
              <Bot className="w-5 h-5" />
              <div className="leading-tight">
                <p className="text-sm font-semibold">Copiloto Financeiro</p>
                <p className="text-[10px] text-white/70">Pergunte sobre suas finanças</p>
              </div>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Fechar" className="p-1 rounded hover:bg-white/10">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Mensagens */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 bg-darc-linen/20">
            {messages.length === 0 && (
              <div className="text-center text-sm text-darc-velvet/60 mt-6 space-y-3">
                <p>👋 Sou seu copiloto financeiro. Pergunte algo:</p>
                <div className="flex flex-col gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => send(s)}
                      className="text-xs rounded-lg border border-darc-linen bg-white px-3 py-2 hover:border-darc-velvet/40 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'bg-darc-velvet text-white rounded-br-sm'
                      : 'bg-white border border-darc-linen text-darc-velvet rounded-bl-sm'
                  }`}
                >
                  {m.content}
                  {m.role === 'assistant' && m.toolsUsed && m.toolsUsed.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {Array.from(new Set(m.toolsUsed)).map((t) => (
                        <span
                          key={t}
                          className="text-[9px] bg-darc-linen/60 text-darc-velvet/70 rounded-full px-1.5 py-0.5"
                        >
                          {TOOL_LABELS[t] ?? t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-white border border-darc-linen rounded-2xl rounded-bl-sm px-3 py-2 text-sm text-darc-velvet/60">
                  <span className="inline-flex gap-1">
                    <span className="w-1.5 h-1.5 bg-darc-velvet/40 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-darc-velvet/40 rounded-full animate-bounce" style={{ animationDelay: '120ms' }} />
                    <span className="w-1.5 h-1.5 bg-darc-velvet/40 rounded-full animate-bounce" style={{ animationDelay: '240ms' }} />
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 p-2 border-t border-darc-linen bg-white"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Pergunte sobre suas finanças..."
              className="flex-1 text-sm border border-darc-linen rounded-full px-3 py-2 focus:outline-none focus:ring-1 focus:ring-darc-velvet/30"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              aria-label="Enviar"
              className="p-2 rounded-full bg-darc-velvet text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}
    </>
  );
}
