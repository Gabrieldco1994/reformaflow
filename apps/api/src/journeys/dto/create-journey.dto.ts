import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { JourneyStepInputDto } from './journey-step-input.dto';
import { JourneyTriggerInputDto } from './journey-trigger-input.dto';

const JOURNEY_NAME_MAX_LENGTH = 120;
const JOURNEY_DESCRIPTION_MAX_LENGTH = 500;

/**
 * `POST /admin/journeys`. `key` é imutável depois de criada (a chave que o
 * bootstrap/idempotência usa para achar "já existe?"); `triggers` precisa de
 * ao menos 1 entrada (uma jornada sem gatilho nunca dispara); `steps` pode
 * ser um array VAZIO (jornada só-notificação, sem etapas — issue #339).
 */
export class CreateJourneyDto {
  @IsString()
  key!: string;

  @IsString()
  @MaxLength(JOURNEY_NAME_MAX_LENGTH)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(JOURNEY_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JourneyStepInputDto)
  steps!: JourneyStepInputDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => JourneyTriggerInputDto)
  triggers!: JourneyTriggerInputDto[];
}
