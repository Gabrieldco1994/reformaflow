import { IsString, IsOptional, MinLength, IsDateString, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProjectDto {
  @ApiProperty({ example: 'Reforma Apartamento Centro' })
  @IsString()
  @MinLength(3)
  name!: string;

  @ApiProperty({ example: 'REFORMA', enum: ['REFORMA', 'COMPRA', 'CASA', 'CARRO', 'PESSOAL'] })
  @IsString()
  @IsIn(['REFORMA', 'COMPRA', 'CASA', 'CARRO', 'PESSOAL'])
  type!: string;

  @ApiPropertyOptional({ example: 'Reforma completa do apto de 80m²' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-08-30' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
