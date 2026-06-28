import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { SynthesizeTtsDto } from './dto/synthesize-tts.dto';
import { TtsService, VIBEVOICE_SAMPLE_RATE } from './tts.service';

@ApiTags('tts')
@ApiBearerAuth()
@Controller('tts')
export class TtsController {
  constructor(private readonly ttsService: TtsService) {}

  @Post('synthesize')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sintetiza texto em áudio WAV com VibeVoice' })
  @ApiConsumes('application/json')
  @ApiProduces('audio/wav')
  @ApiBody({ type: SynthesizeTtsDto })
  async synthesize(@Body() dto: SynthesizeTtsDto, @Res() res: Response): Promise<void> {
    if (!dto.text?.trim()) {
      throw new BadRequestException('Texto é obrigatório para síntese.');
    }

    const result = await this.ttsService.synthesize(dto);
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Cache-Control', 'no-store');
    res.send(result.audio);
  }

  @Post('stream')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sintetiza texto e transmite PCM16 em tempo real (menor latência)',
  })
  @ApiConsumes('application/json')
  @ApiProduces('application/octet-stream')
  @ApiBody({ type: SynthesizeTtsDto })
  async stream(@Body() dto: SynthesizeTtsDto, @Res() res: Response): Promise<void> {
    if (!dto.text?.trim()) {
      throw new BadRequestException('Texto é obrigatório para síntese.');
    }

    let started = false;

    const handle = this.ttsService.streamSynthesize(dto, {
      onChunk: (pcm) => {
        if (!started) {
          started = true;
          res.status(200);
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Sample-Rate', String(VIBEVOICE_SAMPLE_RATE));
          res.setHeader('X-Audio-Format', 'pcm_s16le');
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
        }
        res.write(pcm);
      },
      onEnd: () => {
        if (!res.writableEnded) res.end();
      },
      onError: (error) => {
        if (!started && !res.writableEnded) {
          const status = error instanceof HttpException ? error.getStatus() : 503;
          res.status(status).json({ message: error.message });
        } else if (!res.writableEnded) {
          res.end();
        }
      },
    });

    res.on('close', () => handle.cancel());
  }
}
