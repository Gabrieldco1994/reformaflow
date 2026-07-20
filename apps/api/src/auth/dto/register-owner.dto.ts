import { ProjectType } from '@reformaflow/domain';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterOwnerDto {
  @IsString()
  @MinLength(3)
  tenantName!: string;

  @IsString()
  @MinLength(2)
  ownerName!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(40)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message:
      'Usuário deve conter apenas letras, números, ponto, hífen ou sublinhado',
  })
  username!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsEnum(ProjectType, { each: true })
  projectTypes!: ProjectType[];
}
