import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Limites de texto: a régua de progresso e o cabeçalho da tela quebram além disso. */
export const JOURNEY_LABEL_MAX_LENGTH = 60;
export const JOURNEY_SUBTITLE_MAX_LENGTH = 200;

export class JourneyStepInputDto {
  /** Chave da tela; validada contra o catálogo do tipo de projeto no service. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  stepKey!: string;

  @IsInt()
  @Min(0)
  order!: number;

  @IsBoolean()
  enabled!: boolean;

  @IsBoolean()
  skippable!: boolean;

  /** `null`/ausente = volta ao texto padrão do catálogo. */
  @IsOptional()
  @IsString()
  @MaxLength(JOURNEY_LABEL_MAX_LENGTH)
  label?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(JOURNEY_SUBTITLE_MAX_LENGTH)
  subtitle?: string | null;
}

export class SaveJourneyDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => JourneyStepInputDto)
  steps!: JourneyStepInputDto[];
}
