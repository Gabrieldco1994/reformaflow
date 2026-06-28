import { useCallback, useEffect, useRef, useState } from 'react';

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult:
    | ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
    | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export interface VoiceCaptureCallbacks {
  onResult: (text: string) => void;
  onError?: (message: string) => void;
}

/**
 * Captura de voz do navegador (Web Speech API). Usado tanto no chat quanto na
 * tela 100% voz. Não depende do servidor — roda no Chrome/Safari com pt-BR.
 */
export function useSpeechRecognition() {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const ctorRef = useRef<SpeechRecognitionCtor | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const win = window as Window & {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
    ctorRef.current = ctor;
    setSupported(Boolean(ctor));
  }, []);

  const stop = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // já parado
    }
  }, []);

  const start = useCallback((callbacks: VoiceCaptureCallbacks) => {
    const ctor = ctorRef.current;
    if (!ctor) {
      callbacks.onError?.('Seu navegador não suporta captura de voz.');
      return;
    }

    try {
      recognitionRef.current?.abort();
    } catch {
      // sem instância anterior
    }

    try {
      const recognition = new ctor();
      recognitionRef.current = recognition;
      recognition.lang = 'pt-BR';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.continuous = false;
      recognition.onstart = () => setListening(true);
      recognition.onend = () => setListening(false);
      recognition.onerror = (event) => {
        setListening(false);
        if (event.error === 'no-speech') {
          callbacks.onError?.('Não captei sua voz. Tente novamente.');
          return;
        }
        if (event.error === 'not-allowed') {
          callbacks.onError?.('Microfone bloqueado. Permita o acesso para usar voz.');
          return;
        }
        if (event.error === 'aborted') return;
        callbacks.onError?.('Não consegui captar sua voz. Tente novamente.');
      };
      recognition.onresult = (event) => {
        const text = event.results[0]?.[0]?.transcript?.trim() ?? '';
        if (!text) {
          callbacks.onError?.('Não consegui entender o áudio.');
          return;
        }
        callbacks.onResult(text);
      };
      recognition.start();
    } catch {
      setListening(false);
      callbacks.onError?.('Falha ao iniciar o microfone neste dispositivo.');
    }
  }, []);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        // no-op
      }
    };
  }, []);

  return { supported, listening, start, stop };
}
