import { IsString, IsNumber, IsOptional, IsDateString, IsEnum, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

enum CashFlowTypeDto {
  INCOME = 'INCOME',
  EXPENSE = 'EXPENSE',
}

export class CreateCashFlowDto {
  @ApiProperty({ example: '2026-05-01' })
  @IsDateString()
  plannedDate!: string;

  @ApiPropertyOptional({ example: '2026-05-03' })
  @IsOptional()
  @IsDateString()
  effectiveDate?: string;

  @ApiProperty({ example: 'Pagamento empreiteiro - Sinal' })
  @IsString()
  description!: string;

  @ApiPropertyOptional({ example: 'room-id-123' })
  @IsOptional()
  @IsString()
  roomId?: string;

  @ApiPropertyOptional({ example: 'work-type-id-456' })
  @IsOptional()
  @IsString()
  workTypeId?: string;

  @ApiProperty({ enum: CashFlowTypeDto, example: 'EXPENSE' })
  @IsEnum(CashFlowTypeDto)
  type!: string;

  @ApiProperty({ example: 4000 })
  @IsNumber()
  @Min(0.01)
  amount!: number;
}
