import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { TtsController } from './tts.controller';
import { TtsService } from './tts.service';

describe('TtsController', () => {
  it('retorna audio/wav no endpoint de síntese', async () => {
    const service = {
      synthesize: jest.fn().mockResolvedValue({
        audio: Buffer.from('WAV'),
        mimeType: 'audio/wav',
      }),
    } as unknown as TtsService;

    const controller = new TtsController(service);
    const res = {
      setHeader: jest.fn(),
      send: jest.fn(),
    } as any;

    await controller.synthesize({ text: 'oi' }, res);

    expect(service.synthesize).toHaveBeenCalledWith({ text: 'oi' });
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'audio/wav');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('WAV'));
  });

  it('rejeita texto vazio', async () => {
    const service = {
      synthesize: jest.fn(),
    } as unknown as TtsService;
    const controller = new TtsController(service);

    await expect(controller.synthesize({ text: '   ' }, {} as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('stream escreve PCM e finaliza a resposta', async () => {
    let captured: any = null;
    const service = {
      streamSynthesize: jest.fn((_dto, handlers) => {
        captured = handlers;
        return { cancel: jest.fn() };
      }),
    } as unknown as TtsService;

    const controller = new TtsController(service);
    const res = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      json: jest.fn(),
      on: jest.fn(),
      flushHeaders: jest.fn(),
      writableEnded: false,
    } as any;

    await controller.stream({ text: 'oi' }, res);

    captured.onChunk(Buffer.from([0x01, 0x02]));
    captured.onEnd();

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
    expect(res.write).toHaveBeenCalledWith(Buffer.from([0x01, 0x02]));
    expect(res.end).toHaveBeenCalled();
  });

  it('stream rejeita texto vazio', async () => {
    const service = { streamSynthesize: jest.fn() } as unknown as TtsService;
    const controller = new TtsController(service);

    await expect(controller.stream({ text: '   ' }, {} as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('stream responde erro JSON quando falha antes do primeiro chunk', async () => {
    let captured: any = null;
    const service = {
      streamSynthesize: jest.fn((_dto, handlers) => {
        captured = handlers;
        return { cancel: jest.fn() };
      }),
    } as unknown as TtsService;

    const controller = new TtsController(service);
    const res = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      json: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
    } as any;

    await controller.stream({ text: 'oi' }, res);
    captured.onError(new ServiceUnavailableException('ocupado'));

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalled();
  });
});
