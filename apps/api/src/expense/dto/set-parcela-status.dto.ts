import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, Min } from 'class-validator';

export class SetParcelaStatusDto {
  @ApiProperty({ description: 'Índice 0-based da parcela' })
  @IsInt()
  @Min(0)
  parcela!: number;

  @ApiProperty({ description: 'true = paga, false = planejada' })
  @IsBoolean()
  paid!: boolean;
}
