import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import WebSocket, { type RawData } from 'ws';
import { SynthesizeTtsDto } from './dto/synthesize-tts.dto';
import { stripEmoji, verbalizeCurrency } from './speech-format';

interface TtsAudioResult {
  audio: Buffer;
  mimeType: 'audio/wav';
}

interface TtsStreamHandlers {
  onChunk: (pcm: Buffer) => void;
  onEnd: () => void;
  onError: (error: Error) => void;
}

interface TtsStreamHandle {
  cancel: () => void;
}

type VibeSocketLike = {
  once(event: 'open', cb: () => void): void;
  once(event: 'error', cb: (error: Error) => void): void;
  once(event: 'close', cb: (code: number) => void): void;
  on(event: 'message', cb: (data: RawData, isBinary: boolean) => void): void;
  close(): void;
  terminate(): void;
};

export const VIBEVOICE_SAMPLE_RATE = 24_000;
const PCM_BITS = 16;
const CHANNELS = 1;
const DEFAULT_CFG = 1.5;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SECONDS = 120;
const MIN_MAX_SECONDS = 5;
const WORDS_PER_SECOND = 2.6;

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);
  private readonly wsUrl = process.env['VIBEVOICE_WS_URL'] || 'ws://127.0.0.1:3010/stream';
  private readonly defaultVoice = process.env['VIBEVOICE_DEFAULT_VOICE'] || '';
  private readonly timeoutMs = this.resolveTimeoutMs();

  async synthesize(dto: SynthesizeTtsDto): Promise<TtsAudioResult> {
    return new Promise<TtsAudioResult>((resolve, reject) => {
      const pcmChunks: Buffer[] = [];
      this.streamSynthesize(dto, {
        onChunk: (chunk) => pcmChunks.push(chunk),
        onEnd: () => {
          resolve({
            audio: this.pcm16ToWav(Buffer.concat(pcmChunks)),
            mimeType: 'audio/wav',
          });
        },
        onError: (error) => reject(error),
      });
    });
  }

  /**
   * Conecta no VibeVoice e repassa cada chunk PCM16 assim que chega, sem
   * esperar o áudio inteiro — é o que viabiliza a reprodução em tempo real
   * (menor latência percebida). Retorna um handle para cancelar (ex: cliente
   * desconectou).
   */
  streamSynthesize(dto: SynthesizeTtsDto, handlers: TtsStreamHandlers): TtsStreamHandle {
    const maxSeconds = this.normalizeMaxSeconds(dto.maxSeconds);
    const text = this.prepareTextForSpeech(dto.text.trim(), maxSeconds);
    const wsUrl = this.buildStreamUrl(text, dto);

    let settled = false;
    let receivedBytes = 0;
    const socket = this.createSocket(wsUrl);

    const timeout = setTimeout(() => {
      fail(
        new ServiceUnavailableException(
          'Timeout ao sintetizar áudio com VibeVoice. Verifique o servidor TTS.',
        ),
      );
    }, this.timeoutMs);

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.terminate();
      } catch {
        // socket já encerrado
      }
      handlers.onError(error);
    }

    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      handlers.onEnd();
    };

    socket.once('open', () => {
      this.logger.debug(`Streaming VibeVoice: ${wsUrl}`);
    });

    socket.on('message', (data, isBinary) => {
      if (settled || !isBinary) return;
      const chunk = this.toBuffer(data);
      if (chunk.length === 0) return;
      receivedBytes += chunk.length;
      handlers.onChunk(chunk);
    });

    socket.once('error', (error) => {
      this.logger.error(`Erro websocket VibeVoice: ${error.message}`);
      fail(
        new ServiceUnavailableException(
          `Falha ao conectar no VibeVoice (${this.wsUrl}). Detalhe: ${error.message}`,
        ),
      );
    });

    socket.once('close', () => {
      if (receivedBytes === 0) {
        fail(
          new ServiceUnavailableException(
            'VibeVoice não retornou áudio (servidor ocupado ou voz/preset incompatível). Tente novamente.',
          ),
        );
        return;
      }
      done();
    });

    return {
      cancel: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          socket.terminate();
        } catch {
          // socket já encerrado
        }
      },
    };
  }

  private toBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data as ArrayBuffer);
  }

  private buildStreamUrl(text: string, dto: SynthesizeTtsDto): string {
    const url = new URL(this.wsUrl);
    url.searchParams.set('text', text);
    url.searchParams.set('cfg', String(dto.cfg ?? DEFAULT_CFG));
    if (dto.steps) url.searchParams.set('steps', String(dto.steps));

    const voice = dto.voice?.trim() || this.defaultVoice;
    if (voice) url.searchParams.set('voice', voice);

    return url.toString();
  }

  private pcm16ToWav(pcmData: Buffer): Buffer {
    const header = Buffer.alloc(44);
    const byteRate = (VIBEVOICE_SAMPLE_RATE * CHANNELS * PCM_BITS) / 8;
    const blockAlign = (CHANNELS * PCM_BITS) / 8;

    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcmData.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(VIBEVOICE_SAMPLE_RATE, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(PCM_BITS, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcmData.length, 40);

    return Buffer.concat([header, pcmData]);
  }

  protected createSocket(url: string): VibeSocketLike {
    return new WebSocket(url);
  }

  private prepareTextForSpeech(text: string, maxSeconds: number): string {
    // Verbaliza moeda (lê centavos por extenso) e remove emojis ANTES de limpar
    // marcação, para o VibeVoice receber texto natural e falável.
    const spoken = verbalizeCurrency(stripEmoji(text));
    const normalized = spoken
      .replace(/[*_`#>\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return text;

    const maxWords = Math.max(1, Math.floor(maxSeconds * WORDS_PER_SECOND));
    const words = normalized.split(' ');
    if (words.length <= maxWords) return normalized;

    return `${words.slice(0, maxWords).join(' ')} ...`;
  }

  private normalizeMaxSeconds(value?: number): number {
    if (typeof value !== 'number' || Number.isNaN(value)) return DEFAULT_MAX_SECONDS;
    return Math.min(DEFAULT_MAX_SECONDS, Math.max(MIN_MAX_SECONDS, Math.floor(value)));
  }

  private resolveTimeoutMs(): number {
    const raw = process.env['VIBEVOICE_TIMEOUT_MS'];
    if (!raw) return DEFAULT_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
  }
}

export type { TtsAudioResult, TtsStreamHandlers, TtsStreamHandle };
