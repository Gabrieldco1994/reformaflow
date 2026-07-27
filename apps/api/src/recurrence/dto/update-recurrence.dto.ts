import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class UpdateRecurrenceDto {
  @ApiPropertyOptional({ description: 'Novo valor (reais) das ocorrências futuras' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  valor?: number;

  @ApiPropertyOptional({ description: 'Novo tipo de despesa das ocorrências futuras' })
  @IsOptional()
  @IsString()
  tipoDespesa?: string;
}
