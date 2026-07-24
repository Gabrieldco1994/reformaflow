'use client';

import { useEffect, useRef, useState } from 'react';
import { useFinancialAgent } from '@/components/agent/useFinancialAgent';
import { useSpeechRecognition } from '@/components/agent/useSpeechRecognition';
import { VoiceAssistantOverlay } from '@/components/agent/VoiceAssistantOverlay';
import { streamSpeak, isStreamingTtsSupported, type StreamTtsHandle } from '@/lib/streaming-tts';
import { MobileLaunchSheetContainer } from '../../_components/mobile-launch/MobileLaunchSheetContainer';
import { useMariaOpening } from '../_hooks/useMariaOpening';
import { CONFIRM_REPLY } from '../_lib/pending-expense';
import { consumePendingMariaPrompt } from '../_lib/pending-prompt';
import { MariaMessageBubble } from './MariaMessageBubble';
import { MariaDock } from './MariaDock';

/**
 * Corpo da conversa com a Maria (mensagens + dock + voz + sheet de edição) —
 * extraído de `maria/page.tsx` para ser reusado tanto na tela cheia do app
 * quanto embutido no passo final do onboarding (`MariaInsightStep`), que
 * precisa manter a jornada (progress dots, "Concluir") em vez de navegar
 * para fora do wizard. Requer `ProjectProvider` no ancestral (useMariaOpening
 * usa `useProject()`).
 */
export function MariaChatBody({ projectId }: { projectId: string }) {
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
  const voiceConversationOpenRef = useRef(false);
  const pendingPromptSentRef = useRef(false);

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

  // Ponte do onboarding: se um passo anterior gravou um prompt pré-formatado,
  // consome (destrutivo → envio único) e dispara UMA vez na montagem. O ref
  // trava o double-invoke do StrictMode; o consumo destrutivo trava o refresh.
  useEffect(() => {
    if (pendingPromptSentRef.current) return;
    pendingPromptSentRef.current = true;
    const pending = consumePendingMariaPrompt();
    if (pending) {
      submit(pending);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const captureVoice = () => {
    setVoiceError('');
    speech.start({
      onResult: (text) => {
        if (voiceConversationOpenRef.current) return;
        setInput(text);
        submit(text);
      },
      onError: (message) => setVoiceError(message),
    });
  };

  const openVoiceConversation = () => {
    voiceConversationOpenRef.current = true;
    speech.stop();
    stopSpeaking();
    setVoiceConversationOpen(true);
  };

  const closeVoiceConversation = () => {
    voiceConversationOpenRef.current = false;
    setVoiceConversationOpen(false);
  };

  const confirmPending = (index: number) => {
    setConfirmedIndexes((prev) => new Set(prev).add(index));
    void agent.send(CONFIRM_REPLY);
  };

  return (
    <>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-visible px-1 py-4">
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
        onOpenVoiceConversation={openVoiceConversation}
      />

      {voiceConversationOpen && (
        <VoiceAssistantOverlay
          autoStart
          send={agent.send}
          onClose={closeVoiceConversation}
        />
      )}

      <MobileLaunchSheetContainer
        projectId={projectId}
        open={editSheetOpen}
        onClose={() => setEditSheetOpen(false)}
      />
    </>
  );
}
