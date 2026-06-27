import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class SynthesizeTtsDto {
  @ApiProperty({
    description: 'Texto a ser sintetizado em voz (preferencialmente PT-BR).',
    example: 'Seu saldo hoje é de mil e quinhentos reais.',
    minLength: 1,
    maxLength: 1200,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1200)
  text!: string;

  @ApiPropertyOptional({
    description: 'Preset de voz do VibeVoice (ex: pt-BR-Marcelo_man).',
    example: 'pt-BR-Marcelo_man',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  voice?: string;

  @ApiPropertyOptional({
    description: 'CFG scale do VibeVoice.',
    default: 1.5,
    minimum: 0.1,
    maximum: 5,
  })
  @IsOptional()
  @Min(0.1)
  @Max(5)
  cfg?: number;

  @ApiPropertyOptional({
    description: 'Quantidade de passos de inferência.',
    minimum: 1,
    maximum: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  steps?: number;

  @ApiPropertyOptional({
    description: 'Duração máxima alvo do áudio em segundos (modo voz).',
    default: 120,
    minimum: 5,
    maximum: 120,
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(120)
  maxSeconds?: number;
}
