import { IsString, IsNumber, IsDateString, IsIn, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

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
    enum: ['PAGAMENTO', 'BONUS', 'VENDA_ACAO', 'ORCAMENTO_INICIAL'],
  })
  @IsString()
  @IsIn(['PAGAMENTO', 'BONUS', 'VENDA_ACAO', 'ORCAMENTO_INICIAL'])
  tipo!: string;

  @ApiProperty({ example: 'PREVISTO', enum: ['PREVISTO', 'EM_CAIXA'] })
  @IsString()
  @IsIn(['PREVISTO', 'EM_CAIXA'])
  status!: string;
}
