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
  constructor(private readonly socketFactory: () => FakeSocket) {
    super();
  }

  protected override createSocket(_url: string): FakeSocket {
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
});
