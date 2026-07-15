import { ProjectType } from '@reformaflow/domain';
import { ArrayNotEmpty, ArrayUnique, IsArray, IsEnum } from 'class-validator';

export class UpdateObjectivesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsEnum(ProjectType, { each: true })
  projectTypes!: ProjectType[];
}
