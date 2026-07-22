import { IsString, IsEmail, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class LoginDto {
  @ValidateIf((o) => !o.email)
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'Usuário deve conter apenas letras, números, ponto, hífen ou sublinhado',
  })
  username?: string;

  @ValidateIf((o) => !o.username)
  @IsEmail()
  email?: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
