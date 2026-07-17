'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { useFinancialAgent } from '@/components/agent/useFinancialAgent';
import { useSpeechRecognition } from '@/components/agent/useSpeechRecognition';
import { VoiceAssistantOverlay } from '@/components/agent/VoiceAssistantOverlay';
import { streamSpeak, isStreamingTtsSupported, type StreamTtsHandle } from '@/lib/streaming-tts';
import { MobileLaunchSheetContainer } from '../_components/mobile-launch/MobileLaunchSheetContainer';
import { useMariaOpening } from './_hooks/useMariaOpening';
import { CONFIRM_REPLY } from './_lib/pending-expense';
import { MariaMessageBubble } from './_components/MariaMessageBubble';
import { MariaDock } from './_components/MariaDock';

/**
 * Tela "Maria" — copiloto financeiro em tela cheia no app mobile (protótipo
 * `docs/prototipo-mobile/app-maria.html`). Reusa `useFinancialAgent` (conversa +
 * invalidação de queries) e `useSpeechRecognition` (STT) — nenhum novo endpoint,
 * nenhum novo parser de voz/dinheiro. A abertura proativa reusa `buildMariaStories`
 * (mesmos dados do "Maria percebeu" do Hoje), renderizada localmente como a
 * primeira bolha — sem passar pelo agente/LLM (é síncrona, derivada de dados já
 * carregados pela query `monthly-overview`).
 */
export default function MariaPage() {
  const params = useParams<{ projectId: string }>();
  const agent = useFinancialAgent();
  const speech = useSpeechRecognition();
  const opening = useMariaOpening();
  const ttsSupported = isStreamingTtsSupported();

  const [input, setInput] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [confirmedIndexes, setConfirmedIndexes] = useState<Set<number>>(new Set());
  const [editSheetOpen, setEditSheetOpen] = useState(false);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [voiceConversationOpen, setVoiceConversationOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const ttsHandleRef = useRef<StreamTtsHandle | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [agent.messages, agent.loading, opening.message]);

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

  const toggleSpeak = (index: number, text: string) => {
    if (speakingIndex === index) {
      stopSpeaking();
      return;
    }
    stopSpeaking();
    setSpeakingIndex(index);
    ttsHandleRef.current = streamSpeak({
      text,
      maxSeconds: 90,
      onEnd: () => {
        ttsHandleRef.current = null;
        setSpeakingIndex((curr) => (curr === index ? null : curr));
      },
      onError: () => {
        ttsHandleRef.current = null;
        setSpeakingIndex((curr) => (curr === index ? null : curr));
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

  const captureVoice = () => {
    setVoiceError('');
    speech.start({
      onResult: (text) => {
        setInput(text);
        submit(text);
      },
      onError: (message) => setVoiceError(message),
    });
  };

  const confirmPending = (index: number) => {
    setConfirmedIndexes((prev) => new Set(prev).add(index));
    void agent.send(CONFIRM_REPLY);
  };

  return (
    <section className="pessoal-minimal-maria flex h-full min-h-[calc(100dvh-9rem)] flex-col">
      <header className="pessoal-minimal-page-header flex items-center gap-3 rounded-2xl border border-lifeone-hairline bg-white px-4 py-3 shadow-lifeone-card">
        <Link
          href={`/projects/${params.projectId}/monthly`}
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-lifeone-hairline bg-lifeone-surface text-lifeone-ink-2"
          aria-label="Voltar para hoje"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-lifeone-ink text-white">
          <Sparkles className="h-5 w-5" />
          <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-lifeone-ink">Maria</h1>
          <p className="text-[12px] font-semibold text-lifeone-ink-3">sabe do seu mês inteiro · fala e ouve</p>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto overflow-x-visible px-1 py-4">
        {opening.message && (
          <div className="minimal-chat-bubble max-w-[86%] rounded-[18px] rounded-bl-md border border-lifeone-hairline bg-white px-4 py-3 text-[15px] leading-6 text-lifeone-ink-2 shadow-lifeone-card">
            {opening.message}
          </div>
        )}

        {agent.messages.map((message, index) => {
          const precedingUserText =
            message.role === 'assistant' ? (agent.messages[index - 1]?.content ?? '') : '';
          return (
            <MariaMessageBubble
              key={index}
              message={message}
              index={index}
              precedingUserText={precedingUserText}
              confirmed={confirmedIndexes.has(index)}
              onConfirm={() => confirmPending(index)}
              onEdit={() => setEditSheetOpen(true)}
              speaking={speakingIndex === index}
              ttsSupported={ttsSupported}
              onToggleSpeak={() => toggleSpeak(index, message.content)}
            />
          );
        })}

        {agent.loading && (
          <div className="minimal-chat-bubble flex w-fit items-center gap-1 rounded-[18px] rounded-bl-md border border-lifeone-hairline bg-white px-4 py-3">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-lifeone-ink-3" style={{ animationDelay: '0ms' }} />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-lifeone-ink-3" style={{ animationDelay: '120ms' }} />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-lifeone-ink-3" style={{ animationDelay: '240ms' }} />
          </div>
        )}

        {voiceError && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] font-medium text-amber-800">
            {voiceError}
          </div>
        )}
      </div>

      <MariaDock
        input={input}
        onInputChange={setInput}
        onSubmit={submit}
        onMic={captureVoice}
        listening={speech.listening}
        micSupported={speech.supported}
        disabled={agent.loading}
        onOpenVoiceConversation={() => setVoiceConversationOpen(true)}
      />

      {/*
        Experiência 100% voz: reusa `agent.send` (mesma instância de
        useFinancialAgent da tela, sem duplicar STT/TTS). `autoStart` inicia a
        captura já a partir do gesto de clique do CTA — o microfone one-shot
        (`captureVoice`) e o botão "Ouvir" de cada resposta seguem disponíveis
        como fallback quando o overlay está fechado.
      */}
      {voiceConversationOpen && (
        <VoiceAssistantOverlay
          autoStart
          send={agent.send}
          onClose={() => setVoiceConversationOpen(false)}
        />
      )}

      {/*
        "Editar" no cartão de conferência: o agente não devolve um payload
        estruturado (só texto livre), então não é seguro pré-preencher o sheet
        com os campos extraídos sem um parser novo — o que o brief proíbe
        (nenhum parser de valor novo no front). Abrimos o sheet vazio; o usuário
        digita de novo. Limitação documentada aqui, não escondida.
      */}
      <MobileLaunchSheetContainer
        projectId={params.projectId as string}
        open={editSheetOpen}
        onClose={() => setEditSheetOpen(false)}
      />
    </section>
  );
}
