import { IsString, IsEmail, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateTenantDto {
  @ApiProperty({ example: 'Reforma Casa Gabriel' })
  @IsString()
  @MinLength(3)
  name!: string;

  @ApiProperty({ example: 'gabriel@email.com' })
  @IsEmail()
  ownerEmail!: string;

  @ApiProperty({ example: 'Gabriel Barbosa' })
  @IsString()
  @MinLength(2)
  ownerName!: string;
}
