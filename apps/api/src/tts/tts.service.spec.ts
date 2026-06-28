import { EventEmitter } from 'events';
import { ServiceUnavailableException } from '@nestjs/common';
import { TtsService } from './tts.service';

class FakeSocket extends EventEmitter {
  close(): void {
    this.emit('close', 1000, Buffer.alloc(0));
  }

  terminate(): void {
    this.emit('close', 1006, Buffer.from('terminated'));
  }
}

class TestableTtsService extends TtsService {
  lastUrl = '';

  constructor(private readonly socketFactory: () => FakeSocket) {
    super();
  }

  protected override createSocket(url: string): FakeSocket {
    this.lastUrl = url;
    return this.socketFactory();
  }
}

describe('TtsService', () => {
  it('converte chunks PCM16 do VibeVoice em WAV', async () => {
    let socket: FakeSocket | null = null;
    const service = new TestableTtsService(() => {
      socket = new FakeSocket();
      return socket;
    });

    const promise = service.synthesize({ text: 'Olá, ReformaFlow' });
    const pcmChunk = Buffer.from([0x00, 0x00, 0xff, 0x7f]);

    process.nextTick(() => {
      socket?.emit('open');
      socket?.emit('message', JSON.stringify({ type: 'log', event: 'backend_first_chunk_sent' }), false);
      socket?.emit('message', pcmChunk, true);
      socket?.emit('close', 1000, Buffer.alloc(0));
    });

    const result = await promise;
    expect(result.mimeType).toBe('audio/wav');
    expect(result.audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(result.audio.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(result.audio.readUInt32LE(24)).toBe(24000);
    expect(result.audio.readUInt16LE(34)).toBe(16);
    expect(result.audio.readUInt32LE(40)).toBe(pcmChunk.length);
  });

  it('falha quando websocket fecha sem áudio', async () => {
    let socket: FakeSocket | null = null;
    const service = new TestableTtsService(() => {
      socket = new FakeSocket();
      return socket;
    });

    const promise = service.synthesize({ text: 'teste sem audio' });

    process.nextTick(() => {
      socket?.emit('open');
      socket?.emit('message', JSON.stringify({ type: 'log', event: 'backend_stream_complete' }), false);
      socket?.emit('close', 1000, Buffer.alloc(0));
    });

    await expect(promise).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('trunca texto para caber no limite de maxSeconds do modo voz', async () => {
    let socket: FakeSocket | null = null;
    const service = new TestableTtsService(() => {
      socket = new FakeSocket();
      return socket;
    });

    const longText = Array.from({ length: 500 }, (_, i) => `palavra${i}`).join(' ');
    const promise = service.synthesize({ text: longText, maxSeconds: 5 });

    process.nextTick(() => {
      socket?.emit('open');
      socket?.emit('message', Buffer.from([0x00, 0x00]), true);
      socket?.emit('close', 1000, Buffer.alloc(0));
    });

    await promise;
    const parsed = new URL(service.lastUrl);
    const decodedText = parsed.searchParams.get('text') ?? '';
    const wordCount = decodedText.split(' ').filter(Boolean).length;

    expect(wordCount).toBeLessThanOrEqual(14);
  });

  it('verbaliza moeda (com centavos) e remove emoji no texto enviado ao TTS', async () => {
    let socket: FakeSocket | null = null;
    const service = new TestableTtsService(() => {
      socket = new FakeSocket();
      return socket;
    });

    const promise = service.synthesize({ text: 'Maior gasto 💰 foi R$ 3.200,50 este mês.' });

    process.nextTick(() => {
      socket?.emit('open');
      socket?.emit('message', Buffer.from([0x00, 0x00]), true);
      socket?.emit('close', 1000, Buffer.alloc(0));
    });

    await promise;
    const decodedText = new URL(service.lastUrl).searchParams.get('text') ?? '';

    expect(decodedText).toContain('três mil e duzentos reais e cinquenta centavos');
    expect(decodedText).not.toContain('R$');
    expect(decodedText).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('TtsService.streamSynthesize', () => {
  it('emite chunks PCM e finaliza com onEnd quando há áudio', (done) => {
    let socket: FakeSocket | null = null;
    const service = new TestableTtsService(() => {
      socket = new FakeSocket();
      return socket;
    });

    const chunks: Buffer[] = [];
    service.streamSynthesize(
      { text: 'oi streaming' },
      {
        onChunk: (chunk) => chunks.push(chunk),
        onEnd: () => {
          expect(Buffer.concat(chunks).toString('hex')).toBe('0000ff7f');
          done();
        },
        onError: (error) => done(error),
      },
    );

    process.nextTick(() => {
      socket?.emit('open');
      socket?.emit('message', JSON.stringify({ type: 'log' }), false);
      socket?.emit('message', Buffer.from([0x00, 0x00, 0xff, 0x7f]), true);
      socket?.emit('close', 1000, Buffer.alloc(0));
    });
  });

  it('chama onError quando o socket fecha sem áudio (backend ocupado)', (done) => {
    let socket: FakeSocket | null = null;
    const service = new TestableTtsService(() => {
      socket = new FakeSocket();
      return socket;
    });

    service.streamSynthesize(
      { text: 'ocupado' },
      {
        onChunk: () => done(new Error('não deveria emitir chunk')),
        onEnd: () => done(new Error('não deveria finalizar com sucesso')),
        onError: (error) => {
          expect(error).toBeInstanceOf(ServiceUnavailableException);
          done();
        },
      },
    );

    process.nextTick(() => {
      socket?.emit('open');
      socket?.emit('close', 1013, Buffer.alloc(0));
    });
  });

  it('cancel impede callbacks após o cancelamento', (done) => {
    let socket: FakeSocket | null = null;
    const service = new TestableTtsService(() => {
      socket = new FakeSocket();
      return socket;
    });

    let called = false;
    const handle = service.streamSynthesize(
      { text: 'cancelar' },
      {
        onChunk: () => {
          called = true;
        },
        onEnd: () => {
          called = true;
        },
        onError: () => {
          called = true;
        },
      },
    );

    handle.cancel();

    process.nextTick(() => {
      socket?.emit('message', Buffer.from([0x01, 0x02]), true);
      socket?.emit('close', 1006, Buffer.alloc(0));
      setTimeout(() => {
        expect(called).toBe(false);
        done();
      }, 10);
    });
  });
});
