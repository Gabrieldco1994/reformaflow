import { IsIn, IsOptional, IsString } from 'class-validator';
import { JOURNEY_TRIGGER_DEVICES, JOURNEY_TRIGGER_TYPES, ProjectType } from '@reformaflow/domain';

/**
 * `GET /journeys/eligible` query params. Formato cru (strings da URL) —
 * `JourneysEligibilityService.getEligible` valida os enums de novo (o
 * controller repassa o objeto AS-IS, sem transformação, para casar com o
 * RED spec de #339).
 */
export class EligibleJourneyQueryDto {
  @IsIn(JOURNEY_TRIGGER_TYPES)
  triggerType!: (typeof JOURNEY_TRIGGER_TYPES)[number];

  @IsIn(JOURNEY_TRIGGER_DEVICES)
  device!: (typeof JOURNEY_TRIGGER_DEVICES)[number];

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsIn(Object.values(ProjectType))
  projectType?: ProjectType;

  @IsOptional()
  @IsString()
  screenKey?: string;

  @IsOptional()
  @IsString()
  actionKey?: string;
}
