// Reprodução de TTS em streaming: conecta no endpoint /tts/stream (que repassa
// PCM16 24kHz do VibeVoice assim que chega) e toca os chunks incrementalmente
// via Web Audio API. Isso faz o áudio começar ~2s após a resposta, em vez de
// esperar o WAV inteiro ser gerado — reduzindo bastante a latência percebida.

const SAMPLE_RATE = 24_000;
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface StreamTtsOptions {
  text: string;
  maxSeconds?: number;
  voice?: string;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: Error) => void;
}

export interface StreamTtsHandle {
  stop: () => void;
}

type AudioContextCtor = typeof AudioContext;

let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedContext) sharedContext = new Ctor();
  if (sharedContext.state === 'suspended') void sharedContext.resume();
  return sharedContext;
}

export function isStreamingTtsSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const hasAudio = Boolean(
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext,
  );
  return hasAudio && typeof fetch === 'function' && typeof ReadableStream !== 'undefined';
}

export function streamSpeak(options: StreamTtsOptions): StreamTtsHandle {
  const ctx = getAudioContext();
  const controller = new AbortController();
  const sources = new Set<AudioBufferSourceNode>();

  let stopped = false;
  let started = false;
  let nextStartTime = 0;
  let carry: Uint8Array | null = null;
  let endTimer: ReturnType<typeof setTimeout> | null = null;

  const stopSources = () => {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // já parou
      }
    }
    sources.clear();
  };

  const finish = () => {
    if (stopped) return;
    stopped = true;
    if (endTimer) clearTimeout(endTimer);
    sources.clear();
    options.onEnd?.();
  };

  const scheduleEnd = () => {
    if (!ctx) return;
    if (endTimer) clearTimeout(endTimer);
    const remainingMs = Math.max(0, (nextStartTime - ctx.currentTime) * 1000) + 150;
    endTimer = setTimeout(finish, remainingMs);
  };

  const pushPcm = (incoming: Uint8Array) => {
    if (!ctx || stopped) return;

    let data = incoming;
    if (carry) {
      const merged = new Uint8Array(carry.length + incoming.length);
      merged.set(carry);
      merged.set(incoming, carry.length);
      data = merged;
      carry = null;
    }

    const usable = data.length - (data.length % 2);
    if (usable < data.length) carry = data.slice(usable);
    if (usable === 0) return;

    const sampleCount = usable / 2;
    const view = new DataView(data.buffer, data.byteOffset, usable);
    const buffer = ctx.createBuffer(1, sampleCount, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = view.getInt16(i * 2, true) / 32_768;
    }

    if (!started) {
      started = true;
      nextStartTime = ctx.currentTime + 0.08;
      options.onStart?.();
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(nextStartTime, ctx.currentTime);
    source.start(startAt);
    nextStartTime = startAt + buffer.duration;
    sources.add(source);
    source.onended = () => sources.delete(source);
    scheduleEnd();
  };

  const run = async () => {
    if (!ctx) {
      options.onError?.(new Error('Seu navegador não suporta reprodução de áudio em tempo real.'));
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/tts/stream`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: options.text,
          ...(options.maxSeconds ? { maxSeconds: options.maxSeconds } : {}),
          ...(options.voice ? { voice: options.voice } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
        const message = Array.isArray(payload.message)
          ? payload.message.join('; ')
          : (payload.message ?? 'Falha ao sintetizar áudio.');
        throw new Error(message);
      }

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (stopped) {
          void reader.cancel().catch(() => undefined);
          return;
        }
        if (value && value.length > 0) pushPcm(value);
      }

      if (!started) throw new Error('Nenhum áudio recebido do servidor de voz.');
      scheduleEnd();
    } catch (error) {
      if (stopped) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      stopped = true;
      if (endTimer) clearTimeout(endTimer);
      stopSources();
      options.onError?.(error instanceof Error ? error : new Error('Erro no streaming de áudio.'));
    }
  };

  void run();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      if (endTimer) clearTimeout(endTimer);
      stopSources();
    },
  };
}
