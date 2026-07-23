import { IsString, IsNumber, IsDateString, IsIn, Min, IsOptional, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReceiptType } from '@reformaflow/domain';

export class CreateReceiptDto {
  @ApiProperty({ example: 50000.0, description: 'Valor em reais' })
  @IsNumber()
  @Min(0.01)
  valor!: number;

  @ApiProperty({ example: '2026-05-01' })
  @IsDateString()
  data!: string;

  @ApiProperty({
    example: 'PAGAMENTO',
    enum: Object.values(ReceiptType),
  })
  @IsString()
  @IsIn(Object.values(ReceiptType))
  tipo!: string;

  @ApiProperty({ example: 'PREVISTO', enum: ['PREVISTO', 'EM_CAIXA'] })
  @IsString()
  @IsIn(['PREVISTO', 'EM_CAIXA'])
  status!: string;

  @ApiPropertyOptional({ example: 'Salário Empresa X', description: 'Descrição livre do crédito' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  descricao?: string;

  @ApiPropertyOptional({ example: '1234', description: 'Últimos 4 dígitos da conta a associar' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}$/, { message: 'bankLast4 deve ter exatamente 4 dígitos numéricos' })
  bankLast4?: string;
}
