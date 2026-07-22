import { ProjectType } from '@reformaflow/domain';
import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterOwnerDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  tenantName?: string;

  @IsString()
  @MinLength(2)
  ownerName!: string;

  @IsString()
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message:
      'Usuário deve conter apenas letras, números, ponto, hífen ou sublinhado',
  })
  username?: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(ProjectType, { each: true })
  projectTypes?: ProjectType[];
}
