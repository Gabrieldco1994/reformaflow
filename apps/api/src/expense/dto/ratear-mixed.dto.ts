import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { ExpenseStatus } from '@reformaflow/domain';

/**
 * Alvo NOVO: criado na hora, no projeto-destino, e imediatamente rateado.
 * `valor` é em REAIS (como CreateExpenseDto) — o valorTotal (imutável) do alvo
 * = valor * quantidade. `allocation` é em CENTAVOS (parte da compra-fonte que
 * este alvo recebe), independente do valorTotal planejado do alvo.
 */
export class NewTargetDto {
  @ApiProperty({ description: 'Projeto destino do alvo novo (outro projeto do tenant, com módulo expenses)' })
  @IsString()
  targetProjectId!: string;

  @ApiProperty({ description: 'Tipo da despesa (enum ExpenseType)' })
  @IsString()
  tipoDespesa!: string;

  @ApiProperty({ example: 150.5, description: 'Valor unitário em reais (valorTotal = valor * quantidade)' })
  @IsNumber()
  @Min(0.01)
  valor!: number;

  @ApiPropertyOptional({ example: 1, description: 'Quantidade (default 1)' })
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
  categoriaMaoDeObra?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  roomId?: string;

  @ApiPropertyOptional({ enum: ['A_VISTA', 'PARCELADO', 'QUINZENAL', 'PIX', 'PAGAMENTO_CONTA'], description: 'Forma de pagamento do alvo (default A_VISTA)' })
  @IsOptional()
  @IsString()
  @IsIn(['A_VISTA', 'PARCELADO', 'QUINZENAL', 'PIX', 'PAGAMENTO_CONTA'])
  formaPagamento?: string;

  @ApiPropertyOptional({ enum: Object.values(ExpenseStatus), description: 'Status do alvo; se ausente, herda o status da FONTE' })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(ExpenseStatus))
  status?: string;

  @ApiProperty({ description: 'Valor alocado a este alvo, em centavos (parte da compra-fonte)' })
  @IsInt()
  @Min(1)
  allocation!: number;
}

/** Alvo EXISTENTE: apenas referenciado por id, recebe uma alocação. */
export class ExistingTargetDto {
  @ApiProperty({ description: 'ID da despesa planejada (alvo) existente' })
  @IsString()
  targetExpenseId!: string;

  @ApiProperty({ description: 'Valor alocado a este alvo, em centavos' })
  @IsInt()
  @Min(1)
  allocation!: number;
}

export class RatearMixedDto {
  @ApiProperty({ type: [NewTargetDto], description: 'Alvos novos a criar e ratear (pode ser vazio)' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NewTargetDto)
  newTargets!: NewTargetDto[];

  @ApiProperty({ type: [ExistingTargetDto], description: 'Alvos existentes a ratear (pode ser vazio)' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExistingTargetDto)
  existing!: ExistingTargetDto[];
}
