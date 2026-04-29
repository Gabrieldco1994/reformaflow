import { IsOptional, IsNumber, IsString, IsBoolean, IsDateString, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateMilestoneDto {
  @ApiPropertyOptional({ example: 0.3, description: '% concluído (0 a 1)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  percentCompleted?: number;

  @ApiPropertyOptional({ example: 'PAID' })
  @IsOptional()
  @IsString()
  paymentStatus?: string;

  @ApiPropertyOptional({ example: '2026-05-15' })
  @IsOptional()
  @IsDateString()
  paymentDate?: string;

  @ApiPropertyOptional({ example: 'PIX' })
  @IsOptional()
  @IsString()
  paymentMethod?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  hasInvoice?: boolean;

  @ApiPropertyOptional({ example: 'Pagamento parcial após vistoria' })
  @IsOptional()
  @IsString()
  notes?: string;
}
