import { BadRequestException } from '@nestjs/common';
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
});
