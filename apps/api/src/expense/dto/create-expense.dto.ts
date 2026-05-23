import { IsString, IsNumber, IsDateString, IsIn, IsOptional, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ExpenseType } from '@reformaflow/domain';

export class CreateExpenseDto {
  @ApiProperty({ enum: Object.values(ExpenseType) })
  @IsString()
  @IsIn(Object.values(ExpenseType))
  tipoDespesa!: string;

  @ApiPropertyOptional({ enum: ['EMPREITEIRO', 'INSTALADOR_PISO', 'INSTALADOR_MARMORE', 'PINTOR', 'ELETRICISTA', 'VIDRACEIRO', 'SERRALHEIRO', 'MARCENEIRO'] })
  @IsOptional()
  @IsString()
  @IsIn(['EMPREITEIRO', 'INSTALADOR_PISO', 'INSTALADOR_MARMORE', 'PINTOR', 'ELETRICISTA', 'VIDRACEIRO', 'SERRALHEIRO', 'MARCENEIRO'])
  categoriaMaoDeObra?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  roomId?: string;

  @ApiProperty({ example: 150.50, description: 'Valor unitário em reais' })
  @IsNumber()
  @Min(0.01)
  valor!: number;

  @ApiProperty({ example: 2 })
  @IsNumber()
  @Min(1)
  quantidade!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  titulo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fornecedor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  link?: string;

  @ApiPropertyOptional({ description: 'URL direta da imagem do produto (override manual)' })
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiProperty({ enum: ['A_VISTA', 'PARCELADO', 'QUINZENAL'] })
  @IsString()
  @IsIn(['A_VISTA', 'PARCELADO', 'QUINZENAL'])
  formaPagamento!: string;

  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsDateString()
  dataPagamento?: string;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantidadeParcela?: number;

  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsDateString()
  dataInicioParcela?: string;

  @ApiProperty({ enum: ['PLANEJADO', 'PAGO'] })
  @IsString()
  @IsIn(['PLANEJADO', 'PAGO'])
  status!: string;
}
