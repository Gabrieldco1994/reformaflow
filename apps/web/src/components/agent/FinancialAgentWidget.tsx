'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, Send, X, Sparkles, Volume2, Square, Mic } from 'lucide-react';
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

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const TTS_ERROR_PREFIX = 'Não consegui gerar áudio agora.';

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult:
    | ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
    | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function FinancialAgentWidget() {
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [ttsLoadingIndex, setTtsLoadingIndex] = useState<number | null>(null);
  const [ttsError, setTtsError] = useState('');
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [voiceMode, setVoiceMode] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [speechApi, setSpeechApi] = useState<SpeechRecognitionCtor | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const win = window as Window & {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
    setSpeechApi(() => ctor);
    setVoiceSupported(Boolean(ctor));
  }, []);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // no-op
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!autoSpeak || messages.length === 0) return;
    const idx = messages.length - 1;
    const last = messages[idx];
    if (last.role !== 'assistant') return;
    if (last.content.startsWith(TTS_ERROR_PREFIX)) return;
    void speak(idx, last.content);
  }, [autoSpeak, messages]);

  useEffect(() => {
    if (!open || !voiceMode || !voiceSupported || voiceListening || loading) return;
    const timer = setTimeout(() => startVoiceCapture(), 250);
    return () => clearTimeout(timer);
  }, [open, voiceMode, voiceSupported, voiceListening, loading]);

  const queueNextVoiceTurn = () => {
    if (!voiceMode || !open || loading) return;
    const timer = setTimeout(() => {
      if (!voiceListening) startVoiceCapture();
    }, 400);
    return () => clearTimeout(timer);
  };

  const stopSpeaking = (reason: 'manual' | 'ended' | 'error' = 'manual') => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setSpeakingIndex(null);
    if (reason === 'ended') queueNextVoiceTurn();
  };

  const speak = async (index: number, text: string) => {
    if (!text.trim()) return;
    setTtsError('');
    if (speakingIndex === index) {
      stopSpeaking();
      return;
    }

    setTtsLoadingIndex(index);
    try {
      const response = await fetch(`${API_BASE}/tts/synthesize`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, maxSeconds: voiceMode ? 120 : 90 }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
        throw new Error(
          Array.isArray(error.message) ? error.message.join('; ') : (error.message ?? 'Falha no TTS'),
        );
      }

      const blob = await response.blob();
      stopSpeaking();
      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      objectUrlRef.current = objectUrl;
      setSpeakingIndex(index);
      audio.onended = () => stopSpeaking('ended');
      audio.onerror = () => stopSpeaking('error');
      await audio.play();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Erro ao reproduzir áudio';
      setTtsError(`${TTS_ERROR_PREFIX} ${msg}`);
      stopSpeaking();
      if (voiceMode) queueNextVoiceTurn();
    } finally {
      setTtsLoadingIndex(null);
    }
  };

  const startVoiceCapture = () => {
    if (!speechApi) {
      setVoiceError('Seu navegador não suporta captura de voz no chat.');
      return;
    }

    setVoiceError('');
    setTtsError('');
    try {
      recognitionRef.current?.stop();
      const recognition = new speechApi();
      recognitionRef.current = recognition;
      recognition.lang = 'pt-BR';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => setVoiceListening(true);
      recognition.onend = () => setVoiceListening(false);
      recognition.onerror = (event) => {
        setVoiceListening(false);
        if (event.error === 'not-allowed') {
          setVoiceError('Microfone bloqueado. Permita o acesso para usar voz no chat.');
          return;
        }
        setVoiceError('Não consegui captar sua voz. Tente novamente.');
      };
      recognition.onresult = (event) => {
        const text = event.results[0]?.[0]?.transcript?.trim() ?? '';
        if (!text) {
          setVoiceError('Não consegui entender o áudio.');
          return;
        }
        setInput(text);
        void send(text);
      };
      recognition.start();
    } catch {
      setVoiceListening(false);
      setVoiceError('Falha ao iniciar o microfone neste dispositivo.');
    }
  };

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || loading) return;
    const userMsg: ChatMessage = { role: 'user', content };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setLoading(true);
    setVoiceError('');
    setTtsError('');
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
      const lower = msg.toLowerCase();
      const isRateLimit = lower.includes('limite de uso') || lower.includes('rate limit');
      const isNotConfigured = lower.includes('não configurado') || lower.includes('nao configurado');
      let content: string;
      if (isRateLimit) {
        content = '⏳ O limite de uso da IA foi atingido. Tente novamente em alguns minutos.';
      } else if (isNotConfigured) {
        content = 'O agente ainda não está configurado neste ambiente.';
      } else {
        content = `Ops, não consegui responder agora. (${msg})`;
      }
      setMessages((prev) => [...prev, { role: 'assistant', content }]);
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
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setVoiceMode((v) => !v);
                  setVoiceError('');
                }}
                disabled={!voiceSupported}
                className={`rounded px-2 py-1 text-[10px] border ${
                  voiceMode ? 'border-white/50 bg-white/20' : 'border-white/20 bg-transparent'
                } disabled:opacity-50`}
              >
                Modo voz: {voiceMode ? 'on' : 'off'}
              </button>
              <button
                type="button"
                onClick={() => setAutoSpeak((v) => !v)}
                className={`rounded px-2 py-1 text-[10px] border ${
                  autoSpeak ? 'border-white/50 bg-white/20' : 'border-white/20 bg-transparent'
                }`}
              >
                Voz auto: {autoSpeak ? 'on' : 'off'}
              </button>
              <button type="button" onClick={() => setOpen(false)} aria-label="Fechar" className="p-1 rounded hover:bg-white/10">
                <X className="w-4 h-4" />
              </button>
            </div>
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
                  {m.role === 'assistant' && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => speak(i, m.content)}
                        disabled={ttsLoadingIndex === i}
                        className="inline-flex items-center gap-1 rounded-full border border-darc-linen px-2 py-0.5 text-[10px] text-darc-velvet/80 hover:bg-darc-linen/30 disabled:opacity-60"
                      >
                        {speakingIndex === i ? <Square className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                        {ttsLoadingIndex === i ? 'Gerando áudio...' : speakingIndex === i ? 'Parar' : 'Ouvir'}
                      </button>
                    </div>
                  )}
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
            {voiceError && (
              <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                {voiceError}
              </div>
            )}
            {ttsError && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {ttsError}
              </div>
            )}
            {voiceMode && (
              <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                Conversa por voz ativa: após a resposta, o microfone reabre automaticamente.
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
              type="button"
              onClick={startVoiceCapture}
              disabled={!voiceSupported || voiceListening || loading}
              aria-label="Falar com o copiloto"
              className="p-2 rounded-full border border-darc-linen text-darc-velvet disabled:opacity-40 hover:bg-darc-linen/40 transition-colors"
            >
              <Mic className="w-4 h-4" />
            </button>
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
