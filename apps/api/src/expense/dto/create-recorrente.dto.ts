import { IsString, IsNumber, IsDateString, IsIn, IsOptional, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ExpenseType, LaborCategory } from '@reformaflow/domain';

/**
 * Cria uma DESPESA RECORRENTE: gera N despesas planejadas independentes (uma por
 * ocorrência) entre `dataInicio` e `dataFim`, na frequência escolhida. Cada
 * ocorrência é uma despesa À_VISTA/PLANEJADO normal — editável e contada nos KPIs.
 */
export class CreateRecorrenteDto {
  @ApiProperty({ enum: Object.values(ExpenseType) })
  @IsString()
  @IsIn(Object.values(ExpenseType))
  tipoDespesa!: string;

  @ApiPropertyOptional({ enum: Object.values(LaborCategory) })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(LaborCategory))
  categoriaMaoDeObra?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  roomId?: string;

  @ApiProperty({ example: 500.0, description: 'Valor de CADA ocorrência, em reais' })
  @IsNumber()
  @Min(0.01)
  valor!: number;

  @ApiPropertyOptional({ example: 1, description: 'Quantidade por ocorrência (default 1)' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantidade?: number;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiProperty({ enum: ['MENSAL', 'QUINZENAL'], description: 'Frequência da recorrência' })
  @IsString()
  @IsIn(['MENSAL', 'QUINZENAL'])
  frequencia!: string;

  @ApiProperty({ example: '2026-01-05', description: 'Data da primeira ocorrência (inclusive)' })
  @IsDateString()
  dataInicio!: string;

  @ApiProperty({ example: '2026-12-05', description: 'Data limite da recorrência (inclusive)' })
  @IsDateString()
  dataFim!: string;

  @ApiPropertyOptional({ description: 'Vincula todas as ocorrências a um cartão de crédito' })
  @IsOptional()
  @IsString()
  creditCardId?: string;

  @ApiPropertyOptional({ description: 'Vincula todas as ocorrências a uma conta bancária' })
  @IsOptional()
  @IsString()
  bankAccountId?: string;
}
