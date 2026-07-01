'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, Send, X, Sparkles, Volume2, Square, Mic, AudioLines } from 'lucide-react';
import { streamSpeak, isStreamingTtsSupported, type StreamTtsHandle } from '@/lib/streaming-tts';
import { useCopilotStore } from '@/stores/copilot-store';
import { useFinancialAgent } from './useFinancialAgent';
import { useSpeechRecognition } from './useSpeechRecognition';
import { VoiceAssistantOverlay } from './VoiceAssistantOverlay';

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

const SUGGESTIONS = [
  'Quanto tenho em caixa?',
  'O que vence nos próximos 7 dias?',
  'Onde estou gastando mais?',
];

const TTS_ERROR_PREFIX = 'Não consegui gerar áudio agora.';

export function FinancialAgentWidget() {
  const agent = useFinancialAgent();
  const speech = useSpeechRecognition();

  const open = useCopilotStore((s) => s.open);
  const setOpen = useCopilotStore((s) => s.setOpen);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [input, setInput] = useState('');
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [ttsError, setTtsError] = useState('');
  const [voiceError, setVoiceError] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const ttsHandleRef = useRef<StreamTtsHandle | null>(null);
  const ttsSupported = isStreamingTtsSupported();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [agent.messages, agent.loading]);

  useEffect(() => {
    return () => {
      ttsHandleRef.current?.stop();
      ttsHandleRef.current = null;
    };
  }, []);

  const stopSpeaking = () => {
    ttsHandleRef.current?.stop();
    ttsHandleRef.current = null;
    setSpeakingIndex(null);
  };

  const speakMessage = (index: number, text: string) => {
    if (!text.trim()) return;
    if (speakingIndex === index) {
      stopSpeaking();
      return;
    }
    setTtsError('');
    stopSpeaking();
    setSpeakingIndex(index);
    ttsHandleRef.current = streamSpeak({
      text,
      maxSeconds: 90,
      onEnd: () => {
        ttsHandleRef.current = null;
        setSpeakingIndex((curr) => (curr === index ? null : curr));
      },
      onError: (error) => {
        ttsHandleRef.current = null;
        setSpeakingIndex((curr) => (curr === index ? null : curr));
        setTtsError(`${TTS_ERROR_PREFIX} ${error.message}`);
      },
    });
  };

  const submit = (text: string) => {
    const content = text.trim();
    if (!content || agent.loading) return;
    setInput('');
    setVoiceError('');
    void agent.send(content);
  };

  // Experiência 1: microfone no chat → transcreve e envia. A resposta é só texto.
  const captureVoice = () => {
    setVoiceError('');
    setTtsError('');
    speech.start({
      onResult: (text) => {
        setInput(text);
        submit(text);
      },
      onError: (message) => setVoiceError(message),
    });
  };

  return (
    <>
      {/* FAB */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Abrir Copiloto Financeiro"
          className="hidden md:flex fixed bottom-20 right-4 md:bottom-6 md:right-6 z-40 items-center gap-2 rounded-full bg-darc-velvet text-white shadow-lg px-4 py-3 hover:opacity-90 transition-opacity"
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
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setVoiceOpen(true)}
                disabled={!speech.supported}
                aria-label="Abrir conversa por voz"
                title="Conversar por voz"
                className="inline-flex items-center gap-1 rounded-full border border-white/20 hover:bg-white/15 px-2.5 py-1 text-[11px] disabled:opacity-40 transition-colors"
              >
                <AudioLines className="w-3.5 h-3.5" />
                Voz
              </button>
              <button type="button" onClick={() => setOpen(false)} aria-label="Fechar" className="p-1 rounded hover:bg-white/10">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Mensagens */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 bg-darc-linen/20">
            {agent.messages.length === 0 && (
              <div className="text-center text-sm text-darc-velvet/60 mt-6 space-y-3">
                <p>👋 Sou seu copiloto financeiro. Pergunte algo:</p>
                <div className="flex flex-col gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => submit(s)}
                      className="text-xs rounded-lg border border-darc-linen bg-white px-3 py-2 hover:border-darc-velvet/40 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {agent.messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'bg-darc-velvet text-white rounded-br-sm'
                      : 'bg-white border border-darc-linen text-darc-velvet rounded-bl-sm'
                  }`}
                >
                  {m.content}
                  {m.role === 'assistant' && ttsSupported && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => speakMessage(i, m.content)}
                        className="inline-flex items-center gap-1 rounded-full border border-darc-linen px-2 py-0.5 text-[10px] text-darc-velvet/80 hover:bg-darc-linen/30"
                      >
                        {speakingIndex === i ? <Square className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                        {speakingIndex === i ? 'Parar' : 'Ouvir'}
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

            {agent.loading && (
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
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
            className="flex items-center gap-2 p-2 border-t border-darc-linen bg-white"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={speech.listening ? 'Ouvindo…' : 'Pergunte sobre suas finanças...'}
              className="flex-1 text-sm border border-darc-linen rounded-full px-3 py-2 focus:outline-none focus:ring-1 focus:ring-darc-velvet/30"
              disabled={agent.loading}
            />
            <button
              type="button"
              onClick={captureVoice}
              disabled={!speech.supported || speech.listening || agent.loading}
              aria-label="Falar com o copiloto"
              className={`p-2 rounded-full border text-darc-velvet disabled:opacity-40 transition-colors ${
                speech.listening ? 'border-darc-pink bg-darc-pink/10 animate-pulse' : 'border-darc-linen hover:bg-darc-linen/40'
              }`}
            >
              <Mic className="w-4 h-4" />
            </button>
            <button
              type="submit"
              disabled={agent.loading || !input.trim()}
              aria-label="Enviar"
              className="p-2 rounded-full bg-darc-velvet text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}

      {/* Experiência 2: tela 100% voz */}
      {voiceOpen && <VoiceAssistantOverlay send={agent.send} onClose={() => setVoiceOpen(false)} />}
    </>
  );
}
