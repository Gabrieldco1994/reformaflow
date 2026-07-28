import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { ProjectType } from '@reformaflow/domain';

/**
 * Shape crua de UM gatilho. Igual ao passo (ver `JourneyStepInputDto`), a
 * validação semântica pesada (coerência `triggerType` × `screenKey`/
 * `actionKey`, catálogo de telas/ações seguras, existência do
 * `targetProjectId`) mora no `JourneysAdminService` — aqui só garantimos o
 * formato básico de cada campo quando presente.
 */
export class JourneyTriggerInputDto {
  @IsOptional()
  @IsString()
  triggerType?: string;

  @IsOptional()
  @IsIn(Object.values(ProjectType))
  targetProjectType?: ProjectType | null;

  @IsOptional()
  @IsString()
  targetProjectId?: string | null;

  @IsOptional()
  @IsBoolean()
  crossProject?: boolean;

  @IsOptional()
  @IsString()
  screenKey?: string | null;

  @IsOptional()
  @IsString()
  actionKey?: string | null;

  @IsOptional()
  @IsString()
  device?: string;

  @IsOptional()
  @IsString()
  repeatPolicy?: string;

  @IsOptional()
  @IsString()
  dismissPolicy?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
