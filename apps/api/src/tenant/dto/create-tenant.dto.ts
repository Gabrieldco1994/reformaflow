import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateTenantDto {
  @ApiProperty({ example: 'Reforma Casa Gabriel' })
  @IsString()
  @MinLength(3)
  name!: string;

  @ApiProperty({ example: 'gabriel' })
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'Usuário deve conter apenas letras, números, ponto, hífen ou sublinhado',
  })
  ownerUsername!: string;

  @ApiProperty({ example: 'Gabriel Barbosa' })
  @IsString()
  @MinLength(2)
  ownerName!: string;
}
