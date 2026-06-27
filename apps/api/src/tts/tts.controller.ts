import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { SynthesizeTtsDto } from './dto/synthesize-tts.dto';
import { TtsService } from './tts.service';

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
}
