import { useCallback, useEffect, useRef, useState } from "react";

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
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
  const ownershipRef = useRef<symbol | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
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
      callbacks.onError?.("Seu navegador não suporta captura de voz.");
      return;
    }

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new ctor();
    } catch {
      callbacks.onError?.("Falha ao iniciar o microfone neste dispositivo.");
      return;
    }

    const previousRecognition = recognitionRef.current;
    const ownership = Symbol("speech-recognition");
    ownershipRef.current = ownership;
    recognitionRef.current = recognition;
    setListening(false);

    try {
      previousRecognition?.abort();
    } catch {
      // sem instância anterior
    }

    const ownsRecognition = () => ownershipRef.current === ownership;
    try {
      recognition.lang = "pt-BR";
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.continuous = false;
      recognition.onstart = () => {
        if (!ownsRecognition()) return;
        setListening(true);
      };
      recognition.onend = () => {
        if (!ownsRecognition()) return;
        ownershipRef.current = null;
        recognitionRef.current = null;
        setListening(false);
      };
      recognition.onerror = (event) => {
        if (!ownsRecognition()) return;
        ownershipRef.current = null;
        recognitionRef.current = null;
        setListening(false);
        if (event.error === "no-speech") {
          callbacks.onError?.("Não captei sua voz. Tente novamente.");
          return;
        }
        if (event.error === "not-allowed") {
          callbacks.onError?.(
            "Microfone bloqueado. Permita o acesso para usar voz.",
          );
          return;
        }
        if (event.error === "aborted") return;
        callbacks.onError?.("Não consegui captar sua voz. Tente novamente.");
      };
      recognition.onresult = (event) => {
        if (!ownsRecognition()) return;
        const text = event.results[0]?.[0]?.transcript?.trim() ?? "";
        if (!text) {
          callbacks.onError?.("Não consegui entender o áudio.");
          return;
        }
        callbacks.onResult(text);
      };
      recognition.start();
    } catch {
      if (!ownsRecognition()) return;
      ownershipRef.current = null;
      recognitionRef.current = null;
      setListening(false);
      try {
        recognition.abort();
      } catch {
        // no-op
      }
      callbacks.onError?.("Falha ao iniciar o microfone neste dispositivo.");
    }
  }, []);

  useEffect(() => {
    return () => {
      const recognition = recognitionRef.current;
      ownershipRef.current = null;
      recognitionRef.current = null;
      try {
        recognition?.abort();
      } catch {
        // no-op
      }
    };
  }, []);

  return { supported, listening, start, stop };
}
