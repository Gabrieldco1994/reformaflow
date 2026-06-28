'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, X, AudioLines, Loader2 } from 'lucide-react';
import { streamSpeak, type StreamTtsHandle } from '@/lib/streaming-tts';
import { useSpeechRecognition } from './useSpeechRecognition';
import type { ChatMessage } from './useFinancialAgent';

type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

interface VoiceAssistantOverlayProps {
  onClose: () => void;
  send: (text: string) => Promise<ChatMessage | null>;
}

const STATE_HINT: Record<VoiceState, string> = {
  idle: 'Toque para conversar',
  listening: 'Ouvindo…',
  thinking: 'Pensando…',
  speaking: 'Falando…',
  error: 'Toque para tentar de novo',
};

export function VoiceAssistantOverlay({ onClose, send }: VoiceAssistantOverlayProps) {
  const speech = useSpeechRecognition();
  const [state, setState] = useState<VoiceState>('idle');
  const [lastUser, setLastUser] = useState('');
  const [lastAssistant, setLastAssistant] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const activeRef = useRef(false);
  const ttsHandleRef = useRef<StreamTtsHandle | null>(null);

  const stopTts = () => {
    ttsHandleRef.current?.stop();
    ttsHandleRef.current = null;
  };

  function beginListening() {
    if (!speech.supported) {
      setErrorMsg('Seu navegador não suporta captura de voz.');
      setState('error');
      return;
    }
    setErrorMsg('');
    setLastAssistant('');
    setState('listening');
    speech.start({
      onResult: (text) => {
        void handleUserText(text);
      },
      onError: (message) => {
        setErrorMsg(message);
        setState(activeRef.current ? 'idle' : 'error');
      },
    });
  }

  async function handleUserText(text: string) {
    setLastUser(text);
    setState('thinking');
    const assistant = await send(text);
    if (!activeRef.current) return;
    if (!assistant) {
      setState('idle');
      return;
    }
    setLastAssistant(assistant.content);
    speakReply(assistant.content);
  }

  function speakReply(text: string) {
    setState('speaking');
    stopTts();
    ttsHandleRef.current = streamSpeak({
      text,
      maxSeconds: 120,
      onEnd: () => {
        ttsHandleRef.current = null;
        if (activeRef.current) beginListening();
        else setState('idle');
      },
      onError: (error) => {
        ttsHandleRef.current = null;
        setErrorMsg(error.message);
        if (activeRef.current) {
          setTimeout(() => {
            if (activeRef.current) beginListening();
          }, 700);
        } else {
          setState('error');
        }
      },
    });
  }

  function startConversation() {
    activeRef.current = true;
    beginListening();
  }

  function pauseConversation() {
    activeRef.current = false;
    speech.stop();
    stopTts();
    setState('idle');
  }

  function toggle() {
    if (state === 'listening' || state === 'thinking' || state === 'speaking') {
      pauseConversation();
    } else {
      startConversation();
    }
  }

  useEffect(() => {
    return () => {
      activeRef.current = false;
      speech.stop();
      ttsHandleRef.current?.stop();
      ttsHandleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClose = () => {
    pauseConversation();
    onClose();
  };

  const orbClass =
    state === 'listening'
      ? 'voice-orb voice-orb--listening'
      : state === 'speaking'
        ? 'voice-orb voice-orb--speaking'
        : state === 'thinking'
          ? 'voice-orb voice-orb--thinking'
          : 'voice-orb';

  const showRings = state === 'listening' || state === 'speaking';

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-darc-gradient-dark text-white">
      <div className="flex items-center justify-between px-5 pt-5">
        <div className="flex items-center gap-2 text-white/80">
          <AudioLines className="w-5 h-5" />
          <span className="text-sm font-medium tracking-wide">Copiloto por voz</span>
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Fechar conversa por voz"
          className="p-2 rounded-full hover:bg-white/10 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-10">
        <div className="relative flex items-center justify-center" style={{ width: '11rem', height: '11rem' }}>
          {showRings && (
            <>
              <span className={`voice-ring ${state === 'listening' ? 'voice-ring--active' : ''}`} />
              <span className={`voice-ring voice-ring--2 ${state === 'listening' ? 'voice-ring--active' : ''}`} />
            </>
          )}
          {state === 'thinking' && <span className="voice-thinking-ring" />}

          <button
            type="button"
            onClick={toggle}
            aria-label={state === 'idle' || state === 'error' ? 'Iniciar conversa por voz' : 'Pausar'}
            className={orbClass}
          >
            <span className="absolute inset-0 flex items-center justify-center text-white">
              {state === 'thinking' ? (
                <Loader2 className="w-12 h-12 animate-spin" />
              ) : state === 'speaking' ? (
                <AudioLines className="w-12 h-12" />
              ) : (
                <Mic className="w-12 h-12" />
              )}
            </span>
          </button>
        </div>

        <p className="text-base font-medium text-white/85 min-h-[1.5rem]">{STATE_HINT[state]}</p>

        <div className="w-full max-w-md space-y-3 text-center">
          {lastUser && (
            <p className="text-sm text-white/60">
              <span className="text-white/40">Você: </span>
              {lastUser}
            </p>
          )}
          {lastAssistant && (
            <p className="text-[15px] leading-relaxed text-white whitespace-pre-wrap max-h-40 overflow-y-auto scrollbar-hide">
              {lastAssistant}
            </p>
          )}
          {errorMsg && <p className="text-sm text-darc-pink-logo/90">{errorMsg}</p>}
          {!speech.supported && (
            <p className="text-xs text-white/60">
              Captura de voz indisponível neste navegador. Use o Chrome ou Safari.
            </p>
          )}
        </div>
      </div>

      <div className="pb-10 pt-2 flex flex-col items-center gap-3 safe-pb">
        <button
          type="button"
          onClick={toggle}
          disabled={!speech.supported}
          className="flex items-center gap-2 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40 px-6 py-3 text-sm font-medium backdrop-blur transition-colors"
        >
          {state === 'listening' || state === 'thinking' || state === 'speaking' ? (
            <>
              <X className="w-4 h-4" /> Pausar
            </>
          ) : (
            <>
              <Mic className="w-4 h-4" /> Falar
            </>
          )}
        </button>
        <p className="text-[11px] text-white/45">A resposta é falada em tempo real e o microfone reabre sozinho.</p>
      </div>
    </div>
  );
}
