import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { JOURNEY_STEP_EXPERIENCES } from '@reformaflow/domain';
import { JOURNEY_LABEL_MAX_LENGTH, JOURNEY_SUBTITLE_MAX_LENGTH } from '../../onboarding-journey/dto/save-journey.dto';

/**
 * Shape crua de UM passo — usada tanto em `POST /admin/journeys` (todo passo
 * é novo, `label` vira obrigatório no service) quanto em
 * `PUT /admin/journeys/:id` (patch parcial por `stepKey`: campos ausentes
 * mantêm o valor já salvo — a validação exata de "o que é obrigatório
 * quando" mora no `JourneysAdminService`, não aqui, porque depende de o
 * `stepKey` já existir ou não no banco).
 */
export class JourneyStepInputDto {
  @IsString()
  stepKey!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @IsOptional()
  @IsString()
  @MaxLength(JOURNEY_LABEL_MAX_LENGTH)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(JOURNEY_SUBTITLE_MAX_LENGTH)
  subtitle?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  skippable?: boolean;

  @IsOptional()
  @IsIn(JOURNEY_STEP_EXPERIENCES)
  experience?: (typeof JOURNEY_STEP_EXPERIENCES)[number];
}
