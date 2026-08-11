import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsInt, Matches, Min } from 'class-validator';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class UpdateInstallmentDateDto {
  @ApiProperty({ example: 1, description: 'Índice 0-based da parcela' })
  @IsInt()
  @Min(0)
  parcela!: number;

  @ApiProperty({ example: '2026-09-20' })
  @Matches(DATE_ONLY_PATTERN)
  @IsDateString({ strict: true, strictSeparator: true })
  data!: string;
}
