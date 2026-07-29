import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { JourneyStepInputDto } from './journey-step-input.dto';
import { JourneyTriggerInputDto } from './journey-trigger-input.dto';

const JOURNEY_NAME_MAX_LENGTH = 120;
const JOURNEY_DESCRIPTION_MAX_LENGTH = 500;

/**
 * `PUT /admin/journeys/:id`. TODOS os campos são opcionais — ausente = "não
 * mexe nisso" (ver `JourneysAdminService.update`): `{}` é um no-op válido que
 * devolve o estado atual sem escrever nada. `steps`/`triggers`, quando
 * presentes, são um PATCH por chave natural (upsert), nunca uma substituição
 * total — passo/gatilho que já existe e não está no array continua intacto
 * (nenhuma linha é fisicamente removida nesta fase).
 */
export class UpdateJourneyDto {
  @IsOptional()
  @IsString()
  @MaxLength(JOURNEY_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(JOURNEY_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JourneyStepInputDto)
  steps?: JourneyStepInputDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JourneyTriggerInputDto)
  triggers?: JourneyTriggerInputDto[];
}
