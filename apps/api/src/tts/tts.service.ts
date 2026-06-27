import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import WebSocket, { type RawData } from 'ws';
import { SynthesizeTtsDto } from './dto/synthesize-tts.dto';

interface TtsAudioResult {
  audio: Buffer;
  mimeType: 'audio/wav';
}

type VibeSocketLike = {
  once(event: 'open', cb: () => void): void;
  once(event: 'error', cb: (error: Error) => void): void;
  once(event: 'close', cb: (code: number) => void): void;
  on(event: 'message', cb: (data: RawData, isBinary: boolean) => void): void;
  close(): void;
  terminate(): void;
};

const VIBEVOICE_SAMPLE_RATE = 24_000;
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
    const maxSeconds = this.normalizeMaxSeconds(dto.maxSeconds);
    const text = this.prepareTextForSpeech(dto.text.trim(), maxSeconds);
    const wsUrl = this.buildStreamUrl(text, dto);

    return new Promise<TtsAudioResult>((resolve, reject) => {
      let settled = false;
      const pcmChunks: Buffer[] = [];
      const socket = this.createSocket(wsUrl);

      const timeout = setTimeout(() => {
        socket.terminate();
        finishWithError(
          new ServiceUnavailableException(
            'Timeout ao sintetizar áudio com VibeVoice. Verifique o servidor TTS.',
          ),
        );
      }, this.timeoutMs);

      const finishWithError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      const finishWithSuccess = () => {
        if (settled) return;
        const pcm = Buffer.concat(pcmChunks);
        if (pcm.length === 0) {
          finishWithError(
            new ServiceUnavailableException(
              'VibeVoice não retornou áudio. Verifique se há voz/preset compatível para PT-BR.',
            ),
          );
          return;
        }

        settled = true;
        clearTimeout(timeout);

        resolve({
          audio: this.pcm16ToWav(pcm),
          mimeType: 'audio/wav',
        });
      };

      socket.once('open', () => {
        this.logger.debug(`Conectado ao VibeVoice: ${wsUrl}`);
      });

      socket.on('message', (data, isBinary) => {
        if (!isBinary) return;
        if (Buffer.isBuffer(data)) {
          pcmChunks.push(data);
          return;
        }
        if (Array.isArray(data)) {
          pcmChunks.push(Buffer.concat(data));
          return;
        }
        pcmChunks.push(Buffer.from(data));
      });

      socket.once('error', (error) => {
        this.logger.error(`Erro websocket VibeVoice: ${error.message}`);
        finishWithError(
          new ServiceUnavailableException(
            `Falha ao conectar no VibeVoice (${this.wsUrl}). Detalhe: ${error.message}`,
          ),
        );
      });

      socket.once('close', () => {
        finishWithSuccess();
      });
    });
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
    const normalized = text
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

export type { TtsAudioResult };
